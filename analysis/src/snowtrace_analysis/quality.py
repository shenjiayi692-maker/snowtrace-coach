from __future__ import annotations

import numpy as np

from .contracts import QualityCheck, QualityGateResult, RiderTrack, Turn

FULL_METRICS = [
    "knee_flexion_lead",
    "knee_flexion_trail",
    "pelvis_height",
    "projected_inclination",
    "fore_aft_pelvis",
    "upper_lower_separation",
    "lead_trail_differential",
    "turn_timing",
    "turn_consistency",
]


def build_quality_gate(
    track: RiderTrack,
    analyzed_frames: int,
    turns: list[Turn],
    *,
    blur_score: float,
    exposure_score: float,
    stability_score: float,
    camera_mode: str,
) -> QualityGateResult:
    observations = track.observations
    coverage = len(observations) / max(1, analyzed_frames)
    visibility = float(np.mean([item.mean_visibility for item in observations])) if observations else 0.0
    bbox_height = float(np.median([item.bbox[3] - item.bbox[1] for item in observations])) if observations else 0.0
    gap_ratio = _gap_ratio(track)
    turn_score = min(100.0, len(turns) / 3.0 * 100.0)
    checks = [
        _check("pose_coverage", "Rider visibility", coverage * 100.0, 25.0, f"Pose present in {coverage:.0%} of sampled frames"),
        _check("full_body", "Full-body visibility", visibility * 100.0, 20.0, f"Critical landmark confidence {visibility:.0%}"),
        _check("rider_size", "Rider size", min(100.0, bbox_height / 0.35 * 100.0), 15.0, f"Median rider height {bbox_height:.0%} of frame"),
        _check("motion_blur", "Motion clarity", blur_score, 10.0, "Median Laplacian frame clarity"),
        _check("occlusion", "Occlusion continuity", max(0.0, 100.0 - gap_ratio * 180.0), 10.0, f"Pose gap ratio {gap_ratio:.0%}"),
        _check("turns", "Usable turns", turn_score, 10.0, f"{len(turns)} candidate turns"),
        _check("stability", "Camera stability", stability_score, 5.0, f"{camera_mode} camera motion proxy"),
        _check("exposure", "Exposure", exposure_score, 5.0, "Snow and rider tonal separation"),
    ]
    readiness = round(sum(check.score * check.weight for check in checks) / sum(check.weight for check in checks))
    failures: list[str] = []
    instructions: list[str] = []
    if coverage < 0.5:
        failures.append("pose_coverage")
        instructions.append("Keep the selected rider continuously inside the frame.")
    if visibility < 0.5:
        failures.append("critical_landmarks")
        instructions.append("Keep shoulders, hips, knees and ankles visible through the full run.")
    if bbox_height < 0.12:
        failures.append("rider_too_small")
        instructions.append("Move the camera closer so the rider occupies at least 20% of frame height.")
    if len(turns) < 2:
        failures.append("insufficient_turns")
        instructions.append("Record at least three connected S-turns.")
    if failures or readiness < 55:
        status = "rejected"
        allowed: list[str] = []
    elif readiness < 75 or camera_mode == "follow":
        status = "limited"
        allowed = [
            "knee_flexion_lead", "knee_flexion_trail", "pelvis_height",
            "upper_lower_separation", "lead_trail_differential", "turn_timing",
        ]
    else:
        status = "full"
        allowed = FULL_METRICS.copy()
    return QualityGateResult(status, readiness, failures, checks, allowed, instructions)


def _check(identifier: str, label: str, score: float, weight: float, detail: str) -> QualityCheck:
    bounded = max(0.0, min(100.0, float(score)))
    status = "good" if bounded >= 75 else "medium" if bounded >= 50 else "blocked"
    return QualityCheck(identifier, label, round(bounded, 2), weight, status, detail)


def _gap_ratio(track: RiderTrack) -> float:
    if len(track.observations) < 2:
        return 1.0
    frames = [item.frame_index for item in track.observations]
    span = frames[-1] - frames[0] + 1
    return max(0.0, 1.0 - len(frames) / max(1, span))
