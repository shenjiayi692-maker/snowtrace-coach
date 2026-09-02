import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from snowtrace_analysis import api
from snowtrace_analysis.api import app


class ApiTests(unittest.TestCase):
    def test_health_exposes_pipeline_contract(self):
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["pipeline_version"], "video-intelligence-v1.0")

    def test_ready_checks_runtime_dependencies(self):
        with patch("snowtrace_analysis.api.shutil.which", return_value="/usr/bin/tool"):
            response = TestClient(app).get("/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")

    def test_rejects_non_https_source(self):
        with patch.dict("os.environ", {"SNOWTRACE_JOB_TOKEN": "secret-token"}, clear=False):
            response = TestClient(app).post(
                "/v1/analyze-pair",
                headers={"authorization": "Bearer secret-token"},
                json={
                    "analysis_id": "analysis-test-001",
                    "reference_camera_mode": "follow",
                    "rider_camera_mode": "fixed",
                    "reference_view_angle": "three-quarter",
                    "rider_view_angle": "three-quarter",
                    "reference_stance": "regular",
                    "rider_stance": "goofy",
                    "reference": {"source_url": "http://example.com/reference.mp4"},
                    "rider": {"source_url": "http://example.com/rider.mp4"},
                },
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Source URLs must use HTTPS.")

    def test_sync_endpoint_requires_service_token(self):
        payload = {
            "analysis_id": "analysis-sync-auth",
            "reference_camera_mode": "fixed",
            "rider_camera_mode": "fixed",
            "reference_view_angle": "side",
            "rider_view_angle": "side",
            "reference_stance": "regular",
            "rider_stance": "regular",
            "reference": {"source_url": "https://example.com/reference.mp4"},
            "rider": {"source_url": "https://example.com/rider.mp4"},
        }
        with patch.dict("os.environ", {"SNOWTRACE_JOB_TOKEN": "secret-token"}, clear=False):
            response = TestClient(app).post("/v1/analyze-pair", json=payload)
        self.assertEqual(response.status_code, 401)

    def test_analysis_id_rejects_path_characters(self):
        payload = {
            "analysis_id": "../../unsafe-analysis",
            "reference_camera_mode": "fixed",
            "rider_camera_mode": "fixed",
            "reference_view_angle": "side",
            "rider_view_angle": "side",
            "reference_stance": "regular",
            "rider_stance": "regular",
            "reference": {"source_url": "https://example.com/reference.mp4"},
            "rider": {"source_url": "https://example.com/rider.mp4"},
        }
        response = TestClient(app).post("/v1/analyze-pair", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_source_download_does_not_follow_redirects(self):
        response = MagicMock()
        response.headers = {}
        response.iter_bytes.return_value = [b"video"]
        stream = MagicMock()
        stream.__enter__.return_value = response
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "source"
            with (
                patch.dict("os.environ", {"SNOWTRACE_SOURCE_HOSTS": "example.com"}, clear=False),
                patch("snowtrace_analysis.api.httpx.stream", return_value=stream) as mocked_stream,
            ):
                result = api._download_source("https://example.com/source", destination)
            self.assertEqual(result.read_bytes(), b"video")
        self.assertFalse(mocked_stream.call_args.kwargs["follow_redirects"])

    def test_proxy_upload_honors_media_host_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            proxy = Path(temporary) / "proxy.mp4"
            proxy.write_bytes(b"proxy")
            with patch.dict("os.environ", {"SNOWTRACE_SOURCE_HOSTS": "coach.example.com"}, clear=False):
                with self.assertRaisesRegex(HTTPException, "host is not allowed"):
                    api._upload_proxy(proxy, "https://attacker.example/proxy")

    def test_pair_analysis_preserves_each_video_context(self):
        request = api.PairAnalysisRequest(
            analysis_id="analysis-stance-contract",
            reference_camera_mode="follow",
            rider_camera_mode="fixed",
            reference_view_angle="side",
            rider_view_angle="side",
            reference_stance="goofy",
            rider_stance="regular",
            reference_travel_direction="right-to-left",
            rider_travel_direction="left-to-right",
            reference={"source_url": "https://example.com/reference.mp4", "first_edge": "toeside"},
            rider={"source_url": "https://example.com/rider.mp4", "first_edge": "heelside"},
        )
        reference_result = MagicMock(status="needs_rider", proxy_path=Path("reference-proxy.mp4"))
        rider_result = MagicMock(status="completed", proxy_path=Path("rider-proxy.mp4"))
        reference_result.to_dict.return_value = {"status": "needs_rider"}
        rider_result.to_dict.return_value = {"status": "completed"}
        pipeline = MagicMock()
        pipeline.analyze_video.side_effect = [reference_result, rider_result]

        with (
            patch("snowtrace_analysis.api._download_source", side_effect=[Path("reference.mp4"), Path("rider.mp4")]),
            patch("snowtrace_analysis.api.AnalysisPipeline", return_value=pipeline),
        ):
            result = api._run_pair_analysis(request)

        self.assertEqual(result["status"], "needs_rider")
        self.assertEqual(pipeline.analyze_video.call_args_list[0].kwargs["stance"], "goofy")
        self.assertEqual(pipeline.analyze_video.call_args_list[1].kwargs["stance"], "regular")
        self.assertEqual(pipeline.analyze_video.call_args_list[0].kwargs["camera_mode"], "follow")
        self.assertEqual(pipeline.analyze_video.call_args_list[1].kwargs["camera_mode"], "fixed")
        self.assertEqual(pipeline.analyze_video.call_args_list[0].kwargs["view_angle"], "side")
        self.assertEqual(pipeline.analyze_video.call_args_list[1].kwargs["view_angle"], "side")
        self.assertEqual(pipeline.analyze_video.call_args_list[0].kwargs["first_edge"], "toeside")
        self.assertEqual(pipeline.analyze_video.call_args_list[1].kwargs["first_edge"], "heelside")
        self.assertEqual(pipeline.analyze_video.call_args_list[0].kwargs["travel_direction"], "right-to-left")
        self.assertEqual(pipeline.analyze_video.call_args_list[1].kwargs["travel_direction"], "left-to-right")

    def test_pair_contract_rejects_mismatched_views_before_analysis(self):
        response = TestClient(app).post(
            "/v1/analyze-pair",
            json={
                "analysis_id": "analysis-view-mismatch",
                "reference_camera_mode": "fixed",
                "rider_camera_mode": "fixed",
                "reference_view_angle": "side",
                "rider_view_angle": "three-quarter",
                "reference_stance": "regular",
                "rider_stance": "regular",
                "reference": {"source_url": "https://example.com/reference.mp4"},
                "rider": {"source_url": "https://example.com/rider.mp4"},
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("same declared view", response.text)

    def test_job_endpoint_requires_service_token(self):
        payload = {
            "analysis_id": "analysis-job-001",
            "reference_camera_mode": "follow",
            "rider_camera_mode": "fixed",
            "reference_view_angle": "three-quarter",
            "rider_view_angle": "three-quarter",
            "reference_stance": "regular",
            "rider_stance": "goofy",
            "reference": {"source_url": "https://example.com/reference.mp4"},
            "rider": {"source_url": "https://example.com/rider.mp4"},
            "callback_url": "https://coach.example.com/api/analysis-callback/analysis-job-001",
        }
        with patch.dict("os.environ", {"SNOWTRACE_JOB_TOKEN": "secret-token"}, clear=False):
            response = TestClient(app).post("/v1/jobs", json=payload)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "The analysis job is not authorized.")

    def test_job_endpoint_rejects_insecure_callback(self):
        payload = {
            "analysis_id": "analysis-job-002",
            "reference_camera_mode": "follow",
            "rider_camera_mode": "fixed",
            "reference_view_angle": "three-quarter",
            "rider_view_angle": "three-quarter",
            "reference_stance": "regular",
            "rider_stance": "goofy",
            "reference": {"source_url": "https://example.com/reference.mp4"},
            "rider": {"source_url": "https://example.com/rider.mp4"},
            "callback_url": "http://coach.example.com/api/analysis-callback/analysis-job-002",
        }
        with patch.dict("os.environ", {"SNOWTRACE_JOB_TOKEN": "secret-token"}, clear=False):
            response = TestClient(app).post(
                "/v1/jobs",
                headers={"authorization": "Bearer secret-token"},
                json=payload,
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Callback URLs must use HTTPS.")

    def test_job_endpoint_limits_active_work(self):
        payload = {
            "analysis_id": "analysis-job-capacity",
            "reference_camera_mode": "follow",
            "rider_camera_mode": "fixed",
            "reference_view_angle": "three-quarter",
            "rider_view_angle": "three-quarter",
            "reference_stance": "regular",
            "rider_stance": "goofy",
            "reference": {"source_url": "https://example.com/reference.mp4"},
            "rider": {"source_url": "https://example.com/rider.mp4"},
            "callback_url": "https://coach.example.com/api/analysis-callback/analysis-job-capacity",
        }
        api._active_jobs.add("already-running")
        try:
            with patch.dict("os.environ", {"SNOWTRACE_JOB_TOKEN": "secret-token", "SNOWTRACE_MAX_ACTIVE_JOBS": "1"}, clear=False):
                response = TestClient(app).post(
                    "/v1/jobs",
                    headers={"authorization": "Bearer secret-token"},
                    json=payload,
                )
        finally:
            api._active_jobs.discard("already-running")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["retry-after"], "15")


if __name__ == "__main__":
    unittest.main()
