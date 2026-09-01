import unittest

import numpy as np

from snowtrace_analysis.contracts import PoseObservation, RiderTrack
from snowtrace_analysis.metrics import compute_metric_series


def asymmetric_track() -> RiderTrack:
    landmarks = np.zeros((33, 4), dtype=np.float32)
    landmarks[:, 3] = 0.95
    landmarks[11, :2] = (0.3, 0.1)
    landmarks[12, :2] = (0.7, 0.1)
    landmarks[23, :2] = (0.3, 0.4)
    landmarks[24, :2] = (0.7, 0.3)
    landmarks[25, :2] = (0.3, 0.6)
    landmarks[26, :2] = (0.7, 0.6)
    landmarks[27, :2] = (0.5, 0.6)
    landmarks[28, :2] = (0.7, 0.9)
    observation = PoseObservation(0, 0, landmarks, (0.2, 0.1, 0.8, 0.9), 0.95)
    return RiderTrack(0, [observation], 0.9)


def values_by_metric(stance: str) -> dict[str, float | None]:
    return {series.metric_id: series.values[0] for series in compute_metric_series(asymmetric_track(), stance)}


class MetricTests(unittest.TestCase):
    def test_occluded_lead_knee_suppresses_only_dependent_metrics(self):
        track = asymmetric_track()
        track.observations[0].landmarks[25, 3] = 0.1
        metrics = {series.metric_id: series for series in compute_metric_series(track, "regular")}

        self.assertIsNone(metrics["knee_flexion_lead"].values[0])
        self.assertIsNone(metrics["lead_trail_differential"].values[0])
        self.assertEqual(metrics["knee_flexion_lead"].confidence, 0.0)
        self.assertIsNotNone(metrics["knee_flexion_trail"].values[0])
        self.assertIsNotNone(metrics["upper_lower_separation"].values[0])
        self.assertGreater(metrics["knee_flexion_trail"].confidence, 0.9)

    def test_regular_and_goofy_swap_anatomical_lead_trail_labels(self):
        regular = values_by_metric("regular")
        goofy = values_by_metric("goofy")

        self.assertAlmostEqual(regular["knee_flexion_lead"], 90.0)
        self.assertAlmostEqual(regular["knee_flexion_trail"], 180.0)
        self.assertAlmostEqual(goofy["knee_flexion_lead"], 180.0)
        self.assertAlmostEqual(goofy["knee_flexion_trail"], 90.0)
        self.assertAlmostEqual(regular["lead_trail_differential"], -goofy["lead_trail_differential"])

    def test_fore_aft_sign_is_positive_toward_the_anatomical_lead_foot(self):
        regular = values_by_metric("regular")
        goofy = values_by_metric("goofy")

        self.assertGreater(regular["fore_aft_pelvis"], 0.0)
        self.assertAlmostEqual(regular["fore_aft_pelvis"], -goofy["fore_aft_pelvis"])

    def test_screen_direction_is_canonicalized_without_mutating_pose_data(self):
        original = asymmetric_track()
        mirrored = asymmetric_track()
        mirrored.observations[0].landmarks[:, 0] = 1.0 - mirrored.observations[0].landmarks[:, 0]
        mirrored_before = mirrored.observations[0].landmarks.copy()

        for stance in ("regular", "goofy"):
            left_to_right = compute_metric_series(original, stance, "left-to-right")
            right_to_left = compute_metric_series(mirrored, stance, "right-to-left")
            self.assertEqual(
                {series.metric_id: series.values for series in left_to_right},
                {series.metric_id: series.values for series in right_to_left},
            )
        np.testing.assert_array_equal(mirrored.observations[0].landmarks, mirrored_before)

        unnormalized = {series.metric_id: series.values[0] for series in compute_metric_series(mirrored, "regular")}
        normalized = {
            series.metric_id: series.values[0]
            for series in compute_metric_series(mirrored, "regular", "right-to-left")
        }
        self.assertAlmostEqual(unnormalized["projected_inclination"], -normalized["projected_inclination"])


if __name__ == "__main__":
    unittest.main()
