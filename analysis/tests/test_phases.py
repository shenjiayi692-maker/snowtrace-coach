import unittest

import numpy as np

from snowtrace_analysis.contracts import PoseObservation, RiderTrack
from snowtrace_analysis.phases import detect_turns


def synthetic_track(turns: float = 3.5, frames: int = 240) -> RiderTrack:
    observations = []
    for index in range(frames):
        phase = index / (frames - 1) * turns * 2 * np.pi
        landmarks = np.zeros((33, 4), dtype=np.float32)
        landmarks[:, 3] = 0.95
        landmarks[11, :2] = [0.46, 0.25]
        landmarks[12, :2] = [0.54, 0.25]
        hip_x = 0.5 + np.sin(phase) * 0.08
        landmarks[23, :2] = [hip_x - 0.04, 0.5]
        landmarks[24, :2] = [hip_x + 0.04, 0.5]
        landmarks[27, :2] = [0.42, 0.83]
        landmarks[28, :2] = [0.58, 0.83]
        observations.append(PoseObservation(index, int(index / 30 * 1000), landmarks, (0.35, 0.2, 0.65, 0.9), 0.95))
    return RiderTrack(0, observations, 0.95)


class PhaseTests(unittest.TestCase):
    def test_detects_repeating_turns(self):
        turns = detect_turns(synthetic_track(), first_edge="heelside")
        self.assertGreaterEqual(len(turns), 3)
        self.assertEqual(turns[0].edge_type, "heelside")
        self.assertEqual(turns[1].edge_type, "toeside")
        self.assertTrue(all(turn.start_ms < turn.apex_ms < turn.end_ms for turn in turns))


if __name__ == "__main__":
    unittest.main()
