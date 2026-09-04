"""L3 -- abstention checks.

The cheapest tests in the suite and the ones guarding the worst outcome. A gap
that does not exist, reported with a drill attached, is failure mode (1): the
rider trains the wrong movement. Everything else in this suite is upstream of
that; this is the thing itself.

Only the self-comparison check is implemented, deliberately. The other three
abstention cases from the design need footage that does not exist yet (two clips
of the same rider on the same run) or a running job queue (missing secrets must
leave the job queued, not fabricate a result). Writing them against mocks would
test the mocks.

No video, no MediaPipe, no ffmpeg -- the fixture carries landmarks, and the
metric and comparison layers are pure functions of a track. Runs in under a
second, which is the point: this belongs in CI.

    python -m unittest evals.abstention -v
"""

from __future__ import annotations

import copy
import unittest
from pathlib import Path

from snowtrace_analysis.comparison import ComparisonError, compare_videos
from snowtrace_analysis.contracts import (
    QualityGateResult,
    RiderTrack,
    Turn,
    VideoAnalysisResult,
    VideoMetadata,
)
from snowtrace_analysis.metrics import compute_metric_series
from snowtrace_analysis.quality import build_quality_gate

from . import fixture

FIXTURE = Path(__file__).parent / "fixtures" / "track_clean.json"

# The gate is handed near-perfect capture scores on purpose. This suite is not
# testing the gate -- it is testing whether the comparison layer abstains when
# there is nothing to report, and that claim is strongest when the gate is as
# permissive as it can be. A pass here under a lenient gate implies a pass under
# a strict one; the reverse is not true.
GENEROUS_CAPTURE = dict(blur_score=95.0, exposure_score=95.0, stability_score=95.0)


def build_result(
    track: RiderTrack,
    turns: list[Turn],
    role: str,
    stance: str = "regular",
    view_angle: str = "three-quarter",
    travel_direction: str = "left-to-right",
    quality: QualityGateResult | None = None,
) -> VideoAnalysisResult:
    """Assemble the VideoAnalysisResult the comparison layer expects.

    The pipeline builds this from a video. Everything comparison actually reads
    -- metrics, turns, the quality allowlist, the track for pose snapshots --
    derives from the track, so a fixture is enough and no decoding is needed.
    """
    if quality is None:
        quality = build_quality_gate(
            track, turns, camera_mode="fixed", view_angle=view_angle,
            stance=stance, **GENEROUS_CAPTURE,
        )
    metrics = (
        compute_metric_series(track, stance, travel_direction)
        if quality.status != "rejected" else []
    )
    metadata = VideoMetadata(
        path=Path(f"{role}.mp4"),
        duration_seconds=(track.last_timestamp_ms - track.first_timestamp_ms) / 1000.0,
        fps=30.0, width=720, height=1280, codec="h264", size_bytes=0,
        orientation="portrait",
    )
    return VideoAnalysisResult(
        role=role,
        camera_mode="fixed",
        view_angle=view_angle,
        metadata=metadata,
        proxy_path=Path(f"{role}-proxy.mp4"),
        selected_track_id=track.track_id,
        rider_candidates=[],
        segment_start_ms=track.first_timestamp_ms,
        segment_end_ms=track.last_timestamp_ms,
        turns=turns,
        quality=quality,
        metrics=metrics,
        status="rejected" if quality.status == "rejected" else "completed",
        selected_track=track,
        travel_direction=travel_direction,
    )


class AbstentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not FIXTURE.exists():
            raise unittest.SkipTest(
                f"{FIXTURE} is missing. Generate it with "
                f"`python -m evals.fixture capture ... --out {FIXTURE}`."
            )
        cls.track, cls.turns, cls.meta = fixture.load(FIXTURE)

    def test_clip_compared_against_itself_yields_no_gap(self) -> None:
        """The sharpest test in the suite.

        A clip and itself differ by exactly zero on every metric, in every phase,
        on both edges. Any evidence returned here is manufactured: the rider
        would be handed a drill for a movement difference that does not exist,
        which is the failure mode the whole system is ranked against.

        If this fails, the evidence thresholds -- confidence >= 0.70,
        effect_size >= 1.0, paired_turns >= 2 -- are decorative.
        """
        reference = build_result(self.track, self.turns, "reference")
        rider = build_result(self.track, self.turns, "rider")

        # Guard the guard: if the gate rejected the fixture there would be
        # nothing to compare and the test would pass vacuously.
        self.assertNotEqual(reference.quality.status, "rejected")
        self.assertTrue(reference.metrics, "no metrics computed; test is vacuous")
        self.assertTrue(
            reference.quality.allowed_metrics,
            "empty metric allowlist; comparison had nothing to rank",
        )

        evidence = compare_videos(reference, rider)

        self.assertEqual(
            evidence, [],
            "A clip compared against itself produced "
            f"{len(evidence)} coaching gap(s): "
            + ", ".join(
                f"{item.metric_id}/{item.edge_type}/{item.phase} "
                f"diff={item.difference:.3f} effect={item.effect_size:.2f} "
                f"conf={item.confidence:.2f}"
                for item in evidence
            ),
        )

    def test_a_real_difference_does_produce_evidence(self) -> None:
        """The control. Without it the abstention test can pass vacuously.

        It already did once: the fixture was first captured with the default
        `--first-edge unknown`, so every turn was labelled `unknown` while
        compare_videos only iterates heelside and toeside. Nothing matched, no
        evidence could ever be produced, and the self-comparison test passed
        while guarding nothing -- a 10% landmark shift on both knees also
        returned zero.

        So this asserts the opposite direction: a difference that is plainly
        real must be reported. Together the two tests pin the comparison layer
        between silence and confabulation; either alone is satisfied by a
        component that always says nothing.
        """
        reference = build_result(self.track, self.turns, "reference")

        shifted = copy.deepcopy(self.track)
        for observation in shifted.observations:
            for landmark in (25, 26):        # left and right knee
                observation.landmarks[landmark, 1] -= 0.05
        rider = build_result(shifted, self.turns, "rider")

        evidence = compare_videos(reference, rider)
        self.assertTrue(
            evidence,
            "Both knees moved 5% of frame height and the comparison layer "
            "reported nothing. The abstention test above is therefore vacuous: "
            "check that the fixture's turns carry heelside/toeside edges rather "
            "than `unknown`.",
        )

    def test_rejected_clip_cannot_be_compared(self) -> None:
        """A rejected clip must never reach report generation.

        The gate's verdict has to be load-bearing at the boundary, not just
        rendered in the UI. Constructed by forcing the reject rather than by
        degrading footage, so the check stays video-free.
        """
        rejected = QualityGateResult(
            status="rejected", readiness_score=0, hard_failures=["pose_coverage"],
            checks=[], allowed_metrics=[], recapture_instructions=[],
        )
        reference = build_result(self.track, self.turns, "reference")
        rider = build_result(self.track, self.turns, "rider", quality=rejected)

        with self.assertRaises(ComparisonError):
            compare_videos(reference, rider)


if __name__ == "__main__":
    unittest.main()
