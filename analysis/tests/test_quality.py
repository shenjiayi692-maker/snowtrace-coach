import unittest

import numpy as np

from snowtrace_analysis.contracts import PoseObservation, RiderTrack, Turn
from snowtrace_analysis.quality import build_quality_gate


def track_with_quality(frame_count: int, visibility: float, bbox_height: float) -> RiderTrack:
    observations = []
    for index in range(frame_count):
        landmarks = np.zeros((33, 4), dtype=np.float32)
        landmarks[:, 3] = visibility
        observations.append(PoseObservation(index, index * 33, landmarks, (0.2, 0.2, 0.5, 0.2 + bbox_height), visibility))
    return RiderTrack(0, observations, 0.9)


class QualityTests(unittest.TestCase):
    def test_good_fixed_camera_can_pass_full(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]
        result = build_quality_gate(track, 100, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed")
        self.assertEqual(result.status, "full")
        self.assertGreaterEqual(result.readiness_score, 75)

    def test_small_rider_is_rejected(self):
        track = track_with_quality(100, 0.9, 0.08)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]
        result = build_quality_gate(track, 100, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed")
        self.assertEqual(result.status, "rejected")
        self.assertIn("rider_too_small", result.hard_failures)

    def test_follow_camera_is_limited(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]
        result = build_quality_gate(track, 100, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="follow")
        self.assertEqual(result.status, "limited")
        self.assertNotIn("fore_aft_pelvis", result.allowed_metrics)


if __name__ == "__main__":
    unittest.main()
