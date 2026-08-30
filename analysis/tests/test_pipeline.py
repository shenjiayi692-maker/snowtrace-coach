import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from snowtrace_analysis.contracts import RiderTrack, VideoMetadata
from snowtrace_analysis.pipeline import AnalysisPipeline


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"video")
        self.metadata = VideoMetadata(
            path=self.source,
            duration_seconds=8.0,
            fps=30.0,
            width=1280,
            height=720,
            codec="h264",
            size_bytes=5,
            orientation="landscape",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_no_detected_rider_returns_actionable_rejection(self):
        pipeline = AnalysisPipeline(self.root / "model.task", self.root / "artifacts")
        with (
            patch("snowtrace_analysis.pipeline.probe_video", return_value=self.metadata),
            patch("snowtrace_analysis.pipeline.create_proxy"),
            patch("snowtrace_analysis.pipeline.extract_tracks", return_value=([], 30, None)),
            patch("snowtrace_analysis.pipeline.rider_candidates", return_value=[]),
        ):
            result = pipeline.analyze_video(self.source, role="rider", camera_mode="fixed")
        self.assertEqual(result.status, "rejected")
        self.assertIsNotNone(result.quality)
        self.assertEqual(result.quality.readiness_score, 0)
        self.assertIn("rider_not_found", result.quality.hard_failures)
        self.assertGreaterEqual(len(result.quality.recapture_instructions), 1)

    def test_invalid_selected_track_is_not_silently_replaced(self):
        pipeline = AnalysisPipeline(self.root / "model.task", self.root / "artifacts")
        tracks = [RiderTrack(track_id=3)]
        with (
            patch("snowtrace_analysis.pipeline.probe_video", return_value=self.metadata),
            patch("snowtrace_analysis.pipeline.create_proxy"),
            patch("snowtrace_analysis.pipeline.extract_tracks", return_value=(tracks, 30, None)),
            patch("snowtrace_analysis.pipeline.rider_candidates", return_value=[]),
            patch("snowtrace_analysis.pipeline.selection_is_ambiguous", return_value=False),
        ):
            with self.assertRaisesRegex(ValueError, "selected rider track"):
                pipeline.analyze_video(self.source, role="rider", camera_mode="fixed", selected_track_id=99)


if __name__ == "__main__":
    unittest.main()
