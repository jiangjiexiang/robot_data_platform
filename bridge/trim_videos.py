#!/usr/bin/env python3
"""Trim generated camera MP4 files to a shared time interval."""
from __future__ import annotations
import argparse
from pathlib import Path
import cv2

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for source in sorted(args.source.glob("camera*.mp4")):
        capture = cv2.VideoCapture(str(source))
        fps = capture.get(cv2.CAP_PROP_FPS) or 10.0
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if width <= 0 or height <= 0:
            capture.release()
            continue
        writer = cv2.VideoWriter(str(args.output / source.name), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
        first = max(0, int(args.start * fps))
        last = max(first, int(args.end * fps))
        capture.set(cv2.CAP_PROP_POS_FRAMES, first)
        index = first
        while index <= last:
            ok, frame = capture.read()
            if not ok:
                break
            writer.write(frame)
            index += 1
        writer.release()
        capture.release()

if __name__ == "__main__":
    main()
