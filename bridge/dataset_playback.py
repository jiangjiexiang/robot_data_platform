#!/usr/bin/env python3
"""Stream one LeRobot episode's actions to the robot-server."""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

JOINT_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


def vector(value) -> dict[str, float] | None:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)) or len(value) != len(JOINT_NAMES):
        return None
    values = [float(item) for item in value]
    if not np.isfinite(values).all():
        return None
    return dict(zip(JOINT_NAMES, values))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-root", required=True)
    parser.add_argument("--episode", type=int, required=True)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    root = Path(args.dataset_root).resolve()
    files = sorted((root / "data").glob("**/*.parquet"))
    if not files:
        raise FileNotFoundError("数据集没有 parquet 轨迹文件")
    frame = pd.concat((pd.read_parquet(item) for item in files), ignore_index=True)
    if "episode_index" not in frame or "action" not in frame:
        raise ValueError("数据集缺少 episode_index 或 action 字段")
    episode = frame[frame["episode_index"] == args.episode]
    if episode.empty:
        raise ValueError(f"找不到片段 {args.episode}")

    actions = []
    for value in episode["action"].tolist():
        joints = vector(value)
        if joints is None:
            raise ValueError("轨迹包含无效的六关节动作")
        actions.append(joints)

    print(json.dumps({"type": "playback_ready", "episode": args.episode, "frames": len(actions)}), flush=True)
    interval = 1.0 / max(1.0, args.fps * args.speed)
    next_at = time.monotonic()
    for index, joints in enumerate(actions):
        if stopping:
            return 0
        print(json.dumps({"type": "playback_action", "episode": args.episode, "frame": index, "frames": len(actions), "joints": joints}), flush=True)
        next_at += interval
        time.sleep(max(0.0, next_at - time.monotonic()))
    print(json.dumps({"type": "playback_done", "episode": args.episode, "frames": len(actions)}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"type": "playback_error", "error": str(error)}), flush=True)
        raise SystemExit(1)
