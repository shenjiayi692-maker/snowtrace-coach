from __future__ import annotations

from pathlib import Path

from .contracts import CameraMode, EdgeType, QualityGateResult, Stance, TravelDirection, VideoAnalysisResult, VideoRole, ViewAngle
from .metrics import compute_metric_series
from .phases import detect_turns
from .pose import extract_tracks, rider_candidates, selection_is_ambiguous
from .quality import build_quality_gate
from .video import create_proxy, estimate_camera_stability, probe_video, sample_visual_quality


class AnalysisPipeline:
    def __init__(
        self,
        model_path: str | Path,
        work_dir: str | Path,
        quality_seed: int | None = None,
    ):
        self.model_path = Path(model_path).resolve()
        self.work_dir = Path(work_dir).resolve()
        self.work_dir.mkdir(parents=True, exist_ok=True)
        # Jitter seed for quality frame sampling. None draws fresh offsets per
        # run, which is what makes the sample positions unguessable; pass an int
        # to make a run reproducible. The eval pins it so its ladder is
        # deterministic without production inheriting fixed, derivable
        # positions -- the exact weakness that made the old sampler evadable.
        self.quality_seed = quality_seed

    def analyze_video(
        self,
        source: str | Path,
        *,
        role: VideoRole,
        camera_mode: CameraMode,
        stance: Stance = "regular",
        view_angle: ViewAngle = "three-quarter",
        travel_direction: TravelDirection = "left-to-right",
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
            return VideoAnalysisResult(
                role=role,
                camera_mode=camera_mode,
                view_angle=view_angle,
                metadata=metadata,
                proxy_path=proxy_path,
                selected_track_id=None,
                rider_candidates=[],
                segment_start_ms=None,
                segment_end_ms=None,
                turns=[],
                quality=quality,
                metrics=[],
                status="rejected",
                travel_direction=travel_direction,
            )

        if selected_track_id is None and selection_is_ambiguous(tracks):
            return VideoAnalysisResult(
                role=role,
                camera_mode=camera_mode,
                view_angle=view_angle,
                metadata=metadata,
                proxy_path=proxy_path,
                selected_track_id=None,
                rider_candidates=candidates,
                segment_start_ms=None,
                segment_end_ms=None,
                turns=[],
                quality=None,
                metrics=[],
                status="needs_rider",
                travel_direction=travel_direction,
            )

        if selected_track_id is None:
            selected = tracks[0]
        else:
            selected = next((track for track in tracks if track.track_id == selected_track_id), None)
            if selected is None:
                raise ValueError("The selected rider track is no longer available.")
        turns = detect_turns(selected, first_edge)
        # Sharpness is a property of what the rider filmed, so it is measured on
        # the source. Measuring it on the proxy scored the pipeline's own
        # rescaling: on a 568x320 clip the proxy upscale dropped Laplacian
        # variance from 246.8 to 21.8 -- blur_score 61.7 to 5.4 -- and the gate
        # then told the rider to avoid digital zoom for a softness the upscale
        # had introduced. Interpolation invents no detail, so any source below
        # the proxy bound was permanently capped at `limited`.
        #
        # Fall back to the proxy when the source yields nothing: the proxy is
        # always H.264, while the source may be a codec this OpenCV build cannot
        # open. Camera stability stays on the proxy deliberately -- it needs the
        # normalized CFR 30 timebase to compare frames a fixed interval apart.
        blur_score, exposure_score = sample_visual_quality(
            metadata.path, seed=self.quality_seed
        )
        if (blur_score, exposure_score) == (0.0, 0.0):
            blur_score, exposure_score = sample_visual_quality(
                proxy_path, seed=self.quality_seed
            )
        stability_score = estimate_camera_stability(proxy_path)
        quality = build_quality_gate(
            selected,
            turns,
            blur_score=blur_score,
            exposure_score=exposure_score,
            stability_score=stability_score,
            camera_mode=camera_mode,
            view_angle=view_angle,
            stance=stance,
        )
        metrics = compute_metric_series(selected, stance, travel_direction) if quality.status != "rejected" else []
        return VideoAnalysisResult(
            role=role,
            camera_mode=camera_mode,
            view_angle=view_angle,
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
            selected_track=selected,
            travel_direction=travel_direction,
        )
