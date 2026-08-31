import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from snowtrace_analysis import api
from snowtrace_analysis.api import app


class ApiTests(unittest.TestCase):
    def test_health_exposes_pipeline_contract(self):
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["pipeline_version"], "video-intelligence-v0.4")

    def test_ready_checks_runtime_dependencies(self):
        with patch("snowtrace_analysis.api.shutil.which", return_value="/usr/bin/tool"):
            response = TestClient(app).get("/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")

    def test_rejects_non_https_source(self):
        response = TestClient(app).post(
            "/v1/analyze-pair",
            json={
                "analysis_id": "analysis-test-001",
                "camera_mode": "fixed",
                "reference_stance": "regular",
                "rider_stance": "goofy",
                "reference": {"source_url": "http://example.com/reference.mp4"},
                "rider": {"source_url": "http://example.com/rider.mp4"},
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Source URLs must use HTTPS.")

    def test_pair_analysis_preserves_reference_and_rider_stances(self):
        request = api.PairAnalysisRequest(
            analysis_id="analysis-stance-contract",
            camera_mode="fixed",
            reference_stance="goofy",
            rider_stance="regular",
            reference={"source_url": "https://example.com/reference.mp4"},
            rider={"source_url": "https://example.com/rider.mp4"},
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

    def test_job_endpoint_requires_service_token(self):
        payload = {
            "analysis_id": "analysis-job-001",
            "camera_mode": "fixed",
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
            "camera_mode": "fixed",
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
            "camera_mode": "fixed",
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
