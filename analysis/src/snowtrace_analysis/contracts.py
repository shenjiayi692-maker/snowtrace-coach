from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np

VideoRole = Literal["reference", "rider"]
CameraMode = Literal["fixed", "follow"]
ViewAngle = Literal["three-quarter", "side", "front-rear"]
EdgeType = Literal["heelside", "toeside", "unknown"]
ComparableEdge = Literal["heelside", "toeside"]
TurnPhase = Literal["initiation", "shaping", "apex", "completion"]
Stance = Literal["regular", "goofy"]
QualityStatus = Literal["full", "limited", "rejected"]


@dataclass(slots=True)
class VideoMetadata:
    path: Path
    duration_seconds: float
    fps: float
    width: int
    height: int
    codec: str
    size_bytes: int
    orientation: Literal["landscape", "portrait", "square"]
    rotation_degrees: int = 0
    start_time_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["path"] = str(self.path)
        return result


@dataclass(slots=True)
class PoseObservation:
    frame_index: int
    timestamp_ms: int
    landmarks: np.ndarray
    bbox: tuple[float, float, float, float]
    mean_visibility: float


@dataclass(slots=True)
class RiderTrack:
    track_id: int
    observations: list[PoseObservation] = field(default_factory=list)
    score: float = 0.0

    @property
    def first_timestamp_ms(self) -> int:
        return self.observations[0].timestamp_ms

    @property
    def last_timestamp_ms(self) -> int:
        return self.observations[-1].timestamp_ms


@dataclass(slots=True)
class Turn:
    index: int
    edge_type: EdgeType
    start_ms: int
    apex_ms: int
    end_ms: int
    confidence: float
    marker_source: Literal["automatic", "user"] = "automatic"


@dataclass(slots=True)
class QualityCheck:
    id: str
    label: str
    score: float
    weight: float
    status: Literal["good", "medium", "blocked"]
    detail: str


@dataclass(slots=True)
class QualityGateResult:
    status: QualityStatus
    readiness_score: int
    hard_failures: list[str]
    checks: list[QualityCheck]
    allowed_metrics: list[str]
    recapture_instructions: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class MetricSeries:
    metric_id: str
    timestamps_ms: list[int]
    values: list[float | None]
    confidence: float
    unit: str


@dataclass(slots=True)
class PoseSnapshot:
    timestamp_ms: int
    landmarks: list[dict[str, float]]


@dataclass(slots=True)
class VideoAnalysisResult:
    role: VideoRole
    camera_mode: CameraMode
    view_angle: ViewAngle
    metadata: VideoMetadata
    proxy_path: Path
    selected_track_id: int | None
    rider_candidates: list[dict[str, Any]]
    segment_start_ms: int | None
    segment_end_ms: int | None
    turns: list[Turn]
    quality: QualityGateResult | None
    metrics: list[MetricSeries]
    status: Literal["needs_rider", "rejected", "completed"]
    selected_track: RiderTrack | None = field(default=None, repr=False)
    pipeline_version: str = "video-intelligence-v0.9"

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "camera_mode": self.camera_mode,
            "view_angle": self.view_angle,
            "metadata": self.metadata.to_dict(),
            "proxy_path": str(self.proxy_path),
            "selected_track_id": self.selected_track_id,
            "rider_candidates": self.rider_candidates,
            "segment_start_ms": self.segment_start_ms,
            "segment_end_ms": self.segment_end_ms,
            "turns": [asdict(turn) for turn in self.turns],
            "quality": self.quality.to_dict() if self.quality else None,
            "metrics": [asdict(metric) for metric in self.metrics],
            "status": self.status,
            "pipeline_version": self.pipeline_version,
        }


@dataclass(slots=True)
class ComparisonEvidence:
    metric_id: str
    rank: int
    edge_type: ComparableEdge
    phase: TurnPhase
    reference_value: float
    user_value: float
    difference: float
    effect_size: float
    confidence: float
    reference_timestamp_ms: int
    user_timestamp_ms: int
    unit: str
    paired_turns: int
    reference_pose: PoseSnapshot | None = None
    user_pose: PoseSnapshot | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
