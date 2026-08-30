from __future__ import annotations

from pathlib import Path

from .contracts import CameraMode, EdgeType, QualityGateResult, VideoAnalysisResult, VideoRole
from .metrics import compute_metric_series
from .phases import detect_turns
from .pose import extract_tracks, rider_candidates, selection_is_ambiguous
from .quality import build_quality_gate
from .video import create_proxy, estimate_camera_stability, probe_video, sample_visual_quality


class AnalysisPipeline:
    def __init__(self, model_path: str | Path, work_dir: str | Path):
        self.model_path = Path(model_path).resolve()
        self.work_dir = Path(work_dir).resolve()
        self.work_dir.mkdir(parents=True, exist_ok=True)

    def analyze_video(
        self,
        source: str | Path,
        *,
        role: VideoRole,
        camera_mode: CameraMode,
        first_edge: EdgeType = "unknown",
        selected_track_id: int | None = None,
    ) -> VideoAnalysisResult:
        metadata = probe_video(source)
        if not 3.0 <= metadata.duration_seconds <= 30.0:
            raise ValueError("Source clip must be between 3 and 30 seconds.")
        proxy_path = self.work_dir / f"{role}-proxy.mp4"
        create_proxy(source, proxy_path)
        tracks, analyzed_frames, _ = extract_tracks(proxy_path, self.model_path, num_poses=4)
        candidates = rider_candidates(tracks, analyzed_frames)
        if not tracks:
            quality = QualityGateResult(
                status="rejected",
                readiness_score=0,
                hard_failures=["rider_not_found"],
                checks=[],
                allowed_metrics=[],
                recapture_instructions=[
                    "Keep one rider large enough to see and continuously inside the frame.",
                    "Use a stable fixed camera and avoid strong backlight or heavy motion blur.",
                ],
            )
            return VideoAnalysisResult(role, camera_mode, metadata, proxy_path, None, [], None, None, [], quality, [], "rejected")

        if selected_track_id is None and selection_is_ambiguous(tracks):
            return VideoAnalysisResult(role, camera_mode, metadata, proxy_path, None, candidates, None, None, [], None, [], "needs_rider")

        if selected_track_id is None:
            selected = tracks[0]
        else:
            selected = next((track for track in tracks if track.track_id == selected_track_id), None)
            if selected is None:
                raise ValueError("The selected rider track is no longer available.")
        turns = detect_turns(selected, first_edge)
        blur_score, exposure_score = sample_visual_quality(proxy_path)
        stability_score = estimate_camera_stability(proxy_path)
        quality = build_quality_gate(
            selected,
            analyzed_frames,
            turns,
            blur_score=blur_score,
            exposure_score=exposure_score,
            stability_score=stability_score,
            camera_mode=camera_mode,
        )
        metrics = compute_metric_series(selected) if quality.status != "rejected" else []
        return VideoAnalysisResult(
            role=role,
            camera_mode=camera_mode,
            metadata=metadata,
            proxy_path=proxy_path,
            selected_track_id=selected.track_id,
            rider_candidates=candidates,
            segment_start_ms=selected.first_timestamp_ms,
            segment_end_ms=selected.last_timestamp_ms,
            turns=turns,
            quality=quality,
            metrics=metrics,
            status="rejected" if quality.status == "rejected" else "completed",
        )
