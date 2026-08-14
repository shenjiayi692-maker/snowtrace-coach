import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from snowtrace_analysis.api import app


class ApiTests(unittest.TestCase):
    def test_health_exposes_pipeline_contract(self):
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["pipeline_version"], "video-intelligence-v0.1")

    def test_rejects_non_https_source(self):
        response = TestClient(app).post(
            "/v1/analyze-pair",
            json={
                "analysis_id": "analysis-test-001",
                "camera_mode": "fixed",
                "reference": {"source_url": "http://example.com/reference.mp4"},
                "rider": {"source_url": "http://example.com/rider.mp4"},
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Source URLs must use HTTPS.")

    def test_job_endpoint_requires_service_token(self):
        payload = {
            "analysis_id": "analysis-job-001",
            "camera_mode": "fixed",
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


if __name__ == "__main__":
    unittest.main()
