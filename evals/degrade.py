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

Rungs are rendered from the raw source and handed straight to the pipeline. The
gate samples blur and exposure from the source it is given, so the file this
module filters is the file the sampler opens -- frame n means the same thing on
both sides with no normalization step in between. evaluate() re-derives the
sampler positions from that file anyway and marks the rung invalid if they
disagree, because that alignment is the only thing making sampling_evasion mean
anything.

Usage:
    python -m evals.degrade --video clean.mp4 --model pose_landmarker.task
    python -m evals.degrade --video clean.mp4 --model m.task \
        --only evasion_blind evasion_oracle
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
    # Deterministic sinusoidal crop offset, amplitude in source pixels.
    #
    # The crop is scaled straight back to the original geometry. Cropping alone
    # makes a frame more elongated, and this is what first surfaced the
    # create_proxy aspect-ratio defect (HANDOFF 8.7): the old scale expression
    # pinned the short side to 720 and left the long side unbounded, so a
    # portrait clip near 16:9 was pushed past _validate_proxy's 1280 bound and
    # the rung died with a VideoError about nothing to do with camera shake.
    # That is fixed in video.py now, but restoring the geometry is still right:
    # this axis should vary camera motion and nothing else.
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


def sampling_evasion_ladder(indices: list[int], frame_count: int,
                            label: str = "sampling_evasion") -> list[Rung]:
    """Blur everything EXCEPT `indices`, the frames an attacker bets on.

    Run twice, against two attackers, because the fix and the residual risk are
    different things and one axis cannot show both:

      * **blind** -- indices from a seed the gate is not using. This is the
        realistic case, and it is what the fix is supposed to defeat: not
        knowing the jitter, the attacker cannot pick which frames to keep sharp,
        so the gate's samples land mostly on blurred frames and blur_score
        collapses the way it does under uniform blur.
      * **oracle** -- indices from the gate's actual seed. This is expected to
        still evade, and saying so plainly matters: density alone does not fix
        the hole, **seed secrecy is load-bearing**. If the seed ever becomes
        fixed, public, or derivable from the file, the hole is fully reopened.

    Read the blur column, not the status. Heavy blur also destroys pose
    tracking, so both variants can end `rejected` for reasons that have nothing
    to do with the blur check -- which is exactly how the pre-fix run looked
    like a pass while the check was being walked straight past.
    """
    if not indices or frame_count <= 0:
        return []

    # ffmpeg's expression parser fails somewhere between 80 and 100 `eq()`
    # terms (exit 244, "Error when evaluating the expression"). The sampler now
    # reads 203 frames, so a single enable expression is well past that. Split
    # into chained gblur instances, each responsible for one frame range and
    # sparing only the indices inside it, which keeps every expression short.
    chunk = 50
    groups = [indices[i:i + chunk] for i in range(0, len(indices), chunk)]

    def _graph(sigma: float) -> str:
        parts, lo = [], 0
        for position, group in enumerate(groups):
            hi = frame_count - 1 if position == len(groups) - 1 else group[-1]
            keep = "+".join(f"eq(n\\,{i})" for i in group)
            parts.append(
                f"gblur=sigma={sigma}:"
                f"enable='between(n\\,{lo}\\,{hi})*not({keep})'"
            )
            lo = hi + 1
        return ",".join(parts)

    return [
        Rung(label, sigma, _graph(sigma), "any",
             f"sharp at {len(indices)} of {frame_count} frames; "
             f"the rest at sigma={sigma}")
        for sigma in (8, 16)
    ]


# --- execution --------------------------------------------------------------

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


def sampler_indices(frame_count: int, seed: int | None) -> list[int]:
    """Delegate to the production sampler rather than reimplementing it.

    The first version of this file duplicated the index expression so that a
    change in production would break the eval loudly. That was right when the
    expression was one line of linspace. It is now stride-plus-seeded-jitter,
    and a second implementation would drift into agreeing with itself rather
    than with the gate. Alignment is still verified after every rung -- see
    evaluate() -- so drift shows up as an invalid rung, not a silent pass.
    """
    from snowtrace_analysis.video import quality_sample_indices

    return quality_sample_indices(frame_count, seed=seed)


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
             expected_indices: list[int] | None = None,
             seed: int | None = None, **kw) -> Outcome:
    from snowtrace_analysis.pipeline import AnalysisPipeline

    pipeline = AnalysisPipeline(model_path=model, work_dir=work, quality_seed=seed)
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
    # are the frames the sampler reads. That should hold by construction now,
    # which is exactly why it is worth checking: a broken assumption that is
    # never tested shows up as a confident wrong verdict instead of an
    # confident wrong verdict.
    invalid = ""
    if result.status == "needs_rider":
        invalid = "no usable rider track after degradation"
    if expected_indices is not None:
        # Check against the clip the gate was handed, which is the file
        # sample_visual_quality now opens -- not result.proxy_path, which it
        # only falls back to when the source cannot be decoded.
        actual = sampler_indices(proxy_frame_count(clip), seed)
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
                  "| severity | blur | stab | expo | readiness | status | "
                  "hard failures | expected |",
                  "|---|---|---|---|---|---|---|---|"]
        for o in group:
            mark = "  **INVALID**" if o.invalid else "" if o.ok else "  **MISS**"
            # Without this column a `rejected` row reads as "the axis worked",
            # when the rejection often comes from somewhere the axis never
            # touched. Naming the cause is the difference between a finding and
            # a coincidence.
            causes = ", ".join(f"`{f}`" for f in o.hard_failures) or "—"
            lines.append(
                f"| {o.severity} | {o.blur:.0f} | {o.stability:.0f} | "
                f"{o.exposure:.0f} | {o.readiness:.0f} | `{o.status}`{mark} | "
                f"{causes} | {o.expect} |"
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
    ap.add_argument("--seed", type=int, default=20260904,
                    help="pins the gate's quality-sampling jitter so the ladder "
                         "is reproducible; production leaves it unset")
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
        # Rungs are rendered from the raw source, not from a normalized copy.
        #
        # Normalizing first was the original fix for the coordinate-system half
        # of the sampling_evasion defect: the gate sampled the proxy, so the
        # source had to already be at proxy geometry for frame n to mean the
        # same thing on both sides. The gate now samples the SOURCE it is handed
        # (see pipeline.py), which is the file we render here -- alignment is
        # direct and pre-normalizing would be actively harmful, since it would
        # hand the gate an upscaled clip and re-create the very blur collapse
        # that fix removed.
        clean = args.video
        frame_count = proxy_frame_count(clean)
        duration = probe_duration(clean)
        from snowtrace_analysis.video import probe_video
        meta = probe_video(clean)

        # The gate's sample positions, pinned so the ladder is reproducible.
        gate_indices = sampler_indices(frame_count, args.seed)
        # What an attacker who guessed the seed wrong would sharpen. Any seed
        # the gate is not using will do; +1 makes the relationship obvious.
        blind_indices = sampler_indices(frame_count, args.seed + 1)
        overlap = len(set(gate_indices) & set(blind_indices))

        print(f"source: {meta.width}x{meta.height} {meta.orientation}, "
              f"{frame_count} frames, {duration:.2f}s", flush=True)
        print(f"gate samples {len(gate_indices)} frames "
              f"({len(gate_indices) / frame_count:.0%} of the clip) at seed "
              f"{args.seed}; a wrong-seed attacker overlaps on {overlap} of them",
              flush=True)

        rungs = (blur_ladder() + shake_ladder()
                 + rider_size_ladder(meta.width, meta.height)
                 + exposure_ladder() + turn_count_ladder(duration)
                 + sampling_evasion_ladder(blind_indices, frame_count,
                                          "evasion_blind")
                 + sampling_evasion_ladder(gate_indices, frame_count,
                                          "evasion_oracle"))
        if args.only:
            rungs = [r for r in rungs if r.axis in args.only]

        for i, rung in enumerate(rungs, 1):
            print(f"[{i}/{len(rungs)}] {rung.axis} @ {rung.severity}", flush=True)
            try:
                clip = render(clean, rung, tmp)
                outcomes.append(evaluate(
                    rung, clip, args.model, tmp / "work",
                    expected_indices=(gate_indices
                                      if rung.axis.startswith("evasion_") else None),
                    seed=args.seed,
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
