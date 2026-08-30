from __future__ import annotations

from collections import defaultdict

import numpy as np

from .contracts import ComparisonEvidence, MetricSeries, PoseSnapshot, RiderTrack, Turn, VideoAnalysisResult

MINIMUM_MEANINGFUL_DIFFERENCE = {
    "knee_flexion_lead": 8.0,
    "knee_flexion_trail": 8.0,
    "pelvis_height": 0.08,
    "projected_inclination": 8.0,
    "fore_aft_pelvis": 0.08,
    "upper_lower_separation": 8.0,
    "lead_trail_differential": 8.0,
}

PHASE_WINDOWS = {
    "initiation": (0, 20),
    "shaping": (20, 45),
    "apex": (45, 60),
    "completion": (60, 100),
}


class ComparisonError(RuntimeError):
    pass


def compare_videos(reference: VideoAnalysisResult, rider: VideoAnalysisResult) -> list[ComparisonEvidence]:
    if reference.status != "completed" or rider.status != "completed":
        raise ComparisonError("Both videos must complete the quality gate before comparison.")
    if not reference.quality or not rider.quality:
        raise ComparisonError("Quality results are required.")
    if reference.quality.status == "rejected" or rider.quality.status == "rejected":
        raise ComparisonError("Rejected videos cannot be compared.")

    allowed = set(reference.quality.allowed_metrics) & set(rider.quality.allowed_metrics)
    reference_metrics = {metric.metric_id: metric for metric in reference.metrics}
    rider_metrics = {metric.metric_id: metric for metric in rider.metrics}
    evidence: list[ComparisonEvidence] = []
    for metric_id in sorted(allowed & reference_metrics.keys() & rider_metrics.keys()):
        if metric_id not in MINIMUM_MEANINGFUL_DIFFERENCE:
            continue
        item = _compare_metric(
            reference_metrics[metric_id],
            rider_metrics[metric_id],
            reference.turns,
            rider.turns,
            MINIMUM_MEANINGFUL_DIFFERENCE[metric_id],
        )
        if item and item.confidence >= 0.70 and item.effect_size >= 1.0 and item.paired_turns >= 2:
            item.reference_pose = _pose_snapshot(reference.selected_track, item.reference_timestamp_ms)
            item.user_pose = _pose_snapshot(rider.selected_track, item.user_timestamp_ms)
            evidence.append(item)

    evidence.sort(key=lambda item: item.effect_size * item.confidence, reverse=True)
    for index, item in enumerate(evidence, start=1):
        item.rank = index
    return evidence


def _compare_metric(
    reference: MetricSeries,
    rider: MetricSeries,
    reference_turns: list[Turn],
    rider_turns: list[Turn],
    threshold: float,
) -> ComparisonEvidence | None:
    pairs = _pair_turns(reference_turns, rider_turns)
    reference_curves: list[np.ndarray] = []
    rider_curves: list[np.ndarray] = []
    usable_pairs: list[tuple[Turn, Turn]] = []
    for reference_turn, rider_turn in pairs:
        reference_curve = _resample_turn(reference, reference_turn)
        rider_curve = _resample_turn(rider, rider_turn)
        if reference_curve is None or rider_curve is None:
            continue
        reference_curves.append(reference_curve)
        rider_curves.append(rider_curve)
        usable_pairs.append((reference_turn, rider_turn))
    if len(usable_pairs) < 2:
        return None

    reference_template = np.nanmedian(np.stack(reference_curves), axis=0)
    rider_template = np.nanmedian(np.stack(rider_curves), axis=0)
    difference = rider_template - reference_template
    if np.all(np.isnan(difference)):
        return None
    best_phase = "apex"
    best_index = 50
    best_difference = 0.0
    for phase, (start, end) in PHASE_WINDOWS.items():
        window = np.abs(difference[start:end + 1])
        if np.all(np.isnan(window)):
            continue
        local = int(np.nanargmax(window)) + start
        value = float(difference[local])
        if abs(value) > abs(best_difference):
            best_difference = value
            best_phase = phase
            best_index = local

    reference_variability = float(np.nanmedian(np.nanstd(np.stack(reference_curves), axis=0)))
    rider_variability = float(np.nanmedian(np.nanstd(np.stack(rider_curves), axis=0)))
    noise_floor = max(threshold, reference_variability * 1.5, rider_variability * 1.5)
    effect_size = abs(best_difference) / max(noise_floor, 1e-6)
    consistency = _difference_consistency(reference_curves, rider_curves, best_index, best_difference)
    turn_confidence = float(np.mean([min(first.confidence, second.confidence) for first, second in usable_pairs]))
    confidence = min(reference.confidence, rider.confidence) * turn_confidence * consistency
    reference_turn, rider_turn = usable_pairs[len(usable_pairs) // 2]
    return ComparisonEvidence(
        metric_id=reference.metric_id,
        rank=0,
        phase=best_phase,  # type: ignore[arg-type]
        reference_value=round(float(reference_template[best_index]), 5),
        user_value=round(float(rider_template[best_index]), 5),
        difference=round(best_difference, 5),
        effect_size=round(effect_size, 4),
        confidence=round(confidence, 4),
        reference_timestamp_ms=_phase_timestamp(reference_turn, best_index),
        user_timestamp_ms=_phase_timestamp(rider_turn, best_index),
        unit=reference.unit,
        paired_turns=len(usable_pairs),
    )


def _pair_turns(reference_turns: list[Turn], rider_turns: list[Turn]) -> list[tuple[Turn, Turn]]:
    reference_by_edge: dict[str, list[Turn]] = defaultdict(list)
    rider_by_edge: dict[str, list[Turn]] = defaultdict(list)
    for turn in reference_turns:
        reference_by_edge[turn.edge_type].append(turn)
    for turn in rider_turns:
        rider_by_edge[turn.edge_type].append(turn)
    pairs: list[tuple[Turn, Turn]] = []
    for edge in ("heelside", "toeside", "unknown"):
        pairs.extend(zip(reference_by_edge[edge], rider_by_edge[edge]))
    return pairs


def _resample_turn(series: MetricSeries, turn: Turn) -> np.ndarray | None:
    timestamps = np.asarray(series.timestamps_ms, dtype=float)
    values = np.asarray([np.nan if value is None else value for value in series.values], dtype=float)
    mask = (timestamps >= turn.start_ms) & (timestamps <= turn.end_ms) & np.isfinite(values)
    if np.count_nonzero(mask) < 4:
        return None
    source_time = timestamps[mask]
    source_values = values[mask]
    target_time = np.linspace(turn.start_ms, turn.end_ms, 101)
    return np.interp(target_time, source_time, source_values)


def _difference_consistency(
    reference_curves: list[np.ndarray],
    rider_curves: list[np.ndarray],
    index: int,
    template_difference: float,
) -> float:
    expected_sign = np.sign(template_difference)
    if expected_sign == 0:
        return 0.0
    signs = [np.sign(rider[index] - reference[index]) for reference, rider in zip(reference_curves, rider_curves)]
    return float(np.mean([sign == expected_sign for sign in signs]))


def _phase_timestamp(turn: Turn, phase_index: int) -> int:
    return int(round(turn.start_ms + (turn.end_ms - turn.start_ms) * phase_index / 100.0))


def _pose_snapshot(track: RiderTrack | None, timestamp_ms: int) -> PoseSnapshot | None:
    if not track or not track.observations:
        return None
    observation = min(track.observations, key=lambda item: abs(item.timestamp_ms - timestamp_ms))
    landmarks = [
        {
            "x": round(float(np.clip(point[0], 0.0, 1.0)), 5),
            "y": round(float(np.clip(point[1], 0.0, 1.0)), 5),
            "visibility": round(float(np.clip(point[3], 0.0, 1.0)), 4),
        }
        for point in observation.landmarks[:33]
    ]
    if len(landmarks) != 33:
        return None
    return PoseSnapshot(timestamp_ms=observation.timestamp_ms, landmarks=landmarks)
