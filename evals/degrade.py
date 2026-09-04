"""L1 -- degradation ladder.

Manufactures ground truth for the quality gate. Take a clip you know is good,
damage it by a known amount, and the label is the damage you applied. Ten clips
become several hundred labeled cases with no human annotation.

This does NOT evaluate whether the coaching gap is correct. That needs
instructor labels which do not exist yet. It evaluates the layer that decides
whether a coaching gap should be produced at all.

Score formulas are read directly out of video.py, so severities are chosen to
land on the thresholds rather than guessed:

    blur_score      = median(min(100, laplacian_var / 4))   -> 50 at var 200
    stability_score = 100 - median_optical_flow * 16        -> 50 at flow 3.125
    exposure_score  = range_score(mean_gray, 70, 205, 25, 245)

NOT YET RUN. See HANDOFF.md section 4.1: the `sampling_evasion` axis still has
an unresolved coordinate-system defect (filters are applied to the source, the
sampler reads the proxy). The index-rounding half of that defect is fixed here;
the fps/proxy half is not, and it changes the intent of the axis rather than its
syntax, so it is left for an explicit decision.

Usage:
    python -m evals.degrade --video clean.mp4 --model pose_landmarker.task
    python -m evals.degrade --video clean.mp4 --model m.task --only sampling_evasion
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Deterministic sample positions used by video.sample_visual_quality.
# Kept in sync deliberately: if the production sampler changes, this must fail.
QUALITY_SAMPLE_COUNT = 10
PROXY_FPS = 30


@dataclass(slots=True)
class Rung:
    axis: str
    severity: float
    vfilter: str
    expect: str          # "full" | "limited" | "rejected" | "any"
    note: str = ""


@dataclass(slots=True)
class Outcome:
    axis: str
    severity: float
    expect: str
    status: str
    readiness: float
    blur: float
    stability: float
    exposure: float
    hard_failures: list[str] = field(default_factory=list)
    allowed_metrics: list[str] = field(default_factory=list)
    invalid: str = ""     # non-empty means this rung measured nothing usable
    note: str = ""        # e.g. rider selection had to be pinned by hand

    @property
    def ok(self) -> bool:
        if self.invalid:
            return False
        return self.expect == "any" or self.status == self.expect


# --- ladders ----------------------------------------------------------------

def blur_ladder() -> list[Rung]:
    # gblur sigma vs Laplacian variance is content-dependent, so the ladder
    # sweeps and the report reads off where the flip actually happened.
    return [
        Rung("blur", s, f"gblur=sigma={s}", "any",
             "expect monotonic blur_score decrease; flip to limited at 50")
        for s in (0, 0.5, 1, 2, 3, 5, 8, 12)
    ]


def shake_ladder() -> list[Rung]:
    # Deterministic sinusoidal crop offset. Amplitude in source pixels; the
    # proxy downscale to 720p reduces effective flow, which is the point --
    # stability is measured post-normalization, like in production.
    # The crop must be scaled straight back to the original geometry. Cropping
    # alone makes the frame *more* elongated, and create_proxy only ever scales
    # the short side to 720 -- so a portrait clip near 16:9 gets pushed past the
    # validator's 1280 long-side bound and the rung dies with a VideoError that
    # has nothing to do with camera shake. See HANDOFF: that interaction is a
    # real create_proxy defect, not an artefact of this ladder, but the ladder
    # must not trip over it while measuring something else.
    rungs = []
    for amp in (0, 2, 4, 8, 16, 32):
        vf = (f"crop=iw-{2*32}:ih-{2*32}:"
              f"'32+{amp}*sin(n*1.7)':'32+{amp}*cos(n*2.3)',"
              f"scale=iw+{2*32}:ih+{2*32}")
        rungs.append(Rung("shake", amp, vf, "any",
                          "stability_score = 100 - median_flow*16"))
    return rungs


def rider_size_ladder(width: int, height: int) -> list[Rung]:
    # Shrink the rider inside the frame. Hard failure is bbox_height < 0.12,
    # the recapture message says 20%, and the score normalizes against 0.35.
    # Three different numbers for one concept -- this ladder shows which binds.
    #
    # Target sizes are computed here rather than as ffmpeg expressions so they
    # land on even integers (x264) and pad restores the *exact* original
    # geometry. `scale=iw*k,pad=iw/k` re-derives the frame size from a rounded
    # intermediate, and the drift is enough to change the aspect ratio and trip
    # create_proxy's long-side bound -- see shake_ladder.
    def _even(value: float) -> int:
        return max(2, int(value) // 2 * 2)

    rungs = []
    for k in (1.0, 0.7, 0.5, 0.35, 0.25, 0.15):
        w, h = _even(width * k), _even(height * k)
        vf = (f"scale={w}:{h},"
              f"pad={width}:{height}:{(width - w) // 2}:{(height - h) // 2}:black")
        expect = "rejected" if k <= 0.25 else "any"
        rungs.append(Rung("rider_size", k, vf, expect,
                          "bbox floor .12 vs message 20% vs scale ref .35"))
    return rungs


def exposure_ladder() -> list[Rung]:
    rungs = []
    for b in (-0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6):
        rungs.append(Rung("exposure", b, f"eq=brightness={b}", "any",
                          "range_score zeroes below mean 25 / above 245"))
    return rungs


def turn_count_ladder(duration: float) -> list[Rung]:
    # len(turns) < 3 is a hard reject. Trimming shortens the run.
    # NOTE: the pipeline rejects clips under 3s outright, so on a short source
    # several fracs clamp to the same duration and the axis goes inert. Rungs
    # that collapse onto an already-emitted duration are dropped rather than
    # rendered four times under four different severity labels.
    rungs: list[Rung] = []
    seen: set[str] = set()
    for frac in (1.0, 0.75, 0.5, 0.35, 0.2):
        d = max(3.05, duration * frac)
        key = f"{d:.2f}"
        if key in seen:
            continue
        seen.add(key)
        expect = "rejected" if frac <= 0.35 else "any"
        rungs.append(Rung("turn_count", frac,
                          f"trim=duration={key},setpts=PTS-STARTPTS",
                          expect, "hard reject below 3 detected turns"))
    return rungs


def sampling_evasion_ladder(indices: list[int]) -> list[Rung]:
    """Blur everything EXCEPT the frames the quality sampler happens to read.

    sample_visual_quality reads QUALITY_SAMPLE_COUNT frames at
    np.linspace(0, frame_count-1, ..., dtype=int). Those positions are fixed and
    knowable. A clip that is sharp at exactly those indices and blurred
    everywhere else should be caught -- if it is not, blur_score is measuring
    1.7% of the clip and the gate has a hole that no threshold change closes.

    Two things have to hold for this axis to mean anything, and both are now
    enforced rather than assumed:

      * the index expression must match production exactly, truncating cast
        included -- int(round(...)) moves 4 of 10 positions on a 600-frame clip,
        which blurs the frames the sampler actually reads and "confirms" the
        finding for the wrong reason (see sampler_indices);
      * frame n here must be frame n in the file the sampler opens -- see
        normalize_source, and the post-run check in evaluate().
    """
    if not indices:
        return []
    keep = "+".join(f"eq(n\\,{i})" for i in indices)
    return [
        Rung("sampling_evasion", sigma,
             f"gblur=sigma={sigma}:enable='not({keep})'",
             "rejected",
             f"sharp only at frames {indices}; the rest at sigma={sigma}")
        for sigma in (8, 16)
    ]


# --- execution --------------------------------------------------------------

def normalize_source(video: Path, work: Path) -> Path:
    """Put the clean clip through create_proxy once, up front.

    This is the fix for the coordinate-system half of the sampling_evasion
    defect. Degradation filters are applied to whatever file we hand ffmpeg,
    but sample_visual_quality reads the proxy the *pipeline* builds. If the
    source is not already CFR 30 at proxy geometry, that step resamples and
    every frame index we computed refers to a different timeline.

    Normalizing first makes the pipeline's own create_proxy near-idempotent
    (already 30 fps, already at or under the 720 bound), so frame n in the
    rendered variant is frame n in the file the sampler opens.
    """
    from snowtrace_analysis.video import create_proxy

    work.mkdir(parents=True, exist_ok=True)
    return create_proxy(video, work / "normalized.mp4")


def proxy_frame_count(path: Path) -> int:
    """Frame count the way the sampler counts it.

    sample_visual_quality uses cv2's CAP_PROP_FRAME_COUNT, not a duration x fps
    estimate. Those disagree by a frame or two often enough to shift the
    computed sample positions, which is the whole ballgame for this axis.
    """
    import cv2

    capture = cv2.VideoCapture(str(path))
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    capture.release()
    return count


def sampler_indices(frame_count: int) -> list[int]:
    """Exactly what video.sample_visual_quality will read -- same expression,
    same truncating dtype=int cast. Any divergence here silently invalidates
    the sampling_evasion result rather than failing."""
    if frame_count <= 0:
        return []
    return np.linspace(
        0, frame_count - 1, min(QUALITY_SAMPLE_COUNT, frame_count), dtype=int
    ).tolist()


def probe_duration(video: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "format=duration", "-of", "json", str(video)],
        check=True, capture_output=True, text=True,
    )
    return float(json.loads(out.stdout)["format"]["duration"])


def render(source: Path, rung: Rung, out_dir: Path) -> Path:
    dest = out_dir / f"{rung.axis}_{rung.severity}.mp4"
    subprocess.run(
        # -r / -fps_mode cfr pin the timebase so a rung cannot quietly change
        # the frame count it is not trying to change. turn_count is the one
        # axis that does alter duration, and it does so explicitly via trim.
        ["ffmpeg", "-y", "-v", "error", "-i", str(source),
         "-vf", rung.vfilter, "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", str(PROXY_FPS), "-fps_mode", "cfr",
         str(dest)],
        check=True, capture_output=True, text=True,
    )
    return dest


def evaluate(rung: Rung, clip: Path, model: Path, work: Path,
             expected_indices: list[int] | None = None, **kw) -> Outcome:
    from snowtrace_analysis.pipeline import AnalysisPipeline

    pipeline = AnalysisPipeline(model_path=model, work_dir=work)
    result = pipeline.analyze_video(clip, role="rider", **kw)

    # Degradation destabilises tracking, so heavier rungs come back
    # `needs_rider` and never reach the gate at all. That is rider-selection
    # noise masking the thing under test: without this retry the ladder
    # measures where the tracker gives up, not where the gate reacts. Retry on
    # the top-scoring candidate and record that we had to.
    note = ""
    if result.status == "needs_rider" and result.rider_candidates:
        chosen = result.rider_candidates[0]["track_id"]
        note = f"ambiguous selection; pinned to track {chosen}"
        result = pipeline.analyze_video(
            clip, role="rider", selected_track_id=chosen, **kw
        )
    q = result.quality

    # The sampling_evasion axis is only meaningful if the frames we sharpened
    # are the frames the sampler reads. normalize_source is supposed to
    # guarantee that; this checks it against the proxy the pipeline actually
    # built, so a broken assumption shows up as an invalid rung instead of a
    # confident wrong verdict.
    invalid = ""
    if result.status == "needs_rider":
        invalid = "no usable rider track after degradation"
    if expected_indices is not None:
        actual = sampler_indices(proxy_frame_count(result.proxy_path))
        if actual != expected_indices:
            invalid = (
                f"frame indices drifted: sharpened {expected_indices}, "
                f"sampler reads {actual}"
            )
    # The three capture scores are already on the gate result, keyed by check
    # id. Re-running sample_visual_quality + estimate_camera_stability here
    # would repeat the two most expensive calls in the loop and introduce a
    # second derivation that can drift from the one the gate actually used.
    scores = {c.id: c.score for c in q.checks} if q else {}
    return Outcome(
        axis=rung.axis, severity=rung.severity, expect=rung.expect,
        status=result.status if q is None else q.status,
        readiness=float(q.readiness_score) if q else 0.0,
        blur=scores.get("motion_blur", 0.0),
        stability=scores.get("stability", 0.0),
        exposure=scores.get("exposure", 0.0),
        hard_failures=list(q.hard_failures) if q else [],
        allowed_metrics=list(q.allowed_metrics) if q else [],
        invalid=invalid,
        note=note,
    )


def report(outcomes: list[Outcome]) -> str:
    lines = ["# L1 degradation ladder", ""]
    by_axis: dict[str, list[Outcome]] = {}
    for o in outcomes:
        by_axis.setdefault(o.axis, []).append(o)

    for axis, group in by_axis.items():
        group.sort(key=lambda o: o.severity)
        lines += [f"## {axis}", "",
                  "| severity | blur | stab | expo | readiness | status | expected |",
                  "|---|---|---|---|---|---|---|"]
        for o in group:
            mark = "  **INVALID**" if o.invalid else "" if o.ok else "  **MISS**"
            lines.append(
                f"| {o.severity} | {o.blur:.0f} | {o.stability:.0f} | "
                f"{o.exposure:.0f} | {o.readiness:.0f} | `{o.status}`{mark} | "
                f"{o.expect} |"
            )
        flips = [
            (b.severity, a.status, b.status)
            for a, b in zip(group, group[1:]) if a.status != b.status
        ]
        lines += ["", f"Flip points: {flips or 'none -- gate never reacted'}", ""]

    invalid = [o for o in outcomes if o.invalid]
    if invalid:
        lines += ["## Invalid rungs -- measured nothing usable", ""]
        for o in invalid:
            lines.append(f"- `{o.axis}` at {o.severity}: {o.invalid}")
        lines += ["", "An invalid rung is not a pass and not a failure. Its "
                      "verdict says nothing about the gate, and reading it as "
                      "either is how a broken harness gets mistaken for a "
                      "finding.", ""]

    misses = [o for o in outcomes if not o.ok and not o.invalid]
    lines += ["## Failures", ""]
    if misses:
        for o in misses:
            lines.append(f"- `{o.axis}` at {o.severity}: expected `{o.expect}`, "
                         f"got `{o.status}` (readiness {o.readiness:.0f})")
    else:
        lines.append("- none")
    lines += ["", "## Reconciling",
              "",
              "Each flip point above is where the gate *does* react. The",
              "hard-coded constants are where someone decided it *should*.",
              "Where they disagree, change the constant, not the ladder."]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(prog="evals.degrade", description=__doc__)
    ap.add_argument("--video", type=Path, required=True, help="a known-good clip")
    ap.add_argument("--model", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("evals/out/l1_ladder.md"))
    ap.add_argument("--only", nargs="*", help="restrict to named axes")
    ap.add_argument("--camera-mode", default="fixed")
    ap.add_argument("--stance", default="regular")
    ap.add_argument("--view-angle", default="three-quarter")
    ap.add_argument("--travel-direction", default="left-to-right")
    ap.add_argument("--first-edge", default="unknown")
    ap.add_argument("--keep", action="store_true", help="keep rendered variants")
    args = ap.parse_args()

    for exe in ("ffmpeg", "ffprobe"):
        if shutil.which(exe) is None:
            raise SystemExit(f"{exe} is required")

    kw = dict(camera_mode=args.camera_mode, stance=args.stance,
              view_angle=args.view_angle, travel_direction=args.travel_direction,
              first_edge=args.first_edge)

    tmp = Path(tempfile.mkdtemp(prefix="snowtrace-l1-"))
    outcomes: list[Outcome] = []
    try:
        # Every rung starts from the normalized clip, not the raw source, so
        # frame indices mean the same thing here and inside the gate.
        clean = normalize_source(args.video, tmp)
        frame_count = proxy_frame_count(clean)
        duration = probe_duration(clean)
        indices = sampler_indices(frame_count)
        from snowtrace_analysis.video import probe_video
        meta = probe_video(clean)
        print(f"normalized: {meta.width}x{meta.height} {meta.orientation}, "
              f"{frame_count} frames, {duration:.2f}s; "
              f"sampler reads {indices}", flush=True)

        rungs = (blur_ladder() + shake_ladder()
                 + rider_size_ladder(meta.width, meta.height)
                 + exposure_ladder() + turn_count_ladder(duration)
                 + sampling_evasion_ladder(indices))
        if args.only:
            rungs = [r for r in rungs if r.axis in args.only]

        for i, rung in enumerate(rungs, 1):
            print(f"[{i}/{len(rungs)}] {rung.axis} @ {rung.severity}", flush=True)
            clip = render(clean, rung, tmp)
            try:
                outcomes.append(evaluate(
                    rung, clip, args.model, tmp / "work",
                    expected_indices=indices if rung.axis == "sampling_evasion" else None,
                    **kw,
                ))
            # A rung that blows up must not destroy the other 33. It is
            # recorded as invalid rather than skipped silently: a rung missing
            # from the report reads as "not run", while an invalid one says
            # "run, measured nothing, here is why" -- and the why is often the
            # finding (VideoError on the shake axis was how create_proxy's
            # long-side bound surfaced).
            except Exception as e:       # noqa: BLE001 - see above
                print(f"    invalid: {type(e).__name__}: {e}", flush=True)
                outcomes.append(Outcome(
                    axis=rung.axis, severity=rung.severity, expect=rung.expect,
                    status="error", readiness=0.0, blur=0.0, stability=0.0,
                    exposure=0.0, invalid=f"{type(e).__name__}: {e}",
                ))
    finally:
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report(outcomes), encoding="utf-8")
    print(f"\nWrote {args.out}")

    misses = [o for o in outcomes if not o.ok]
    if misses:
        print(f"{len(misses)} rung(s) did not match expectation.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
