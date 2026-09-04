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

    @property
    def ok(self) -> bool:
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
    rungs = []
    for amp in (0, 2, 4, 8, 16, 32):
        vf = (f"crop=iw-{2*32}:ih-{2*32}:"
              f"'32+{amp}*sin(n*1.7)':'32+{amp}*cos(n*2.3)'")
        rungs.append(Rung("shake", amp, vf, "any",
                          "stability_score = 100 - median_flow*16"))
    return rungs


def rider_size_ladder() -> list[Rung]:
    # Shrink the rider inside the frame. Hard failure is bbox_height < 0.12,
    # the recapture message says 20%, and the score normalizes against 0.35.
    # Three different numbers for one concept -- this ladder shows which binds.
    rungs = []
    for k in (1.0, 0.7, 0.5, 0.35, 0.25, 0.15):
        vf = (f"scale=iw*{k}:ih*{k},"
              f"pad=iw/{k}:ih/{k}:(ow-iw)/2:(oh-ih)/2:black")
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


def sampling_evasion_ladder(frame_count: int) -> list[Rung]:
    """Blur everything EXCEPT the frames the quality sampler happens to read.

    sample_visual_quality reads QUALITY_SAMPLE_COUNT frames at
    np.linspace(0, frame_count-1, ..., dtype=int). Those positions are fixed and
    knowable. A clip that is sharp at exactly those indices and blurred
    everywhere else should be caught -- if it is not, blur_score is measuring
    1.7% of the clip and the gate has a hole that no threshold change closes.

    The index formula mirrors production exactly, including the truncating
    `dtype=int` cast. Using int(round(...)) instead moves 4 of 10 positions on a
    600-frame clip, which would blur the frames the sampler actually reads and
    "confirm" the finding for the wrong reason.
    """
    if frame_count <= 0:
        return []
    indices = np.linspace(
        0, frame_count - 1, min(QUALITY_SAMPLE_COUNT, frame_count), dtype=int
    ).tolist()
    keep = "+".join(f"eq(n\\,{i})" for i in indices)
    return [
        Rung("sampling_evasion", sigma,
             f"gblur=sigma={sigma}:enable='not({keep})'",
             "rejected",
             f"sharp only at frames {indices}; the rest at sigma={sigma}")
        for sigma in (8, 16)
    ]


# --- execution --------------------------------------------------------------

def probe_frame_count(video: Path) -> tuple[int, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "format=duration", "-of", "json", str(video)],
        check=True, capture_output=True, text=True,
    )
    duration = float(json.loads(out.stdout)["format"]["duration"])
    return int(duration * PROXY_FPS), duration


def render(source: Path, rung: Rung, out_dir: Path) -> Path:
    dest = out_dir / f"{rung.axis}_{rung.severity}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(source),
         "-vf", rung.vfilter, "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", str(dest)],
        check=True, capture_output=True, text=True,
    )
    return dest


def evaluate(rung: Rung, clip: Path, model: Path, work: Path, **kw) -> Outcome:
    from snowtrace_analysis.pipeline import AnalysisPipeline

    pipeline = AnalysisPipeline(model_path=model, work_dir=work)
    result = pipeline.analyze_video(clip, role="rider", **kw)
    q = result.quality
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
            mark = "" if o.ok else "  **MISS**"
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

    misses = [o for o in outcomes if not o.ok]
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

    frame_count, duration = probe_frame_count(args.video)
    rungs = (blur_ladder() + shake_ladder() + rider_size_ladder()
             + exposure_ladder() + turn_count_ladder(duration)
             + sampling_evasion_ladder(frame_count))
    if args.only:
        rungs = [r for r in rungs if r.axis in args.only]

    kw = dict(camera_mode=args.camera_mode, stance=args.stance,
              view_angle=args.view_angle, travel_direction=args.travel_direction,
              first_edge=args.first_edge)

    tmp = Path(tempfile.mkdtemp(prefix="snowtrace-l1-"))
    outcomes: list[Outcome] = []
    try:
        for i, rung in enumerate(rungs, 1):
            print(f"[{i}/{len(rungs)}] {rung.axis} @ {rung.severity}", flush=True)
            clip = render(args.video, rung, tmp)
            try:
                outcomes.append(evaluate(rung, clip, args.model, tmp / "work", **kw))
            except ValueError as e:      # pipeline's own duration/track guards
                print(f"    skipped: {e}", flush=True)
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
