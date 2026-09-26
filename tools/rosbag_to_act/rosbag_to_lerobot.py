#!/usr/bin/env python3
"""Convert synchronized SO-101 ROS2 MCAP episodes into a LeRobot v3 dataset.

The recorder stores controller targets and actual joint feedback separately.
ACT must learn the former as ``action`` and use the latter as
``observation.state``.  This tool samples all streams onto a fixed clock so
that the resulting LeRobot episode has an honest, constant FPS.
"""

from __future__ import annotations

import argparse
import bisect
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import rosbag2_py
from rclpy.serialization import deserialize_message
from sensor_msgs.msg import Image, JointState
from std_msgs.msg import Float64MultiArray

# Keep the converter self-contained while reusing the repository's LeRobot API
# compatibility layer.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bridge"))
from lerobot_dataset_compat import create_dataset, finalize_dataset


JOINT_NAMES = ["1", "2", "3", "4", "5", "6"]
CAMERA1_TOPIC = "/camera1/image_raw"
CAMERA2_TOPIC = "/camera2/image_raw"
STATE_TOPIC = "/joint_states"
ARM_COMMAND_TOPIC = "/arm_position_controller/commands"
GRIPPER_COMMAND_TOPIC = "/gripper_position_controller/commands"


@dataclass
class Timed:
    timestamp: int
    value: Any


def image_from_message(message: Image) -> np.ndarray:
    channels = {"mono8": 1, "bgr8": 3, "rgb8": 3, "bgra8": 4, "rgba8": 4}.get(message.encoding)
    if channels is None:
        raise ValueError(f"unsupported image encoding: {message.encoding}")
    row_bytes = int(message.step or message.width * channels)
    raw = np.frombuffer(message.data, dtype=np.uint8)
    if raw.size < int(message.height) * row_bytes:
        raise ValueError("truncated image message")
    image = raw[: int(message.height) * row_bytes].reshape(int(message.height), row_bytes)
    image = image[:, : int(message.width) * channels].reshape(int(message.height), int(message.width), channels)
    if message.encoding == "bgr8":
        return image.copy()
    if message.encoding == "rgb8":
        return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    if message.encoding == "bgra8":
        return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    if message.encoding == "rgba8":
        return cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
    return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)


def fixed_joint_state(message: JointState) -> np.ndarray | None:
    values = {name: value for name, value in zip(message.name, message.position)}
    if any(name not in values for name in JOINT_NAMES):
        return None
    return np.asarray([values[name] for name in JOINT_NAMES], dtype=np.float32)


def read_episode(path: Path) -> dict[str, list[Timed]]:
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=str(path), storage_id="mcap"), rosbag2_py.ConverterOptions("cdr", "cdr"))
    topic_types = {item.name: item.type for item in reader.get_all_topics_and_types()}
    required = {
        CAMERA1_TOPIC: "sensor_msgs/msg/Image", CAMERA2_TOPIC: "sensor_msgs/msg/Image",
        STATE_TOPIC: "sensor_msgs/msg/JointState", ARM_COMMAND_TOPIC: "std_msgs/msg/Float64MultiArray",
        GRIPPER_COMMAND_TOPIC: "std_msgs/msg/Float64MultiArray",
    }
    missing = [topic for topic, expected in required.items() if topic_types.get(topic) != expected]
    if missing:
        raise ValueError(f"missing or incompatible topics: {', '.join(missing)}")
    data = {topic: [] for topic in required}
    while reader.has_next():
        topic, raw, timestamp = reader.read_next()
        if topic == CAMERA1_TOPIC or topic == CAMERA2_TOPIC:
            data[topic].append(Timed(timestamp, image_from_message(deserialize_message(raw, Image))))
        elif topic == STATE_TOPIC:
            value = fixed_joint_state(deserialize_message(raw, JointState))
            if value is not None:
                data[topic].append(Timed(timestamp, value))
        elif topic == ARM_COMMAND_TOPIC:
            value = list(deserialize_message(raw, Float64MultiArray).data)
            if len(value) == 5:
                data[topic].append(Timed(timestamp, value))
        elif topic == GRIPPER_COMMAND_TOPIC:
            value = list(deserialize_message(raw, Float64MultiArray).data)
            if len(value) == 1:
                data[topic].append(Timed(timestamp, value[0]))
    return data


def nearest(samples: list[Timed], timestamp: int, max_delta_ns: int) -> Timed | None:
    timestamps = [sample.timestamp for sample in samples]
    index = bisect.bisect_left(timestamps, timestamp)
    candidates = [samples[i] for i in (index - 1, index) if 0 <= i < len(samples)]
    if not candidates:
        return None
    result = min(candidates, key=lambda sample: abs(sample.timestamp - timestamp))
    return result if abs(result.timestamp - timestamp) <= max_delta_ns else None


def previous(samples: list[Timed], timestamp: int, max_age_ns: int) -> Timed | None:
    timestamps = [sample.timestamp for sample in samples]
    index = bisect.bisect_right(timestamps, timestamp) - 1
    if index < 0:
        return None
    result = samples[index]
    return result if timestamp - result.timestamp <= max_age_ns else None


def task_for_episode(path: Path, fallback: str) -> str:
    sidecar = path.with_suffix(".json")
    if not sidecar.is_file():
        return fallback
    try:
        task = json.loads(sidecar.read_text(encoding="utf-8")).get("task", fallback)
        return task if isinstance(task, str) and task.strip() else fallback
    except (OSError, json.JSONDecodeError):
        return fallback


def features(shape: tuple[int, ...]) -> dict[str, dict[str, Any]]:
    return {
        "observation.state": {"dtype": "float32", "shape": (6,), "names": JOINT_NAMES},
        "action": {"dtype": "float32", "shape": (6,), "names": JOINT_NAMES},
        "observation.images.camera1": {"dtype": "video", "shape": shape, "names": ["height", "width", "channel"]},
        "observation.images.camera2": {"dtype": "video", "shape": shape, "names": ["height", "width", "channel"]},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert SO-101 MCAP ROS bags to a LeRobot ACT dataset")
    parser.add_argument("input", type=Path, help="dataset directory containing episode_0000/ directories")
    parser.add_argument("--output", type=Path, help="new LeRobot dataset directory; required unless --dry-run")
    parser.add_argument("--repo-id", default="local/so101_act")
    parser.add_argument("--fps", type=int, default=8, help="fixed training sample rate; source cameras are about 9 Hz")
    parser.add_argument("--task", default="", help="fallback task when episode sidecar has none")
    parser.add_argument("--episodes", nargs="*", type=int, help="episode indexes to convert")
    parser.add_argument("--max-image-skew-ms", type=float, default=90.0)
    parser.add_argument("--max-state-skew-ms", type=float, default=40.0)
    parser.add_argument("--max-command-age-ms", type=float, default=40.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.fps < 1 or args.fps > 30:
        parser.error("--fps must be between 1 and 30")
    if not args.dry_run and args.output is None:
        parser.error("--output is required unless --dry-run")
    episode_paths = sorted(path for path in args.input.glob("episode_*") if path.is_dir())
    if args.episodes is not None:
        wanted = {f"episode_{item:04d}" for item in args.episodes}
        episode_paths = [path for path in episode_paths if path.name in wanted]
    if not episode_paths:
        parser.error("no episode directories found")
    if args.output and args.output.exists() and not args.dry_run:
        parser.error(f"output already exists: {args.output}")

    image_limit = int(args.max_image_skew_ms * 1_000_000)
    state_limit = int(args.max_state_skew_ms * 1_000_000)
    command_limit = int(args.max_command_age_ms * 1_000_000)
    period = round(1_000_000_000 / args.fps)
    dataset = None
    reports = []
    try:
        for episode_path in episode_paths:
            streams = read_episode(episode_path)
            start = max(items[0].timestamp for items in streams.values() if items)
            end = min(items[-1].timestamp for items in streams.values() if items)
            if end <= start:
                raise ValueError(f"{episode_path.name}: streams have no overlapping interval")
            skipped = {"camera1": 0, "camera2": 0, "state": 0, "arm_command": 0, "gripper_command": 0}
            frames = []
            for timestamp in range(start, end + 1, period):
                camera1 = nearest(streams[CAMERA1_TOPIC], timestamp, image_limit)
                camera2 = nearest(streams[CAMERA2_TOPIC], timestamp, image_limit)
                state = nearest(streams[STATE_TOPIC], timestamp, state_limit)
                arm = previous(streams[ARM_COMMAND_TOPIC], timestamp, command_limit)
                gripper = previous(streams[GRIPPER_COMMAND_TOPIC], timestamp, command_limit)
                values = {"camera1": camera1, "camera2": camera2, "state": state, "arm_command": arm, "gripper_command": gripper}
                missing = [name for name, value in values.items() if value is None]
                if missing:
                    for name in missing:
                        skipped[name] += 1
                    continue
                action = np.asarray([*arm.value, gripper.value], dtype=np.float32)
                frames.append((camera1.value, camera2.value, state.value, action))
            report = {"episode": episode_path.name, "duration_s": round((end - start) / 1e9, 3), "frames": len(frames), "skipped": skipped}
            reports.append(report)
            if not frames:
                continue
            if dataset is None and not args.dry_run:
                assert args.output is not None
                dataset = create_dataset(repo_id=args.repo_id, fps=args.fps, root=args.output, robot_type="so101_follower", features=features(frames[0][0].shape), streaming_encoding=True)
            if dataset is not None:
                task = task_for_episode(episode_path, args.task)
                for camera1, camera2, state, action in frames:
                    dataset.add_frame({"observation.state": state, "action": action, "observation.images.camera1": cv2.cvtColor(camera1, cv2.COLOR_BGR2RGB), "observation.images.camera2": cv2.cvtColor(camera2, cv2.COLOR_BGR2RGB), "task": task})
                dataset.save_episode(parallel_encoding=True)
        if dataset is not None:
            finalize_dataset(dataset)
            dataset = None
        print(json.dumps({"input": str(args.input), "output": str(args.output) if args.output else None, "fps": args.fps, "episodes": reports}, ensure_ascii=False, indent=2))
    except Exception:
        if dataset is not None:
            try:
                dataset.clear_episode_buffer(delete_images=True)
                finalize_dataset(dataset)
            except Exception:
                pass
        if args.output and args.output.exists() and not args.dry_run:
            shutil.rmtree(args.output)
        raise


if __name__ == "__main__":
    main()
