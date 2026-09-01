import unittest
from pathlib import Path

import numpy as np

from snowtrace_analysis.comparison import ComparisonError, compare_videos
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


if __name__ == "__main__":
    unittest.main()
