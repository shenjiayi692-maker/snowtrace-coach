from __future__ import annotations

import argparse
import json
from pathlib import Path

from .pipeline import AnalysisPipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze one Snowtrace source clip")
    parser.add_argument("video", type=Path)
    parser.add_argument("--role", choices=["reference", "rider"], required=True)
    parser.add_argument("--camera-mode", choices=["fixed", "follow"], default="fixed")
    parser.add_argument("--stance", choices=["regular", "goofy"], default="regular")
    parser.add_argument("--first-edge", choices=["heelside", "toeside", "unknown"], default="unknown")
    parser.add_argument("--track-id", type=int)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path(".snowtrace-work"))
    parser.add_argument("--output", type=Path)
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    pipeline = AnalysisPipeline(arguments.model, arguments.work_dir)
    result = pipeline.analyze_video(
        arguments.video,
        role=arguments.role,
        camera_mode=arguments.camera_mode,
        stance=arguments.stance,
        first_edge=arguments.first_edge,
        selected_track_id=arguments.track_id,
    )
    payload = json.dumps(result.to_dict(), indent=2, ensure_ascii=False)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)


if __name__ == "__main__":
    main()
