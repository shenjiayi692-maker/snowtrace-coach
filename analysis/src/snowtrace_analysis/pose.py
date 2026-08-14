from __future__ import annotations

from pathlib import Path

import numpy as np

from .contracts import PoseObservation, RiderTrack
from .geometry import bbox_centroid, iou

CRITICAL_LANDMARKS = (11, 12, 23, 24, 25, 26, 27, 28)


class PoseError(RuntimeError):
    pass


def extract_tracks(
    video_path: str | Path,
    model_path: str | Path,
    *,
    num_poses: int = 4,
    frame_stride: int = 1,
) -> tuple[list[RiderTrack], int, float]:
    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as error:
        raise PoseError("MediaPipe and OpenCV are required to extract rider tracks") from error

    model = Path(model_path).resolve()
    if not model.is_file():
        raise PoseError(f"Pose model is missing: {model}")

    capture = cv2.VideoCapture(str(video_path))
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    options = vision.PoseLandmarkerOptions(
        base_options=python.BaseOptions(
            model_asset_path=str(model),
            delegate=python.BaseOptions.Delegate.CPU,
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=num_poses,
        min_pose_detection_confidence=0.45,
        min_pose_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )
    tracks: list[RiderTrack] = []
    frame_index = 0
    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % frame_stride:
                frame_index += 1
                continue
            timestamp_ms = int(round(frame_index / fps * 1000.0))
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms
            )
            observations = [_observation_from_landmarks(frame_index, timestamp_ms, pose) for pose in result.pose_landmarks]
            _assign_observations(tracks, observations)
            frame_index += 1
    capture.release()
    analyzed_frames = max(1, int(np.ceil(total_frames / max(1, frame_stride))))
    for track in tracks:
        coverage = len(track.observations) / analyzed_frames
        bbox_height = np.median([item.bbox[3] - item.bbox[1] for item in track.observations])
        visibility = np.median([item.mean_visibility for item in track.observations])
        track.score = float(coverage * 0.5 + min(1.0, bbox_height / 0.35) * 0.25 + visibility * 0.25)
    tracks.sort(key=lambda item: item.score, reverse=True)
    return tracks, analyzed_frames, fps / max(1, frame_stride)


def _observation_from_landmarks(frame_index: int, timestamp_ms: int, pose: list[object]) -> PoseObservation:
    landmarks = np.array(
        [[float(item.x), float(item.y), float(item.z), float(item.visibility)] for item in pose],
        dtype=np.float32,
    )
    visible = landmarks[landmarks[:, 3] >= 0.25]
    source = visible if len(visible) >= 4 else landmarks
    bbox = (
        float(np.min(source[:, 0])),
        float(np.min(source[:, 1])),
        float(np.max(source[:, 0])),
        float(np.max(source[:, 1])),
    )
    mean_visibility = float(np.mean(landmarks[list(CRITICAL_LANDMARKS), 3]))
    return PoseObservation(frame_index, timestamp_ms, landmarks, bbox, mean_visibility)


def _assign_observations(tracks: list[RiderTrack], observations: list[PoseObservation]) -> None:
    unmatched_tracks = set(range(len(tracks)))
    for observation in observations:
        best_index = None
        best_cost = float("inf")
        for index in unmatched_tracks:
            previous = tracks[index].observations[-1]
            if observation.timestamp_ms - previous.timestamp_ms > 700:
                continue
            overlap_cost = 1.0 - iou(previous.bbox, observation.bbox)
            distance = float(np.linalg.norm(bbox_centroid(previous.bbox) - bbox_centroid(observation.bbox)))
            cost = overlap_cost * 0.62 + min(1.0, distance / 0.35) * 0.38
            if cost < best_cost:
                best_cost = cost
                best_index = index
        if best_index is None or best_cost > 0.84:
            tracks.append(RiderTrack(track_id=len(tracks), observations=[observation]))
        else:
            tracks[best_index].observations.append(observation)
            unmatched_tracks.remove(best_index)


def rider_candidates(tracks: list[RiderTrack], analyzed_frames: int) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for track in tracks[:4]:
        if len(track.observations) < 3:
            continue
        representative = track.observations[len(track.observations) // 2]
        candidates.append(
            {
                "track_id": track.track_id,
                "score": round(track.score, 4),
                "coverage": round(len(track.observations) / max(1, analyzed_frames), 4),
                "median_bbox_height": round(float(np.median([item.bbox[3] - item.bbox[1] for item in track.observations])), 4),
                "representative_frame_ms": representative.timestamp_ms,
                "representative_bbox": [round(float(value), 5) for value in representative.bbox],
            }
        )
    return candidates


def selection_is_ambiguous(tracks: list[RiderTrack]) -> bool:
    useful = [track for track in tracks if len(track.observations) >= 3]
    if len(useful) < 2:
        return False
    return useful[0].score < useful[1].score * 1.15
