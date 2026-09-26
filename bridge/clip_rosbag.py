#!/usr/bin/env python3
"""Trim an MCAP ROS2 bag by timestamp while preserving serialized messages."""
from __future__ import annotations
import argparse
from pathlib import Path
import rosbag2_py

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    args = parser.parse_args()
    if args.end < args.start:
        raise ValueError("裁剪结束时间不能早于开始时间")
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=str(args.source), storage_id="mcap"), rosbag2_py.ConverterOptions("cdr", "cdr"))
    writer = rosbag2_py.SequentialWriter()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    writer.open(rosbag2_py.StorageOptions(uri=str(args.output), storage_id="mcap"), rosbag2_py.ConverterOptions("cdr", "cdr"))
    for topic in reader.get_all_topics_and_types():
        writer.create_topic(topic)
    info = reader.get_metadata()
    start_ns = int(info.starting_time.nanoseconds) + int(args.start * 1_000_000_000)
    end_ns = int(info.starting_time.nanoseconds) + int(args.end * 1_000_000_000)
    count = 0
    while reader.has_next():
        topic, data, timestamp = reader.read_next()
        if start_ns <= timestamp <= end_ns:
            writer.write(topic, data, timestamp)
            count += 1
    print(count)

if __name__ == "__main__":
    main()
