import unittest

import numpy as np

from snowtrace_analysis.contracts import PoseObservation, RiderTrack, Turn
from snowtrace_analysis.quality import build_quality_gate


def track_with_quality(
    frame_count: int,
    visibility: float,
    bbox_height: float,
    *,
    start_frame: int = 0,
    frame_step: int = 1,
) -> RiderTrack:
    observations = []
    for index in range(frame_count):
        frame_index = start_frame + index * frame_step
        landmarks = np.zeros((33, 4), dtype=np.float32)
        landmarks[:, 3] = visibility
        observations.append(PoseObservation(frame_index, frame_index * 33, landmarks, (0.2, 0.2, 0.5, 0.2 + bbox_height), visibility))
    return RiderTrack(0, observations, 0.9)


class QualityTests(unittest.TestCase):
    def test_occluded_knee_filters_only_dependent_metrics(self):
        track = track_with_quality(100, 0.92, 0.42)
        for observation in track.observations:
            observation.landmarks[25, 3] = 0.1
        turns = [Turn(index, "heelside" if index % 2 == 0 else "toeside", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")

        self.assertEqual(result.status, "limited")
        self.assertNotIn("knee_flexion_lead", result.allowed_metrics)
        self.assertNotIn("lead_trail_differential", result.allowed_metrics)
        self.assertIn("knee_flexion_trail", result.allowed_metrics)
        self.assertIn("upper_lower_separation", result.allowed_metrics)
        visibility = next(check for check in result.checks if check.id == "metric_visibility")
        self.assertLess(visibility.score, 75.0)

    def test_no_visible_metric_chain_is_rejected(self):
        track = track_with_quality(100, 0.92, 0.42)
        for observation in track.observations:
            observation.landmarks[[11, 12, 23, 24, 25, 26, 27, 28], 3] = 0.1
        turns = [Turn(index, "heelside" if index % 2 == 0 else "toeside", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")

        self.assertEqual(result.status, "rejected")
        self.assertEqual(result.allowed_metrics, [])
        self.assertIn("no_visible_metrics", result.hard_failures)

    def test_good_fixed_camera_can_pass_full(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]
        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")
        self.assertEqual(result.status, "full")
        self.assertGreaterEqual(result.readiness_score, 75)

    def test_small_rider_is_rejected(self):
        track = track_with_quality(100, 0.9, 0.08)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]
        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")
        self.assertEqual(result.status, "rejected")
        self.assertIn("rider_too_small", result.hard_failures)

    def test_two_turns_are_not_enough_for_same_edge_pairing(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "heelside" if index == 0 else "toeside", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(2)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")

        self.assertEqual(result.status, "rejected")
        self.assertIn("insufficient_turns", result.hard_failures)

    def test_follow_camera_is_limited(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]
        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="follow", view_angle="three-quarter")
        self.assertEqual(result.status, "limited")
        self.assertNotIn("fore_aft_pelvis", result.allowed_metrics)

    def test_waiting_frames_before_selected_segment_do_not_reduce_coverage(self):
        track = track_with_quality(240, 0.92, 0.42, start_frame=300)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")

        coverage = next(check for check in result.checks if check.id == "pose_coverage")
        self.assertEqual(result.status, "full")
        self.assertEqual(coverage.score, 100.0)
        self.assertIn("selected segment", coverage.detail)

    def test_pose_gaps_inside_selected_segment_still_fail_coverage(self):
        track = track_with_quality(40, 0.92, 0.42, start_frame=300, frame_step=3)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")

        coverage = next(check for check in result.checks if check.id == "pose_coverage")
        self.assertEqual(result.status, "rejected")
        self.assertIn("pose_coverage", result.hard_failures)
        self.assertLess(coverage.score, 50.0)

    def test_blocked_clarity_limits_metrics_without_rejecting_clip(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=20, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="three-quarter")

        self.assertEqual(result.status, "limited")
        self.assertEqual(result.hard_failures, [])
        self.assertNotIn("projected_inclination", result.allowed_metrics)
        self.assertTrue(any("sharp" in instruction for instruction in result.recapture_instructions))

    def test_front_rear_view_blocks_sagittal_knee_and_fore_aft_metrics(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="front-rear")

        self.assertEqual(result.status, "full")
        self.assertNotIn("knee_flexion_lead", result.allowed_metrics)
        self.assertNotIn("fore_aft_pelvis", result.allowed_metrics)
        self.assertIn("upper_lower_separation", result.allowed_metrics)

    def test_side_view_blocks_foreshortened_upper_lower_separation(self):
        track = track_with_quality(100, 0.92, 0.42)
        turns = [Turn(index, "unknown", index * 1000, index * 1000 + 400, index * 1000 + 800, 0.9) for index in range(3)]

        result = build_quality_gate(track, turns, blur_score=90, exposure_score=90, stability_score=90, camera_mode="fixed", view_angle="side")

        self.assertEqual(result.status, "full")
        self.assertIn("fore_aft_pelvis", result.allowed_metrics)
        self.assertNotIn("upper_lower_separation", result.allowed_metrics)


if __name__ == "__main__":
    unittest.main()
