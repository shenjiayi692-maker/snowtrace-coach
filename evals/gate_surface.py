"""L0 -- decision-surface map for build_quality_gate.

Needs no video, no labels, and no annotated clips. It takes one real RiderTrack,
sweeps every scalar the gate accepts, and reports where the status flips.

The gate contains two independent mechanisms:

  * hard thresholds   -- coverage < .5, visibility < .5, bbox < .12,
                         turns < 3, blur < 50, stability < 50
  * a weighted sum    -- readiness < 55 rejects, < 75 limits

Nothing forces them to agree. This maps the regions where they don't, and
flags any check that carries no information because its score never varies.

Usage:
    python -m evals.gate_surface --track evals/fixtures/track_clean.json
    python -m evals.gate_surface --track ... --out evals/out/surface.md
"""

from __future__ import annotations

import argparse
import dataclasses
import itertools
import json
from dataclasses import dataclass
from pathlib import Path

from snowtrace_analysis.contracts import RiderTrack, Turn
from snowtrace_analysis.quality import MIN_TURNS, build_quality_gate

from . import fixture


def load_track(path: Path) -> tuple[RiderTrack, list[Turn], dict]:
    """Load a frozen track fixture. Generate one with:

        python -m evals.fixture capture rider.mp4 \
            --model pose_landmarker.task --out evals/fixtures/track_clean.json
    """
    return fixture.load(path)


CAMERA_MODES = ("fixed", "follow")
VIEW_ANGLES = ("three-quarter", "side", "front-rear")
STANCES = ("regular", "goofy")

# Only these checks take an input this sweep actually varies. The other four
# (pose_coverage, full_body, rider_size, occlusion) are pure functions of the
# track, so they are constant across any sweep of the scalar arguments -- by
# construction, not because they carry no information. Scoping the dead-weight
# search to swept inputs is what keeps that distinction meaningful.
SWEPT_CHECK_IDS = ("motion_blur", "stability", "exposure", "metric_visibility")


@dataclass(slots=True)
class Point:
    blur: float
    stability: float
    exposure: float
    camera_mode: str
    view_angle: str
    stance: str
    status: str
    readiness: float
    allowed: tuple[str, ...]
    scores: dict[str, float]

    @property
    def visibility_limited(self) -> bool:
        # metric_visibility_score = len(visible)/len(candidate)*100, so anything
        # below 100 means the gate dropped at least one view-compatible metric.
        return self.scores.get("metric_visibility", 100.0) < 100.0


def sweep(track: RiderTrack, turns: list[Turn], step: int = 5) -> list[Point]:
    axis = range(0, 101, step)
    points: list[Point] = []
    combos = itertools.product(axis, axis, axis, CAMERA_MODES, VIEW_ANGLES, STANCES)
    for blur, stab, expo, mode, view, stance in combos:
        result = build_quality_gate(
            track, turns,
            blur_score=float(blur),
            exposure_score=float(expo),
            stability_score=float(stab),
            camera_mode=mode,
            view_angle=view,
            stance=stance,
        )
        points.append(Point(
            blur=blur, stability=stab, exposure=expo,
            camera_mode=mode, view_angle=view, stance=stance,
            status=result.status,
            readiness=result.readiness_score,
            allowed=tuple(result.allowed_metrics),
            scores={c.id: c.score for c in result.checks},
        ))
    return points


def find_dead_weights(points: list[Point]) -> list[tuple[str, float]]:
    """Swept checks whose score never varies across the whole sweep.

    A swept check with a constant score contributes a fixed offset to readiness
    and zero discriminative power. Restricted to SWEPT_CHECK_IDS: a check whose
    inputs this sweep never touches is trivially constant and says nothing.
    """
    if not points:
        return []
    dead = []
    for ident in SWEPT_CHECK_IDS:
        if ident not in points[0].scores:
            continue
        values = {p.scores[ident] for p in points}
        if len(values) == 1:
            dead.append((ident, values.pop()))
    return dead


TURN_SCORE_REFERENCE = 3.0   # the divisor in quality.turn_score


def turn_check_window() -> tuple[int, int]:
    """Claim A, as a property of the formula -- no sweep required.

    turn_score = min(100, len(turns) / 3.0 * 100) saturates at 100 for any clip
    with >= 3 turns, and clips below MIN_TURNS are hard-rejected before the
    weighted sum matters. So the check can only discriminate inside the window
    [MIN_TURNS, 3). If that window is empty the check is dead weight: a fixed
    10-point offset on readiness with no discriminative power.

    This is deliberately computed from quality.MIN_TURNS rather than a literal,
    so that lowering the floor is visible here instead of silently invalidating
    the claim.
    """
    return MIN_TURNS, int(TURN_SCORE_REFERENCE)


def find_mechanism_conflicts(points: list[Point]) -> list[Point]:
    """readiness says `full`, a hard capture threshold says `limited`.

    Attributed, not just counted. `camera_mode == "follow"` and a shrunken
    metric allowlist each force `limited` for their own reasons; including
    those would inflate the number and blame the wrong mechanism. Only points
    where blur/stability alone did the demotion are counted.
    """
    return [
        p for p in points
        if p.readiness >= 75
        and p.status == "limited"
        and p.camera_mode == "fixed"
        and not p.visibility_limited
        and (p.blur < 50 or p.stability < 50)
    ]


def find_high_readiness_rejections(points: list[Point]) -> list[Point]:
    """readiness in the passing range, verdict `rejected`.

    The gate's tail branch rejects when the allowlist intersection comes out
    empty, after readiness has already been computed and reported. This is the
    sharpest disagreement between the two mechanisms: the number shown to the
    rider can sit in the 90s on a clip that was thrown out.
    """
    return [p for p in points if p.status == "rejected" and p.readiness >= 75]


def find_boundaries(points: list[Point], axis: str) -> dict[tuple, list[tuple[float, str, str]]]:
    """Per-context flip points along one scalar axis."""
    keyed: dict[tuple, list[Point]] = {}
    for p in points:
        ctx = (p.camera_mode, p.view_angle, p.stance,
               *(getattr(p, a) for a in ("blur", "stability", "exposure") if a != axis))
        keyed.setdefault(ctx, []).append(p)
    flips: dict[tuple, list[tuple[float, str, str]]] = {}
    for ctx, group in keyed.items():
        group.sort(key=lambda p: getattr(p, axis))
        transitions = [
            (getattr(b, axis), a.status, b.status)
            for a, b in zip(group, group[1:]) if a.status != b.status
        ]
        if transitions:
            flips[ctx] = transitions
    return flips


def report(points: list[Point], meta: dict) -> str:
    lines = ["# Quality gate decision surface", ""]
    total = len(points)
    src = meta.get("source", "unknown")
    lines += [
        f"Fixture: `{src}` -- {meta.get('turn_count', '?')} turns, "
        f"captured gate status `{meta.get('gate_status')}` "
        f"(readiness {meta.get('readiness_score')}).",
        "",
    ]
    by_status = {s: sum(1 for p in points if p.status == s)
                 for s in ("full", "limited", "rejected")}
    lines += [f"Swept {total} configurations.", ""]
    lines += [f"- `{s}`: {n} ({n / total:.0%})" for s, n in by_status.items()] + [""]

    floor, reference = turn_check_window()
    turn_scores = {p.scores.get("turns") for p in points if p.status != "rejected"}
    lines += ["## Claim A -- the `turns` check carries no information", ""]
    if floor >= reference:
        lines += [
            f"- **Confirmed.** `turn_score = min(100, len(turns)/{reference:.0f}*100)` "
            f"saturates at 100 from {reference:.0f} turns up, and clips below "
            f"`MIN_TURNS = {floor}` are hard-rejected before the weighted sum runs. "
            f"The discriminating window `[{floor}, {reference:.0f})` is **empty**, so "
            f"the check is a constant 10-point offset on readiness.",
            "- This is a property of the formula. The sweep only exhibits it.",
        ]
    else:
        lines += [
            f"- **Refuted as currently configured.** `MIN_TURNS` is {floor}, so clips "
            f"with {floor}..{reference - 1} turns are admitted and score "
            f"{floor / reference * 100:.0f}..{(reference - 1) / reference * 100:.0f} "
            f"instead of saturating. The check discriminates inside the window "
            f"`[{floor}, {reference:.0f})` and saturates above it.",
            f"- The reject floor ({floor}) and the score reference ({reference:.0f}) "
            f"are two different numbers for one concept -- the same defect shape as "
            f"`rider_size`. Claim A returns the moment the floor is raised back to "
            f"{reference:.0f}.",
        ]
    if len(turn_scores) == 1:
        lines.append(
            f"- On this fixture the score is pinned at "
            f"{next(iter(turn_scores)):.0f} regardless, because turn count is a "
            f"property of the fixture and is not one of the swept axes."
        )
    lines.append("")

    dead = find_dead_weights(points)
    lines += ["## Swept checks that did not vary on this fixture", ""]
    if dead:
        for ident, v in dead:
            lines.append(
                f"- **`{ident}`** is constant at {v:.0f} across all "
                f"{len(CAMERA_MODES) * len(VIEW_ANGLES) * len(STANCES)} "
                f"mode/view/stance combinations."
            )
        lines.append(
            "- Fixture-scoped, not a proven code defect: another track with weaker "
            "landmarks could make these vary. Re-check on a second fixture before "
            "concluding the weight is dead."
        )
    else:
        lines.append("- none")
    lines.append("")

    conflicts = find_mechanism_conflicts(points)
    lines += ["## Claim C.1 -- hard threshold overrides the weighted sum", ""]
    if conflicts:
        worst = max(conflicts, key=lambda p: p.readiness)
        lines += [
            f"- {len(conflicts)} of {total} configurations ({len(conflicts)/total:.1%}) "
            f"scored readiness >= 75 (the `full` line) but were demoted to `limited` "
            f"by blur or stability alone -- follow-camera and metric-visibility "
            f"demotions are excluded so the cause is unambiguous.",
            f"- Worst case: readiness {worst.readiness:.0f}, blur {worst.blur}, "
            f"stability {worst.stability}, exposure {worst.exposure} -> `limited`.",
            "- The readiness number shown to the rider does not explain this verdict.",
        ]
    else:
        lines.append("- none")
    lines.append("")

    rejected_high = find_high_readiness_rejections(points)
    lines += ["## Claim C.2 -- high readiness, rejected anyway", ""]
    if rejected_high:
        worst = max(rejected_high, key=lambda p: p.readiness)
        lines += [
            f"- {len(rejected_high)} configurations were `rejected` while carrying "
            f"readiness >= 75; the highest was {worst.readiness:.0f} "
            f"(blur {worst.blur}, stability {worst.stability}, "
            f"view {worst.view_angle}, stance {worst.stance}).",
            "- These come from the gate's tail branch, which rejects when the "
            "allowed-metric intersection is empty -- after readiness has already "
            "been computed and surfaced.",
        ]
    elif by_status["rejected"] == 0:
        lines.append(
            "- Not reachable on this fixture: the sweep produced no `rejected` "
            "configurations at all, so the tail branch was never exercised. This "
            "is not evidence that the branch is sound -- capturing this same clip "
            "under `MIN_TURNS = 3` produced readiness 91 with status `rejected`."
        )
    else:
        lines.append("- none")
    lines.append("")

    lines += ["## Status flip points", ""]
    for axis in ("blur", "stability", "exposure"):
        flips = find_boundaries(points, axis)
        observed = sorted({t[0] for ts in flips.values() for t in ts})
        lines.append(f"- **{axis}**: flips at {observed or 'never'}")
    lines.append("")
    lines += [
        "## What to do with this",
        "",
        "Each flip point above is a number someone picked by hand. Run L1 (the",
        "degradation ladder) to find where the gate *should* flip on real footage,",
        "then reconcile. Where a hand-picked constant and the measured flip point",
        "disagree, the constant is wrong.",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--track", type=Path, required=True,
                    help="clean RiderTrack fixture (JSON)")
    ap.add_argument("--out", type=Path, help="write markdown report here")
    ap.add_argument("--json", type=Path, help="also dump raw sweep points")
    ap.add_argument("--step", type=int, default=5,
                    help="grid step for the 0-100 scalar axes (default 5)")
    args = ap.parse_args()

    track, turns, meta = load_track(args.track)
    points = sweep(track, turns, step=args.step)
    text = report(points, meta)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"Wrote {args.out}")
    else:
        print(text)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            # Point is slots=True, so it has no __dict__ -- asdict, not vars().
            json.dumps([dataclasses.asdict(p) for p in points],
                       default=list, indent=2),
            encoding="utf-8",
        )

    # No CI assertion here yet, deliberately.
    #
    # The original design asserted `not find_dead_weights(points)`. Unscoped that
    # fails on every fixture (four checks are pure functions of the track and
    # cannot vary in a scalar sweep). Scoped to SWEPT_CHECK_IDS it still fails
    # for a fixture-dependent reason: a track whose landmarks are reliable in all
    # six view/stance combinations pins metric_visibility at 100. Neither is a
    # code defect, and a CI gate that reddens on a fixture property is the same
    # mistake one level down.
    #
    # What belongs here is an assertion on something fixture-independent -- claim
    # A's empty window, checked against quality.MIN_TURNS. Left out until a
    # second fixture exists to confirm it does not encode this clip's quirks.


if __name__ == "__main__":
    main()
