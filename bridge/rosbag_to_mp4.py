#!/usr/bin/env python3
"""Convert recorded ROS2 raw or compressed camera topics in an MCAP bag to MP4."""

from __future__ import annotations

import argparse
import json
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
    # Backward compatibility for bags recorded before raw capture was enabled.
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


def convert(bag_dir: Path, output_dir: Path) -> dict[str, dict[str, object]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for topic, (filename, expected_type) in TOPICS.items():
        reader = rosbag2_py.SequentialReader()
        reader.open(
            rosbag2_py.StorageOptions(uri=str(bag_dir), storage_id="mcap"),
            rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr"),
        )
        topic_types = {item.name: item.type for item in reader.get_all_topics_and_types()}
        if topic_types.get(topic) != expected_type:
            continue
        if topic.endswith("/compressed") and topic_types.get(topic.removesuffix("/compressed")) == "sensor_msgs/msg/Image":
            continue
        encoder = None
        first_ts = last_ts = 0
        count = 0
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
                            f"height={image.shape[0]}", "framerate=10/1", "!",
                            "videoconvert", "!", "video/x-raw,format=I420", "!",
                            "x264enc", "speed-preset=veryfast", "tune=zerolatency",
                            "key-int-max=10", "!", "video/x-h264,profile=baseline", "!", "h264parse", "!",
                            "mp4mux", "faststart=true", "!", "filesink", f"location={output}",
                        ],
                        stdin=subprocess.PIPE,
                    )
                    first_ts = int(timestamp)
                assert encoder.stdin is not None
                encoder.stdin.write(image.tobytes())
                last_ts = int(timestamp)
                count += 1
        finally:
            if encoder is not None:
                assert encoder.stdin is not None
                encoder.stdin.close()
                if encoder.wait(timeout=30) != 0:
                    raise RuntimeError(f"H.264 视频编码失败: {filename}")
        if count:
            result[topic] = {
            "file": filename,
            "frames": count,
            "startedAt": first_ts,
            "endedAt": last_ts,
            "fps": 10,
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
