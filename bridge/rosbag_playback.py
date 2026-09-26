#!/usr/bin/env python3
"""Replay recorded ROS2 joint states through the robot-server playback pipe."""
from __future__ import annotations
import argparse
import json
import math
import signal
import time
from pathlib import Path
import rosbag2_py
from rclpy.serialization import deserialize_message
from sensor_msgs.msg import JointState

stopping = False
def stop(_signum, _frame):
    global stopping
    stopping = True

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bag-dir", type=Path, required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=str(args.bag_dir), storage_id="mcap"), rosbag2_py.ConverterOptions("cdr", "cdr"))
    topics = {item.name: item.type for item in reader.get_all_topics_and_types()}
    if topics.get("/joint_states") != "sensor_msgs/msg/JointState": raise ValueError("ROS bag 缺少 /joint_states")
    samples = []
    start = None
    while reader.has_next():
        topic, data, timestamp = reader.read_next()
        if topic != "/joint_states": continue
        message = deserialize_message(data, JointState)
        values = dict(zip(message.name, message.position))
        if len(values) < 6: continue
        if start is None: start = int(timestamp)
        joints = {}
        for index, name in enumerate(("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"), 1):
            raw = float(values.get(str(index), list(values.values())[index - 1]))
            joints[name] = (raw / 1.20753769 + 1.0) * 50.0 if index == 6 else raw * 180.0 / math.pi
        samples.append(((int(timestamp) - start) / 1_000_000_000, joints))
    if not samples: raise ValueError("ROS bag 没有可回放的关节状态")
    print(json.dumps({"type": "playback_ready", "frames": len(samples), "fps": 1.0 / max(0.001, samples[1][0] - samples[0][0]) if len(samples) > 1 else 10}), flush=True)
    wall_start = time.monotonic(); bag_start = samples[0][0]
    for index, (stamp, joints) in enumerate(samples):
        if stopping: return 0
        target = wall_start + (stamp - bag_start) / max(0.25, args.speed)
        delay = target - time.monotonic()
        if delay > 0: time.sleep(delay)
        print(json.dumps({"type": "playback_action", "frame": index, "frames": len(samples), "joints": joints}), flush=True)
    print(json.dumps({"type": "playback_done", "frames": len(samples)}), flush=True)
    return 0

if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"type": "playback_error", "error": str(error)}), flush=True); raise SystemExit(1)
