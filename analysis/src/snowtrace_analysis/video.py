from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from .contracts import VideoMetadata


class VideoError(RuntimeError):
    pass


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise VideoError(f"Required executable is missing: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip() or "unknown media error"
        raise VideoError(detail) from error


def probe_video(path: str | Path) -> VideoMetadata:
    source = Path(path).resolve()
    if not source.is_file():
        raise VideoError(f"Video does not exist: {source}")
    result = _run([
        "ffprobe",
        "-v", "error",
        "-show_entries",
        "format=duration,size,start_time:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,start_time:stream_tags=rotate:stream_side_data=rotation",
        "-of", "json",
        str(source),
    ])
    payload = json.loads(result.stdout)
    streams = [item for item in payload.get("streams", []) if item.get("codec_type") == "video"]
    if not streams:
        raise VideoError("The file contains no readable video stream.")
    stream = streams[0]
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    rotation = _rotation_degrees(stream)
    if rotation in {90, 270}:
        width, height = height, width
    fps = _frame_rate(stream.get("avg_frame_rate")) or _frame_rate(stream.get("r_frame_rate"))
    format_metadata = payload.get("format", {})
    duration = float(stream.get("duration") or format_metadata.get("duration") or 0)
    start_time = float(stream.get("start_time") or format_metadata.get("start_time") or 0)
    size_bytes = int(format_metadata.get("size") or source.stat().st_size)
    orientation = "landscape" if width > height else "portrait" if height > width else "square"
    return VideoMetadata(
        path=source,
        duration_seconds=duration,
        fps=fps,
        width=width,
        height=height,
        codec=str(stream.get("codec_name") or "unknown"),
        size_bytes=size_bytes,
        orientation=orientation,
        rotation_degrees=rotation,
        start_time_seconds=start_time,
    )


def create_proxy(source: str | Path, destination: str | Path) -> Path:
    source_path = Path(source).resolve()
    source_metadata = probe_video(source_path)
    output = Path(destination).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    filter_graph = (
        "scale=if(gt(iw\\,ih)\\,-2\\,720):if(gt(iw\\,ih)\\,720\\,-2),"
        "fps=30,setpts=PTS-STARTPTS,setsar=1"
    )
    _run([
        "ffmpeg", "-y", "-v", "error", "-autorotate", "-i", str(source_path),
        "-map", "0:v:0", "-an", "-vf", filter_graph,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
        "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0",
        "-movflags", "+faststart", str(output),
    ])
    try:
        _validate_proxy(source_metadata, probe_video(output))
    except VideoError:
        output.unlink(missing_ok=True)
        raise
    return output


def _frame_rate(value: object) -> float:
    numerator, separator, denominator = str(value or "0/1").partition("/")
    try:
        if not separator:
            return max(0.0, float(numerator))
        return max(0.0, float(numerator) / max(float(denominator), 1e-9))
    except ValueError:
        return 0.0


def _rotation_degrees(stream: dict[str, object]) -> int:
    side_data = stream.get("side_data_list")
    if isinstance(side_data, list):
        for item in side_data:
            if isinstance(item, dict) and item.get("rotation") is not None:
                try:
                    return int(round(float(item["rotation"]))) % 360
                except (TypeError, ValueError):
                    pass
    tags = stream.get("tags")
    if isinstance(tags, dict) and tags.get("rotate") is not None:
        try:
            return int(round(float(tags["rotate"]))) % 360
        except (TypeError, ValueError):
            pass
    return 0


def _validate_proxy(source: VideoMetadata, proxy: VideoMetadata) -> None:
    frame_tolerance = 1 / 30 + 0.01
    if abs(proxy.fps - 30.0) > 0.05:
        raise VideoError(f"Analysis proxy must be CFR 30 fps; received {proxy.fps:.3f} fps.")
    if abs(proxy.start_time_seconds) > frame_tolerance:
        raise VideoError(f"Analysis proxy must start at zero; received {proxy.start_time_seconds:.3f}s.")
    if abs(proxy.duration_seconds - source.duration_seconds) > frame_tolerance:
        raise VideoError("Analysis proxy duration drifted by more than one frame.")
    if proxy.rotation_degrees != 0 or proxy.orientation != source.orientation:
        raise VideoError("Analysis proxy display orientation was not normalized.")
    if proxy.orientation == "landscape" and (proxy.width > 1280 or proxy.height > 720):
        raise VideoError("Landscape analysis proxy exceeds the 1280x720 bound.")
    if proxy.orientation == "portrait" and (proxy.width > 720 or proxy.height > 1280):
        raise VideoError("Portrait analysis proxy exceeds the 720x1280 bound.")


def sample_visual_quality(path: str | Path, sample_count: int = 10) -> tuple[float, float]:
    try:
        import cv2
    except ImportError as error:
        raise VideoError("opencv-python-headless is required for frame quality sampling") from error

    capture = cv2.VideoCapture(str(path))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if frame_count <= 0:
        capture.release()
        return 0.0, 0.0
    indices = np.linspace(0, frame_count - 1, min(sample_count, frame_count), dtype=int)
    blur_values: list[float] = []
    exposure_values: list[float] = []
    for index in indices:
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
        ok, frame = capture.read()
        if not ok:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        mean = float(gray.mean())
        blur_values.append(min(100.0, variance / 4.0))
        exposure_values.append(_range_score(mean, 70.0, 205.0, 25.0, 245.0))
    capture.release()
    if not blur_values:
        return 0.0, 0.0
    return float(np.median(blur_values)), float(np.median(exposure_values))


def estimate_camera_stability(path: str | Path, frame_step: int = 8) -> float:
    try:
        import cv2
    except ImportError as error:
        raise VideoError("opencv-python-headless is required for camera stability") from error

    capture = cv2.VideoCapture(str(path))
    previous = None
    flows: list[float] = []
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % frame_step:
            frame_index += 1
            continue
        gray = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
        if previous is not None:
            flow = cv2.calcOpticalFlowFarneback(previous, gray, None, 0.5, 2, 15, 2, 5, 1.1, 0)
            magnitude = np.linalg.norm(flow, axis=2)
            flows.append(float(np.median(magnitude)))
        previous = gray
        frame_index += 1
    capture.release()
    if not flows:
        return 0.0
    median_flow = float(np.median(flows))
    return max(0.0, min(100.0, 100.0 - median_flow * 16.0))


def _range_score(value: float, ideal_min: float, ideal_max: float, hard_min: float, hard_max: float) -> float:
    if value < hard_min or value > hard_max:
        return 0.0
    if ideal_min <= value <= ideal_max:
        return 100.0
    if value < ideal_min:
        return (value - hard_min) / (ideal_min - hard_min) * 100.0
    return (hard_max - value) / (hard_max - ideal_max) * 100.0
