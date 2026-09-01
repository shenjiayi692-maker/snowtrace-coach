import unittest
from pathlib import Path

import numpy as np

from snowtrace_analysis.comparison import ComparisonError, _phase_timestamp, _resample_turn, compare_videos
from snowtrace_analysis.contracts import (
    MetricSeries,
    PoseObservation,
    QualityGateResult,
    RiderTrack,
    Turn,
    VideoAnalysisResult,
    VideoMetadata,
)


def result(
    role: str,
    knee_offset: float,
    view_angle: str = "three-quarter",
    *,
    edges_known: bool = True,
) -> VideoAnalysisResult:
    turns = [
        Turn(0, "heelside" if edges_known else "unknown", 0, 500, 1000, 0.95),
        Turn(1, "toeside" if edges_known else "unknown", 1000, 1500, 2000, 0.95),
        Turn(2, "heelside" if edges_known else "unknown", 2000, 2500, 3000, 0.95),
        Turn(3, "toeside" if edges_known else "unknown", 3000, 3500, 4000, 0.95),
    ]
    timestamps = list(range(0, 4001, 50))
    values = [120.0 + knee_offset for _ in timestamps]
    quality = QualityGateResult("full", 90, [], [], ["knee_flexion_lead"], [])
    metadata = VideoMetadata(Path("test.mp4"), 4.0, 20.0, 1280, 720, "h264", 1, "landscape")
    landmarks = np.zeros((33, 4), dtype=np.float32)
    landmarks[:, 0] = np.linspace(0.2, 0.8, 33)
    landmarks[:, 1] = np.linspace(0.1, 0.9, 33)
    landmarks[:, 3] = 0.92
    track = RiderTrack(
        track_id=0,
        observations=[
            PoseObservation(index, timestamp, landmarks.copy(), (0.2, 0.1, 0.8, 0.9), 0.92)
            for index, timestamp in enumerate(timestamps)
        ],
    )
    return VideoAnalysisResult(
        role=role,
        camera_mode="fixed",
        view_angle=view_angle,
        metadata=metadata,
        proxy_path=Path("proxy.mp4"),
        selected_track_id=0,
        rider_candidates=[],
        segment_start_ms=0,
        segment_end_ms=4000,
        turns=turns,
        quality=quality,
        metrics=[MetricSeries("knee_flexion_lead", timestamps, values, 0.95, "degrees")],
        status="completed",
        selected_track=track,
    )


class ComparisonTests(unittest.TestCase):
    def test_phase_normalization_anchors_asymmetric_turns_at_detected_apex(self):
        timestamps = list(range(0, 1001, 50))

        def phase_curve(apex_ms: int) -> list[float]:
            return [
                timestamp / apex_ms * 50.0
                if timestamp <= apex_ms
                else 50.0 + (timestamp - apex_ms) / (1000 - apex_ms) * 50.0
                for timestamp in timestamps
            ]

        early_apex = Turn(0, "heelside", 0, 250, 1000, 0.95)
        late_apex = Turn(0, "heelside", 0, 750, 1000, 0.95)
        early_curve = _resample_turn(MetricSeries("test", timestamps, phase_curve(250), 0.95, "degrees"), early_apex)
        late_curve = _resample_turn(MetricSeries("test", timestamps, phase_curve(750), 0.95, "degrees"), late_apex)

        self.assertIsNotNone(early_curve)
        self.assertIsNotNone(late_curve)
        np.testing.assert_allclose(early_curve, late_curve, atol=1e-6)
        self.assertAlmostEqual(float(early_curve[50]), 50.0)
        self.assertEqual(_phase_timestamp(early_apex, 50), 250)
        self.assertEqual(_phase_timestamp(late_apex, 50), 750)

    def test_ranks_consistent_meaningful_difference(self):
        evidence = compare_videos(result("reference", 0), result("rider", 12))
        self.assertEqual(len(evidence), 2)
        self.assertEqual(evidence[0].metric_id, "knee_flexion_lead")
        self.assertEqual({item.edge_type for item in evidence}, {"heelside", "toeside"})
        self.assertEqual(evidence[0].rank, 1)
        self.assertEqual(evidence[0].paired_turns, 2)
        self.assertGreaterEqual(evidence[0].confidence, 0.7)
        self.assertIsNotNone(evidence[0].reference_pose)
        self.assertIsNotNone(evidence[0].user_pose)
        self.assertEqual(len(evidence[0].reference_pose.landmarks), 33)
        self.assertLessEqual(abs(evidence[0].reference_pose.timestamp_ms - evidence[0].reference_timestamp_ms), 50)

    def test_ignores_subthreshold_difference(self):
        evidence = compare_videos(result("reference", 0), result("rider", 4))
        self.assertEqual(evidence, [])

    def test_rejects_different_declared_views(self):
        with self.assertRaisesRegex(ComparisonError, "same declared view"):
            compare_videos(result("reference", 0, "side"), result("rider", 12, "three-quarter"))

    def test_unknown_edges_are_not_paired_by_sequence(self):
        evidence = compare_videos(
            result("reference", 0, edges_known=False),
            result("rider", 12, edges_known=False),
        )
        self.assertEqual(evidence, [])

    def test_show_me_uses_pair_closest_to_the_median_gap(self):
        reference = result("reference", 0)
        rider = result("rider", 0)
        turns = [
            Turn(
                index,
                "heelside" if index % 2 == 0 else "toeside",
                index * 1000,
                index * 1000 + 500,
                (index + 1) * 1000,
                0.95,
            )
            for index in range(6)
        ]
        timestamps = list(range(0, 6001, 50))
        heel_offsets = [12.0, 10.0, 14.0]

        def rider_value(timestamp: int) -> float:
            turn_index = min(timestamp // 1000, 5)
            return 120.0 + (heel_offsets[turn_index // 2] if turn_index % 2 == 0 else 0.0)

        for item, values in ((reference, [120.0] * len(timestamps)), (rider, [rider_value(timestamp) for timestamp in timestamps])):
            item.turns = turns
            item.segment_end_ms = 6000
            item.metrics = [MetricSeries("knee_flexion_lead", timestamps, values, 0.95, "degrees")]
            landmarks = item.selected_track.observations[0].landmarks
            item.selected_track.observations = [
                PoseObservation(index, timestamp, landmarks.copy(), (0.2, 0.1, 0.8, 0.9), 0.92)
                for index, timestamp in enumerate(timestamps)
            ]

        evidence = compare_videos(reference, rider)
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0].edge_type, "heelside")
        self.assertEqual(evidence[0].paired_turns, 3)
        self.assertLess(evidence[0].user_timestamp_ms, 1000)
        self.assertLess(evidence[0].reference_timestamp_ms, 1000)


if __name__ == "__main__":
    unittest.main()
