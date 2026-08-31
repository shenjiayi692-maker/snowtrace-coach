from __future__ import annotations

import math

import numpy as np

from .contracts import MetricSeries, RiderTrack, Stance
from .geometry import line_angle, midpoint, safe_angle, signed_axis_projection, wrapped_angle_difference


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
    confidences: list[float] = []
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
        vertical = np.array([0.0, -1.0])
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
            metric_values[metric_id].append(round(float(value), 5) if np.isfinite(value) else None)
        timestamps.append(observation.timestamp_ms)
        confidences.append(observation.mean_visibility)

    units = {
        "knee_flexion_lead": "degrees",
        "knee_flexion_trail": "degrees",
        "pelvis_height": "torso_lengths",
        "projected_inclination": "degrees",
        "fore_aft_pelvis": "ankle_spans",
        "upper_lower_separation": "degrees",
        "lead_trail_differential": "degrees",
    }
    confidence = round(float(np.mean(confidences)) if confidences else 0.0, 4)
    return [
        MetricSeries(metric_id, timestamps.copy(), values, confidence, units[metric_id])
        for metric_id, values in metric_values.items()
    ]
