import math
import unittest

import numpy as np

from snowtrace_analysis.geometry import iou, safe_angle, wrapped_angle_difference


class GeometryTests(unittest.TestCase):
    def test_right_angle(self):
        result = safe_angle(np.array([1.0, 0.0]), np.array([0.0, 0.0]), np.array([0.0, 1.0]))
        self.assertAlmostEqual(result, 90.0)

    def test_zero_length_angle_is_nan(self):
        result = safe_angle(np.zeros(2), np.zeros(2), np.ones(2))
        self.assertTrue(math.isnan(result))

    def test_iou(self):
        self.assertAlmostEqual(iou((0, 0, 1, 1), (0.5, 0.5, 1.5, 1.5)), 1 / 7)

    def test_wrapped_angle(self):
        self.assertAlmostEqual(wrapped_angle_difference(175, -175), -10)


if __name__ == "__main__":
    unittest.main()
