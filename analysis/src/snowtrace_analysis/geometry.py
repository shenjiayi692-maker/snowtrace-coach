from __future__ import annotations

import math

import numpy as np


def safe_angle(a: np.ndarray, vertex: np.ndarray, b: np.ndarray) -> float:
    """Return the smaller 2D angle at vertex in degrees."""
    first = np.asarray(a[:2], dtype=float) - np.asarray(vertex[:2], dtype=float)
    second = np.asarray(b[:2], dtype=float) - np.asarray(vertex[:2], dtype=float)
    denominator = np.linalg.norm(first) * np.linalg.norm(second)
    if denominator < 1e-9:
        return float("nan")
    cosine = float(np.clip(np.dot(first, second) / denominator, -1.0, 1.0))
    return math.degrees(math.acos(cosine))


def midpoint(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (np.asarray(a, dtype=float) + np.asarray(b, dtype=float)) / 2.0


def signed_axis_projection(point: np.ndarray, origin: np.ndarray, axis: np.ndarray) -> float:
    axis = np.asarray(axis[:2], dtype=float)
    norm = np.linalg.norm(axis)
    if norm < 1e-9:
        return float("nan")
    return float(np.dot(np.asarray(point[:2]) - np.asarray(origin[:2]), axis / norm))


def line_angle(a: np.ndarray, b: np.ndarray) -> float:
    vector = np.asarray(b[:2], dtype=float) - np.asarray(a[:2], dtype=float)
    if np.linalg.norm(vector) < 1e-9:
        return float("nan")
    return math.degrees(math.atan2(float(vector[1]), float(vector[0])))


def wrapped_angle_difference(first: float, second: float) -> float:
    if not np.isfinite(first) or not np.isfinite(second):
        return float("nan")
    return (first - second + 180.0) % 360.0 - 180.0


def iou(first: tuple[float, float, float, float], second: tuple[float, float, float, float]) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union > 1e-9 else 0.0


def bbox_centroid(box: tuple[float, float, float, float]) -> np.ndarray:
    return np.array([(box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0], dtype=float)
