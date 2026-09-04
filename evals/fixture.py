"""Serialize RiderTrack / Turn fixtures so evals run without video.

The pipeline has no track serializer -- it builds a RiderTrack in memory and
hands it straight to the gate. That is fine in production and unworkable for an
eval, for two reasons:

  1. Re-running MediaPipe + FFmpeg on every CI run is slow and needs a GPU-free
     but still heavy container.
  2. Rider footage cannot be committed to a public repo. Pose landmarks can.

So: run the pipeline once, locally, on real footage; commit the landmarks.

Nothing here hard-codes a field name. Everything goes through dataclasses.fields
and typing.get_type_hints, so it keeps working when contracts.py changes.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path
from types import UnionType
from typing import Any, Union, get_args, get_origin, get_type_hints

import numpy as np

from snowtrace_analysis.contracts import RiderTrack, Turn

SCHEMA = 1


# --- writing ----------------------------------------------------------------

class _Encoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, (np.integer, np.floating)):
            return o.item()
        if isinstance(o, Path):
            return str(o)
        if dataclasses.is_dataclass(o):
            return dataclasses.asdict(o)
        return super().default(o)


def dump(path: Path, track: RiderTrack, turns: list[Turn], **meta: Any) -> None:
    payload = {
        "schema": SCHEMA,
        "meta": meta,
        "track": dataclasses.asdict(track),
        "turns": [dataclasses.asdict(t) for t in turns],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, cls=_Encoder, indent=1), encoding="utf-8")


# --- reading ----------------------------------------------------------------

def _coerce(tp: Any, value: Any) -> Any:
    if value is None:
        return None
    origin = get_origin(tp)

    if origin in (Union, UnionType):
        inner = [a for a in get_args(tp) if a is not type(None)]
        return _coerce(inner[0], value) if len(inner) == 1 else value

    if origin is list:
        args = get_args(tp)
        return [_coerce(args[0], v) for v in value] if args else list(value)

    if origin is tuple:
        args = get_args(tp)
        if len(args) == 2 and args[1] is Ellipsis:
            return tuple(_coerce(args[0], v) for v in value)
        return tuple(_coerce(a, v) for a, v in zip(args, value))

    if dataclasses.is_dataclass(tp):
        return _build(tp, value)

    if tp is Path:
        return Path(value)

    if tp is np.ndarray:
        return np.asarray(value)

    return value


def _build(cls: type, data: dict[str, Any]) -> Any:
    hints = get_type_hints(cls)
    kwargs = {
        f.name: _coerce(hints.get(f.name, Any), data[f.name])
        for f in dataclasses.fields(cls)
        if f.name in data
    }
    missing = [
        f.name for f in dataclasses.fields(cls)
        if f.name not in kwargs
        and f.default is dataclasses.MISSING
        and f.default_factory is dataclasses.MISSING  # type: ignore[misc]
    ]
    if missing:
        raise ValueError(
            f"Fixture is missing required {cls.__name__} fields: {missing}. "
            f"Regenerate it with `python -m evals.fixture capture`."
        )
    return cls(**kwargs)


def load(path: Path) -> tuple[RiderTrack, list[Turn], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != SCHEMA:
        raise ValueError(
            f"Fixture schema {payload.get('schema')} != {SCHEMA}; regenerate it."
        )
    track = _build(RiderTrack, payload["track"])
    turns = [_build(Turn, t) for t in payload["turns"]]
    return track, turns, payload.get("meta", {})


# --- capture CLI ------------------------------------------------------------

def capture(args: argparse.Namespace) -> int:
    """Run the real pipeline once and freeze the track it produced."""
    from snowtrace_analysis.pipeline import AnalysisPipeline

    pipeline = AnalysisPipeline(model_path=args.model, work_dir=args.work_dir)
    result = pipeline.analyze_video(
        args.video,
        role="rider",
        camera_mode=args.camera_mode,
        stance=args.stance,
        view_angle=args.view_angle,
        travel_direction=args.travel_direction,
        first_edge=args.first_edge,
        selected_track_id=args.track_id,
    )

    if result.status == "needs_rider":
        # rider_candidates is list[dict], not a list of objects.
        print(
            "Rider selection is ambiguous in this clip. Re-run with --track-id "
            f"set to one of: {[c['track_id'] for c in result.rider_candidates]}",
            file=sys.stderr,
        )
        return 2
    if result.selected_track is None:
        print(f"No usable track (status={result.status}).", file=sys.stderr)
        return 2

    # A `rejected` gate status still yields a usable track: the pipeline sets
    # selected_track before the gate runs. Capturing a rejected clip is fine and
    # sometimes the point -- L0 needs a track, not a passing verdict.
    dump(
        args.out,
        result.selected_track,
        result.turns,
        source=Path(args.video).name,
        camera_mode=args.camera_mode,
        stance=args.stance,
        view_angle=args.view_angle,
        travel_direction=args.travel_direction,
        first_edge=args.first_edge,
        gate_status=result.quality.status if result.quality else None,
        readiness_score=result.quality.readiness_score if result.quality else None,
        hard_failures=list(result.quality.hard_failures) if result.quality else [],
        turn_count=len(result.turns),
        fps=result.metadata.fps,
        duration_seconds=result.metadata.duration_seconds,
    )
    print(f"Wrote {args.out} ({args.out.stat().st_size / 1024:.0f} KB, "
          f"{len(result.turns)} turns, gate="
          f"{result.quality.status if result.quality else 'n/a'}). "
          f"Commit this; do not commit the video.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="evals.fixture", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    cap = sub.add_parser("capture", help="freeze one clip's track as a fixture")
    cap.add_argument("video", type=Path)
    cap.add_argument("--out", type=Path, required=True)
    cap.add_argument("--model", type=Path, required=True, help="MediaPipe .task model")
    cap.add_argument("--work-dir", type=Path, default=Path(".eval-work"))
    cap.add_argument("--camera-mode", default="fixed", choices=["fixed", "follow"])
    cap.add_argument("--stance", default="regular", choices=["regular", "goofy"])
    cap.add_argument("--view-angle", default="three-quarter",
                     choices=["three-quarter", "side", "front-rear"])
    cap.add_argument("--travel-direction", default="left-to-right",
                     choices=["left-to-right", "right-to-left"])
    cap.add_argument("--first-edge", default="unknown",
                     choices=["heelside", "toeside", "unknown"])
    cap.add_argument("--track-id", type=int, default=None)
    cap.set_defaults(func=capture)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
