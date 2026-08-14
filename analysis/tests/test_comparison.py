import unittest
from pathlib import Path

from snowtrace_analysis.comparison import compare_videos
from snowtrace_analysis.contracts import (
    MetricSeries,
    QualityGateResult,
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
    )


class ComparisonTests(unittest.TestCase):
    def test_ranks_consistent_meaningful_difference(self):
        evidence = compare_videos(result("reference", 0), result("rider", 12))
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0].metric_id, "knee_flexion_lead")
        self.assertEqual(evidence[0].rank, 1)
        self.assertEqual(evidence[0].paired_turns, 4)
        self.assertGreaterEqual(evidence[0].confidence, 0.7)

    def test_ignores_subthreshold_difference(self):
        evidence = compare_videos(result("reference", 0), result("rider", 4))
        self.assertEqual(evidence, [])


if __name__ == "__main__":
    unittest.main()
