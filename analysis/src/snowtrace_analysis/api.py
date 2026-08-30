from __future__ import annotations

import os
import hmac
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .comparison import ComparisonError, compare_videos
from .pipeline import AnalysisPipeline

app = FastAPI(
    title="Snowtrace Video Intelligence",
    version="0.1.0",
    description="Turns two signed source videos into quality-gated comparison evidence.",
)


class ClipRequest(BaseModel):
    source_url: str
    first_edge: Literal["heelside", "toeside", "unknown"] = "unknown"
    selected_track_id: int | None = None


class PairAnalysisRequest(BaseModel):
    analysis_id: str = Field(min_length=8, max_length=120)
    reference: ClipRequest
    rider: ClipRequest
    camera_mode: Literal["fixed", "follow"] = "fixed"
    proxy_upload_urls: dict[Literal["reference", "rider"], str] | None = None


class PairAnalysisJobRequest(PairAnalysisRequest):
    callback_url: str


_active_jobs: set[str] = set()
_active_jobs_lock = threading.Lock()


def _positive_int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "pipeline_version": "video-intelligence-v0.2",
        "model": Path(_model_path()).name,
    }


@app.get("/ready")
def ready() -> dict[str, object]:
    checks = {
        "pose_model": Path(_model_path()).is_file(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
    }
    if not all(checks.values()):
        raise HTTPException(503, detail={"status": "not_ready", "checks": checks})
    return {"status": "ready", "checks": checks, "pipeline_version": "video-intelligence-v0.2"}


@app.post("/v1/analyze-pair")
def analyze_pair(request: PairAnalysisRequest) -> dict[str, object]:
    return _run_pair_analysis(request)


@app.post("/v1/jobs", status_code=202)
def queue_pair_analysis(
    request: PairAnalysisJobRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    expected = os.environ.get("SNOWTRACE_JOB_TOKEN")
    if not expected:
        raise HTTPException(503, "The analysis job endpoint is not configured.")
    received = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not received or not hmac.compare_digest(received, expected):
        raise HTTPException(401, "The analysis job is not authorized.")
    _validate_callback_url(request.callback_url)

    with _active_jobs_lock:
        if request.analysis_id in _active_jobs:
            return {"analysis_id": request.analysis_id, "status": "accepted", "reused": True}
        max_active_jobs = _positive_int_env("SNOWTRACE_MAX_ACTIVE_JOBS", 2)
        if len(_active_jobs) >= max_active_jobs:
            raise HTTPException(429, "The analysis worker is at capacity. Retry shortly.", headers={"Retry-After": "15"})
        _active_jobs.add(request.analysis_id)
    background_tasks.add_task(_process_job, request)
    return {"analysis_id": request.analysis_id, "status": "accepted", "reused": False}


def _run_pair_analysis(request: PairAnalysisRequest) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix=f"snowtrace-{request.analysis_id[:24]}-") as temporary:
        root = Path(temporary)
        reference_source = _download_source(request.reference.source_url, root / "reference-source")
        rider_source = _download_source(request.rider.source_url, root / "rider-source")
        pipeline = AnalysisPipeline(_model_path(), root / "artifacts")
        reference = pipeline.analyze_video(
            reference_source,
            role="reference",
            camera_mode=request.camera_mode,
            first_edge=request.reference.first_edge,
            selected_track_id=request.reference.selected_track_id,
        )
        rider = pipeline.analyze_video(
            rider_source,
            role="rider",
            camera_mode=request.camera_mode,
            first_edge=request.rider.first_edge,
            selected_track_id=request.rider.selected_track_id,
        )

        if request.proxy_upload_urls:
            _upload_proxy(reference.proxy_path, request.proxy_upload_urls.get("reference"))
            _upload_proxy(rider.proxy_path, request.proxy_upload_urls.get("rider"))

        response: dict[str, object] = {
            "analysis_id": request.analysis_id,
            "reference": reference.to_dict(),
            "rider": rider.to_dict(),
            "evidence": [],
            "status": _pair_status(reference.status, rider.status),
        }
        if reference.status == "completed" and rider.status == "completed":
            try:
                response["evidence"] = [item.to_dict() for item in compare_videos(reference, rider)]
                response["status"] = "completed"
            except ComparisonError as error:
                response["status"] = "rejected"
                response["error"] = str(error)
        return response


def _process_job(request: PairAnalysisJobRequest) -> None:
    try:
        result = _run_pair_analysis(request)
    except Exception as error:  # The callback owns durable failure state.
        result = {
            "analysis_id": request.analysis_id,
            "status": "failed",
            "error": f"{type(error).__name__}: analysis worker failed",
        }
    try:
        _deliver_callback(request.callback_url, result)
    finally:
        with _active_jobs_lock:
            _active_jobs.discard(request.analysis_id)


def _validate_callback_url(callback_url: str) -> None:
    parsed = urlparse(callback_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(400, "Callback URLs must use HTTPS.")
    allowed_hosts = [host.strip() for host in os.environ.get("SNOWTRACE_CALLBACK_HOSTS", "").split(",") if host.strip()]
    if allowed_hosts and parsed.hostname not in allowed_hosts:
        raise HTTPException(400, "Callback URL host is not allowed.")


def _deliver_callback(callback_url: str, result: dict[str, object]) -> None:
    token = os.environ.get("SNOWTRACE_CALLBACK_TOKEN") or os.environ.get("SNOWTRACE_JOB_TOKEN")
    if not token:
        raise RuntimeError("SNOWTRACE_CALLBACK_TOKEN is required")
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = httpx.post(
                callback_url,
                json=result,
                headers={"authorization": f"Bearer {token}"},
                timeout=30.0,
            )
            response.raise_for_status()
            return
        except httpx.HTTPError as error:
            last_error = error
            if attempt < 2:
                time.sleep(2**attempt)
    raise RuntimeError("Analysis callback delivery failed") from last_error


def _model_path() -> str:
    path = os.environ.get("SNOWTRACE_POSE_MODEL", "/models/pose_landmarker_lite.task")
    if not Path(path).is_file():
        local = Path(__file__).resolve().parents[2] / "models" / "pose_landmarker_lite.task"
        if local.is_file():
            return str(local)
    return path


def _download_source(source_url: str, destination: Path) -> Path:
    parsed = urlparse(source_url)
    allow_local = os.environ.get("SNOWTRACE_ALLOW_LOCAL_FILES") == "1"
    if parsed.scheme == "file" and allow_local:
        source = Path(parsed.path).resolve()
        if not source.is_file():
            raise HTTPException(400, "The local source file does not exist.")
        destination.write_bytes(source.read_bytes())
        return destination
    if parsed.scheme != "https":
        raise HTTPException(400, "Source URLs must use HTTPS.")
    allowed_hosts = [host.strip() for host in os.environ.get("SNOWTRACE_SOURCE_HOSTS", "").split(",") if host.strip()]
    if allowed_hosts and parsed.hostname not in allowed_hosts:
        raise HTTPException(400, "Source URL host is not allowed.")
    max_source_bytes = _positive_int_env("SNOWTRACE_MAX_SOURCE_BYTES", 100 * 1024 * 1024)
    try:
        with httpx.stream("GET", source_url, follow_redirects=True, timeout=60.0) as response:
            response.raise_for_status()
            content_length = response.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > max_source_bytes:
                        raise HTTPException(413, "The signed source video is too large.")
                except ValueError:
                    pass
            written = 0
            with destination.open("wb") as output:
                for chunk in response.iter_bytes():
                    written += len(chunk)
                    if written > max_source_bytes:
                        raise HTTPException(413, "The signed source video is too large.")
                    output.write(chunk)
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    except httpx.HTTPError as error:
        destination.unlink(missing_ok=True)
        raise HTTPException(400, "The signed source video could not be downloaded.") from error
    return destination


def _upload_proxy(path: Path, upload_url: str | None) -> None:
    if not upload_url:
        return
    if urlparse(upload_url).scheme != "https":
        raise HTTPException(400, "Proxy upload URLs must use HTTPS.")
    try:
        with path.open("rb") as source:
            response = httpx.put(upload_url, content=source, headers={"content-type": "video/mp4"}, timeout=60.0)
            response.raise_for_status()
    except (OSError, httpx.HTTPError) as error:
        raise HTTPException(502, "The analysis proxy could not be uploaded.") from error


def _pair_status(reference_status: str, rider_status: str) -> str:
    if "needs_rider" in (reference_status, rider_status):
        return "needs_rider"
    if "rejected" in (reference_status, rider_status):
        return "rejected"
    return "analyzing"
