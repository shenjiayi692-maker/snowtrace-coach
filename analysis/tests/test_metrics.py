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


if __name__ == "__main__":
    unittest.main()
