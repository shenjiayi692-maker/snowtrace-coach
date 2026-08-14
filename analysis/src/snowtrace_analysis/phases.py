from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .contracts import EdgeType, RiderTrack, Turn
from .geometry import midpoint


@dataclass(slots=True)
class PhaseSignal:
    timestamps_ms: np.ndarray
    values: np.ndarray
    confidence: float


def build_lateral_signal(track: RiderTrack) -> PhaseSignal:
    timestamps: list[int] = []
    values: list[float] = []
    confidences: list[float] = []
    for observation in track.observations:
        landmarks = observation.landmarks
        hip = midpoint(landmarks[23], landmarks[24])
        ankle = midpoint(landmarks[27], landmarks[28])
        shoulder = midpoint(landmarks[11], landmarks[12])
        torso_length = float(np.linalg.norm(shoulder[:2] - hip[:2]))
        if torso_length < 1e-4:
            continue
        timestamps.append(observation.timestamp_ms)
        values.append(float((hip[0] - ankle[0]) / torso_length))
        confidences.append(observation.mean_visibility)
    if len(values) < 5:
        return PhaseSignal(np.array(timestamps), np.array(values), 0.0)
    array = np.asarray(values, dtype=float)
    time = np.arange(len(array), dtype=float)
    trend = np.polyval(np.polyfit(time, array, 1), time)
    detrended = array - trend
    smoothed = moving_average(detrended, 7)
    return PhaseSignal(np.asarray(timestamps, dtype=int), smoothed, float(np.mean(confidences)))


def detect_turns(track: RiderTrack, first_edge: EdgeType = "unknown") -> list[Turn]:
    signal = build_lateral_signal(track)
    if len(signal.values) < 9:
        return []
    sample_delta_ms = float(np.median(np.diff(signal.timestamps_ms)))
    min_distance = max(3, int(round(650.0 / max(sample_delta_ms, 1.0))))
    amplitude = float(np.percentile(signal.values, 90) - np.percentile(signal.values, 10))
    prominence = max(0.035, amplitude * 0.16)
    extrema = _local_extrema(signal.values, min_distance, prominence)
    if len(extrema) < 2:
        return []

    edges = _edge_sequence(len(extrema), first_edge)
    turns: list[Turn] = []
    for index, apex_index in enumerate(extrema):
        if index == 0:
            start_index = max(0, apex_index - (extrema[index + 1] - apex_index) // 2)
        else:
            start_index = (extrema[index - 1] + apex_index) // 2
        if index == len(extrema) - 1:
            end_index = min(len(signal.values) - 1, apex_index + (apex_index - extrema[index - 1]) // 2)
        else:
            end_index = (apex_index + extrema[index + 1]) // 2
        if end_index - start_index < min_distance // 2:
            continue
        local_amplitude = abs(float(signal.values[apex_index] - (signal.values[start_index] + signal.values[end_index]) / 2.0))
        confidence = min(1.0, signal.confidence * 0.65 + min(1.0, local_amplitude / max(prominence, 1e-6)) * 0.35)
        turns.append(Turn(
            index=len(turns),
            edge_type=edges[index],
            start_ms=int(signal.timestamps_ms[start_index]),
            apex_ms=int(signal.timestamps_ms[apex_index]),
            end_ms=int(signal.timestamps_ms[end_index]),
            confidence=round(confidence, 4),
        ))
    return turns


def moving_average(values: np.ndarray, window: int) -> np.ndarray:
    if len(values) < 3:
        return values.copy()
    window = min(window, len(values) if len(values) % 2 else len(values) - 1)
    window = max(3, window)
    padding = window // 2
    padded = np.pad(values, (padding, padding), mode="edge")
    return np.convolve(padded, np.ones(window) / window, mode="valid")


def _local_extrema(values: np.ndarray, min_distance: int, prominence: float) -> list[int]:
    candidates: list[tuple[int, float]] = []
    for index in range(1, len(values) - 1):
        is_peak = values[index] > values[index - 1] and values[index] >= values[index + 1]
        is_trough = values[index] < values[index - 1] and values[index] <= values[index + 1]
        if not (is_peak or is_trough):
            continue
        radius = min(min_distance, index, len(values) - index - 1)
        if radius < 2:
            continue
        neighborhood = values[index - radius:index + radius + 1]
        local_prominence = abs(float(values[index] - np.median(neighborhood)))
        if local_prominence >= prominence:
            candidates.append((index, local_prominence))
    selected: list[tuple[int, float]] = []
    for candidate in sorted(candidates, key=lambda item: item[1], reverse=True):
        if all(abs(candidate[0] - existing[0]) >= min_distance for existing in selected):
            selected.append(candidate)
    return sorted(index for index, _ in selected)


def _edge_sequence(count: int, first_edge: EdgeType) -> list[EdgeType]:
    if first_edge == "unknown":
        return ["unknown"] * count
    other: EdgeType = "toeside" if first_edge == "heelside" else "heelside"
    return [first_edge if index % 2 == 0 else other for index in range(count)]
