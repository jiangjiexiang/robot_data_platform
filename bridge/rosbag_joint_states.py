#!/usr/bin/env python3
"""Read recorded JointState samples from a ROS2 MCAP bag."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import rosbag2_py
from rclpy.serialization import deserialize_message
from sensor_msgs.msg import JointState

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bag_dir", type=Path)
    args = parser.parse_args()
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=str(args.bag_dir), storage_id="mcap"), rosbag2_py.ConverterOptions("cdr", "cdr"))
    topics = {item.name: item.type for item in reader.get_all_topics_and_types()}
    if topics.get("/joint_states") != "sensor_msgs/msg/JointState":
        print("[]")
        return
    start = None
    samples = []
    while reader.has_next():
        topic, data, timestamp = reader.read_next()
        if topic != "/joint_states":
            continue
        message = deserialize_message(data, JointState)
        if start is None:
            start = int(timestamp)
        values = {
            name: ((float(position) / 1.20753769 + 1.0) * 50.0 if name in {"6", "gripper"} else float(position) * 180.0 / math.pi)
            for name, position in zip(message.name, message.position)
        }
        if values:
            samples.append({"time": (int(timestamp) - start) / 1_000_000_000, "values": values})
    print(json.dumps(samples, ensure_ascii=False, separators=(",", ":")))

if __name__ == "__main__":
    main()
