import unittest
from pathlib import Path

import numpy as np

from snowtrace_analysis.comparison import compare_videos
from snowtrace_analysis.contracts import (
    MetricSeries,
    PoseObservation,
    QualityGateResult,
    RiderTrack,
    Turn,
    VideoAnalysisResult,
    VideoMetadata,
)


def result(role: str, knee_offset: float) -> VideoAnalysisResult:
    turns = [
        Turn(0, "heelside", 0, 500, 1000, 0.95),
        Turn(1, "toeside", 1000, 1500, 2000, 0.95),
        Turn(2, "heelside", 2000, 2500, 3000, 0.95),
        Turn(3, "toeside", 3000, 3500, 4000, 0.95),
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
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0].metric_id, "knee_flexion_lead")
        self.assertEqual(evidence[0].rank, 1)
        self.assertEqual(evidence[0].paired_turns, 4)
        self.assertGreaterEqual(evidence[0].confidence, 0.7)
        self.assertIsNotNone(evidence[0].reference_pose)
        self.assertIsNotNone(evidence[0].user_pose)
        self.assertEqual(len(evidence[0].reference_pose.landmarks), 33)
        self.assertLessEqual(abs(evidence[0].reference_pose.timestamp_ms - evidence[0].reference_timestamp_ms), 50)

    def test_ignores_subthreshold_difference(self):
        evidence = compare_videos(result("reference", 0), result("rider", 4))
        self.assertEqual(evidence, [])


if __name__ == "__main__":
    unittest.main()
