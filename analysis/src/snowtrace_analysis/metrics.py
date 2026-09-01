from __future__ import annotations

import math

import numpy as np

from .contracts import MetricSeries, RiderTrack, Stance
from .geometry import line_angle, midpoint, safe_angle, signed_axis_projection, wrapped_angle_difference

MIN_LANDMARK_VISIBILITY = 0.50
MIN_METRIC_FRAME_COVERAGE = 0.75
MIN_METRIC_RELIABILITY = 0.65


def metric_landmark_requirements(stance: Stance) -> dict[str, tuple[int, ...]]:
    lead_leg = (23, 25, 27) if stance == "regular" else (24, 26, 28)
    trail_leg = (24, 26, 28) if stance == "regular" else (23, 25, 27)
    return {
        "knee_flexion_lead": lead_leg,
        "knee_flexion_trail": trail_leg,
        "pelvis_height": (11, 12, 23, 24, 27, 28),
        "projected_inclination": (11, 12, 27, 28),
        "fore_aft_pelvis": (23, 24, 27, 28),
        "upper_lower_separation": (11, 12, 23, 24),
        "lead_trail_differential": (*lead_leg, *trail_leg),
    }


def metric_landmark_reliability(track: RiderTrack, stance: Stance) -> dict[str, tuple[float, float]]:
    requirements = metric_landmark_requirements(stance)
    samples = {metric_id: [] for metric_id in requirements}
    for observation in track.observations:
        for metric_id, indices in requirements.items():
            samples[metric_id].append(float(np.min(observation.landmarks[list(indices), 3])))
    return {metric_id: _aggregate_reliability(values) for metric_id, values in samples.items()}


def compute_metric_series(track: RiderTrack, stance: Stance) -> list[MetricSeries]:
    metric_values: dict[str, list[float | None]] = {
        "knee_flexion_lead": [],
        "knee_flexion_trail": [],
        "pelvis_height": [],
        "projected_inclination": [],
        "fore_aft_pelvis": [],
        "upper_lower_separation": [],
        "lead_trail_differential": [],
    }
    requirements = metric_landmark_requirements(stance)
    metric_confidences: dict[str, list[float]] = {metric_id: [] for metric_id in metric_values}
    timestamps: list[int] = []

    for observation in track.observations:
        landmarks = observation.landmarks
        left_knee = safe_angle(landmarks[23], landmarks[25], landmarks[27])
        right_knee = safe_angle(landmarks[24], landmarks[26], landmarks[28])
        lead_knee, trail_knee = (left_knee, right_knee) if stance == "regular" else (right_knee, left_knee)
        lead_ankle, trail_ankle = (
            (landmarks[27], landmarks[28]) if stance == "regular" else (landmarks[28], landmarks[27])
        )
        hip = midpoint(landmarks[23], landmarks[24])
        shoulder = midpoint(landmarks[11], landmarks[12])
        ankle = midpoint(landmarks[27], landmarks[28])
        torso = float(np.linalg.norm(shoulder[:2] - hip[:2]))
        ankle_axis = lead_ankle[:2] - trail_ankle[:2]
        ankle_span = float(np.linalg.norm(ankle_axis))

        pelvis_height = float(np.linalg.norm(hip[:2] - ankle[:2]) / torso) if torso > 1e-5 else float("nan")
        body_vector = shoulder[:2] - ankle[:2]
        inclination = math.degrees(math.atan2(float(body_vector[0]), float(-body_vector[1]))) if np.linalg.norm(body_vector) > 1e-5 else float("nan")
        fore_aft = signed_axis_projection(hip, ankle, ankle_axis) / ankle_span if ankle_span > 1e-5 else float("nan")
        shoulder_axis_angle = line_angle(landmarks[11], landmarks[12])
        hip_axis_angle = line_angle(landmarks[23], landmarks[24])
        separation = wrapped_angle_difference(shoulder_axis_angle, hip_axis_angle)

        values = {
            "knee_flexion_lead": lead_knee,
            "knee_flexion_trail": trail_knee,
            "pelvis_height": pelvis_height,
            "projected_inclination": inclination,
            "fore_aft_pelvis": fore_aft,
            "upper_lower_separation": separation,
            "lead_trail_differential": lead_knee - trail_knee,
        }
        for metric_id, value in values.items():
            landmark_confidence = float(np.min(landmarks[list(requirements[metric_id]), 3]))
            reliable = landmark_confidence >= MIN_LANDMARK_VISIBILITY and np.isfinite(value)
            metric_values[metric_id].append(round(float(value), 5) if reliable else None)
            metric_confidences[metric_id].append(landmark_confidence if reliable else 0.0)
        timestamps.append(observation.timestamp_ms)

    units = {
        "knee_flexion_lead": "degrees",
        "knee_flexion_trail": "degrees",
        "pelvis_height": "torso_lengths",
        "projected_inclination": "degrees",
        "fore_aft_pelvis": "ankle_spans",
        "upper_lower_separation": "degrees",
        "lead_trail_differential": "degrees",
    }
    return [
        MetricSeries(
            metric_id,
            timestamps.copy(),
            values,
            round(_aggregate_reliability(metric_confidences[metric_id])[1], 4),
            units[metric_id],
        )
        for metric_id, values in metric_values.items()
    ]


def _aggregate_reliability(confidences: list[float]) -> tuple[float, float]:
    if not confidences:
        return 0.0, 0.0
    valid = [value for value in confidences if value >= MIN_LANDMARK_VISIBILITY]
    coverage = len(valid) / len(confidences)
    if not valid:
        return coverage, 0.0
    reliability = float(np.mean(valid)) * float(np.sqrt(coverage))
    return coverage, reliability
