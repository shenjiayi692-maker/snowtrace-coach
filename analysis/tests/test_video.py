import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from snowtrace_analysis.video import create_proxy, probe_video


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools are required")
class VideoNormalizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary_directory.name)
        cls.base = cls.root / "base.mp4"
        cls.rotated = cls.root / "rotated-offset.mp4"
        cls.variable_rate = cls.root / "variable-rate.mp4"
        cls.high_resolution = cls.root / "high-resolution.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.base),
            ],
            check=True,
        )
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=0.2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.high_resolution),
            ],
            check=True,
        )
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2",
                "-vf", r"select=if(lt(n\,30)\,not(mod(n\,2))\,1)",
                "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                str(cls.variable_rate),
            ],
            check=True,
        )
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-itsoffset", "2", "-display_rotation:v:0", "90", "-i", str(cls.base),
                "-map", "0:v:0", "-c", "copy", str(cls.rotated),
            ],
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.temporary_directory.cleanup()

    def test_probe_reports_display_orientation_and_content_duration(self):
        metadata = probe_video(self.rotated)

        self.assertEqual((metadata.width, metadata.height), (360, 640))
        self.assertEqual(metadata.orientation, "portrait")
        self.assertEqual(metadata.rotation_degrees, 90)
        self.assertAlmostEqual(metadata.start_time_seconds, 2.0, places=3)
        self.assertAlmostEqual(metadata.duration_seconds, 1.0, places=3)
        self.assertAlmostEqual(metadata.fps, 24.0, places=3)

    def test_proxy_is_upright_cfr_zero_based_and_normalized_to_720p(self):
        source = probe_video(self.rotated)
        proxy_path = create_proxy(self.rotated, self.root / "proxy.mp4")
        proxy = probe_video(proxy_path)

        self.assertEqual((proxy.width, proxy.height), (720, 1280))
        self.assertEqual(proxy.orientation, "portrait")
        self.assertEqual(proxy.rotation_degrees, 0)
        self.assertAlmostEqual(proxy.start_time_seconds, 0.0, places=3)
        self.assertAlmostEqual(proxy.fps, 30.0, places=3)
        self.assertLessEqual(abs(proxy.duration_seconds - source.duration_seconds), 1 / 30 + 1e-3)

    def test_variable_frame_rate_proxy_becomes_30_fps_without_duration_drift(self):
        source = probe_video(self.variable_rate)
        proxy = probe_video(create_proxy(self.variable_rate, self.root / "variable-rate-proxy.mp4"))

        self.assertLess(source.fps, 25.0)
        self.assertAlmostEqual(proxy.fps, 30.0, places=3)
        self.assertAlmostEqual(proxy.start_time_seconds, 0.0, places=3)
        self.assertLessEqual(abs(proxy.duration_seconds - source.duration_seconds), 1 / 30 + 1e-3)

    def test_high_resolution_proxy_is_bounded_to_720p(self):
        proxy = probe_video(create_proxy(self.high_resolution, self.root / "high-resolution-proxy.mp4"))

        self.assertEqual((proxy.width, proxy.height), (1280, 720))


if __name__ == "__main__":
    unittest.main()
