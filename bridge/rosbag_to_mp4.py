#!/usr/bin/env python3
"""Convert recorded ROS2 raw or compressed camera topics in an MCAP bag to MP4."""

from __future__ import annotations

import argparse
from fractions import Fraction
import json
import os
from pathlib import Path
import subprocess

import cv2
import numpy as np
import rosbag2_py
from rclpy.serialization import deserialize_message
from sensor_msgs.msg import CompressedImage, Image


TOPICS = {
    "/camera1/image_raw": ("camera1.mp4", "sensor_msgs/msg/Image"),
    "/camera2/image_raw": ("camera2.mp4", "sensor_msgs/msg/Image"),
    # Backward compatibility for older bags recorded from the preview topic.
    "/camera1/image_raw/compressed": ("camera1.mp4", "sensor_msgs/msg/CompressedImage"),
    "/camera2/image_raw/compressed": ("camera2.mp4", "sensor_msgs/msg/CompressedImage"),
}


def decode_image(topic: str, data: bytes) -> np.ndarray | None:
    if topic.endswith("/compressed"):
        message = deserialize_message(data, CompressedImage)
        return cv2.imdecode(np.frombuffer(message.data, dtype=np.uint8), cv2.IMREAD_COLOR)

    message = deserialize_message(data, Image)
    channels = {"mono8": 1, "bgr8": 3, "rgb8": 3, "bgra8": 4, "rgba8": 4}.get(message.encoding)
    if channels is None:
        raise ValueError(f"不支持的图像编码: {message.encoding}")
    row_bytes = int(message.step or message.width * channels)
    raw = np.frombuffer(message.data, dtype=np.uint8)
    expected = int(message.height) * row_bytes
    if raw.size < expected:
        return None
    image = raw[:expected].reshape(int(message.height), row_bytes)[:, :int(message.width) * channels]
    image = image.reshape(int(message.height), int(message.width), channels)
    if message.encoding == "bgr8":
        return image
    if message.encoding == "rgb8":
        return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    if message.encoding == "bgra8":
        return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    if message.encoding == "rgba8":
        return cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
    return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)


def open_reader(bag_dir: Path):
    reader = rosbag2_py.SequentialReader()
    reader.open(
        rosbag2_py.StorageOptions(uri=str(bag_dir), storage_id="mcap"),
        rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr"),
    )
    return reader


def convert(bag_dir: Path, output_dir: Path) -> dict[str, dict[str, object]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for topic, (filename, expected_type) in TOPICS.items():
        reader = open_reader(bag_dir)
        topic_types = {item.name: item.type for item in reader.get_all_topics_and_types()}
        if topic_types.get(topic) != expected_type:
            continue
        if topic.endswith("/compressed") and topic_types.get(topic.removesuffix("/compressed")) == "sensor_msgs/msg/Image":
            continue
        configured_fps = float(os.environ.get("CAMERA_FPS", "30"))
        target_fps = configured_fps if 1.0 <= configured_fps <= 120.0 else 30.0
        output_framerate = Fraction(target_fps).limit_denominator(1001)
        encoder = None
        first_ts: int | None = None
        last_ts = 0
        received_count = 0
        encoded_count = 0
        next_output_frame = 0
        timestamp_offset_ns = 0.0
        previous_image = None
        max_gap_fill = max(1, int(target_fps * 5))
        try:
            while reader.has_next():
                current_topic, data, timestamp = reader.read_next()
                if current_topic != topic:
                    continue
                image = decode_image(topic, data)
                if image is None:
                    continue
                if encoder is None:
                    output = output_dir / filename
                    encoder = subprocess.Popen(
                        [
                            "gst-launch-1.0", "-q", "fdsrc", "fd=0", "!",
                            "rawvideoparse", "format=bgr", f"width={image.shape[1]}",
                            f"height={image.shape[0]}", f"framerate={output_framerate.numerator}/{output_framerate.denominator}", "!",
                            "videoconvert", "!", "video/x-raw,format=I420", "!",
                            "x264enc", "speed-preset=veryfast", "tune=zerolatency",
                            "key-int-max=10", "!", "video/x-h264,profile=baseline", "!", "h264parse", "!",
                            "mp4mux", "faststart=true", "!", "filesink", f"location={output}",
                        ],
                        stdin=subprocess.PIPE,
                    )
                timestamp = int(timestamp)
                if first_ts is None:
                    first_ts = timestamp
                    frame_index = 0
                else:
                    frame_index = max(0, round((timestamp - first_ts - timestamp_offset_ns) * target_fps / 1_000_000_000))
                assert encoder.stdin is not None
                if previous_image is None:
                    encoder.stdin.write(image.tobytes())
                    previous_image = image
                    encoded_count += 1
                    next_output_frame = 1
                elif frame_index >= next_output_frame:
                    gap = frame_index - next_output_frame
                    if gap > max_gap_fill:
                        skipped_frames = gap - max_gap_fill
                        timestamp_offset_ns += skipped_frames * 1_000_000_000 / target_fps
                        frame_index -= skipped_frames
                    while next_output_frame < frame_index:
                        encoder.stdin.write(previous_image.tobytes())
                        encoded_count += 1
                        next_output_frame += 1
                    encoder.stdin.write(image.tobytes())
                    previous_image = image
                    encoded_count += 1
                    next_output_frame = frame_index + 1
                else:
                    # Several frames can land in the same 30 FPS output slot; keep the newest.
                    previous_image = image
                last_ts = timestamp
                received_count += 1
        finally:
            if encoder is not None:
                assert encoder.stdin is not None
                encoder.stdin.close()
                if encoder.wait(timeout=30) != 0:
                    raise RuntimeError(f"H.264 视频编码失败: {filename}")
        if received_count:
            measured_fps = target_fps
            if first_ts is not None and last_ts > first_ts and received_count > 1:
                measured_fps = min(120.0, max(1.0, (received_count - 1) * 1_000_000_000 / (last_ts - first_ts)))
            result[topic] = {
                "file": filename,
                "frames": encoded_count,
                "receivedFrames": received_count,
                "startedAt": first_ts,
                "endedAt": last_ts,
                "fps": target_fps,
                "measuredFps": measured_fps,
                "expectedFps": target_fps,
                "estimatedDropPercent": round(max(0.0, 1.0 - measured_fps / max(1.0, target_fps)) * 100, 1),
                "codec": "h264-baseline",
            }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bag_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.bag_dir
    result = convert(args.bag_dir, output)
    metadata = output / "video_manifest.json"
    metadata.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"videos": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
