#!/usr/bin/env python3
"""把指定 Episode（通常是审核通过的片段）导出成一个新的 LeRobot v3 数据集。

新数据集是完整的数据副本：拥有自己的 meta/info.json、meta/episodes、
meta/tasks、meta/stats.json、data parquet 和按 Episode 重新拼接的相机视频，
可以直接被数据管理浏览、质量扫描和上传训练主机。

用法:

    python3 bridge/dataset_export.py --root ~/robot_datasets \\
        --source so101_pick_box_v1 --target so101_pick_box_v1_clean \\
        --episodes 0 3 5

输出一行 JSON 到 stdout；失败时向 stderr 输出 {"ok": false, "error": ...}。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

CRF = 18


class ExportError(RuntimeError):
    """导出过程中的可恢复错误。"""


def parquet_files(directory: Path) -> list[Path]:
    return sorted(item for item in directory.glob("**/*.parquet") if item.is_file())


def read_dataset_name(root: Path, name: str) -> Path:
    candidate = (root / name).resolve()
    if candidate.parent != root or not candidate.is_dir():
        raise ExportError(f"找不到数据集: {name}")
    return candidate


def load_info(dataset_root: Path) -> dict:
    info_path = dataset_root / "meta" / "info.json"
    if not info_path.is_file():
        raise ExportError("源数据集不是 LeRobot v3 数据集（缺少 meta/info.json）；rosbag 数据集请先转换后再导出")
    try:
        return json.loads(info_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as cause:
        raise ExportError(f"meta/info.json 无法解析: {cause}") from cause


def video_keys(info: dict) -> list[str]:
    features = info.get("features") or {}
    return [key for key, spec in features.items() if isinstance(spec, dict) and spec.get("dtype") == "video"]


def directory_size_mb(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    total = sum(item.stat().st_size for item in directory.rglob("*") if item.is_file())
    return max(1, round(total / (1024 * 1024)))


def column_values(table: pa.Table, name: str) -> np.ndarray:
    """把列读成二维数组 (rows, dims)；标量列按 (rows, 1) 处理。"""
    raw = table.column(name).to_pylist()
    if raw and isinstance(raw[0], (list, tuple)):
        return np.asarray([list(value) for value in raw], dtype=np.float64)
    return np.asarray(raw, dtype=np.float64).reshape(-1, 1)


def feature_stats(values: np.ndarray) -> dict:
    return {
        "min": values.min(axis=0).tolist(),
        "max": values.max(axis=0).tolist(),
        "mean": values.mean(axis=0).tolist(),
        "std": values.std(axis=0).tolist(),
        "count": [int(values.shape[0])],
        "q01": np.quantile(values, 0.01, axis=0).tolist(),
        "q10": np.quantile(values, 0.10, axis=0).tolist(),
        "q50": np.quantile(values, 0.50, axis=0).tolist(),
        "q90": np.quantile(values, 0.90, axis=0).tolist(),
        "q99": np.quantile(values, 0.99, axis=0).tolist(),
    }


def set_column_if_present(table: pa.Table, name: str, values: Iterable[int]) -> pa.Table:
    index = table.schema.names.index(name)
    field = table.schema.field(name)
    return table.set_column(index, field, pa.array(list(values), type=field.type))


def cut_video_segment(source: Path, start: float, end: float, frames: int, fps: float, target: Path) -> None:
    duration = max(float(end) - float(start), 1 / fps)
    command = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{float(start):.6f}", "-i", str(source),
        "-t", f"{duration:.6f}",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(CRF),
        "-pix_fmt", "yuv420p", "-r", f"{fps:g}", "-frames:v", str(int(frames)),
        str(target),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0 or not target.is_file():
        raise ExportError(f"视频切片失败: {target.name}: {result.stderr.strip() or 'ffmpeg 返回错误'}")


def concat_videos(segments: list[Path], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    listing = target.parent / "concat-list.txt"
    listing.write_text("".join(f"file '{segment.resolve()}'\n" for segment in segments), encoding="utf-8")
    try:
        command = ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(target)]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0 or not target.is_file():
            raise ExportError(f"视频拼接失败: {result.stderr.strip() or 'ffmpeg 返回错误'}")
    finally:
        listing.unlink(missing_ok=True)


def count_video_frames(video: Path) -> int | None:
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(video),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return None
    try:
        return int(result.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        return None


def export(root: Path, source_name: str, target_name: str, requested: list[int]) -> dict:
    source = read_dataset_name(root, source_name)
    target = (root / target_name).resolve()
    if target.parent != root:
        raise ExportError("数据集名称无效")
    if target.exists():
        raise ExportError(f"目标数据集已存在: {target_name}")
    if shutil.which("ffmpeg") is None:
        raise ExportError("缺少 ffmpeg，无法重新拼接相机视频")

    info = load_info(source)
    fps = float(info.get("fps") or 30)
    cameras = video_keys(info)

    meta_files = parquet_files(source / "meta" / "episodes")
    data_files = parquet_files(source / "data")
    if not meta_files or not data_files:
        raise ExportError("源数据集缺少 meta/episodes 或 data 目录，无法导出")

    episodes_meta = pa.concat_tables([pq.read_table(item) for item in meta_files])
    available = set(int(value) for value in episodes_meta.column("episode_index").to_pylist())
    selected = sorted(set(int(episode) for episode in requested) & available)
    if not selected:
        raise ExportError("没有可导出的 Episode")
    missing = sorted(set(int(episode) for episode in requested) - available)
    episodes_meta = episodes_meta.filter(
        pc.is_in(episodes_meta.column("episode_index"), value_set=pa.array(selected, type=episodes_meta.schema.field("episode_index").type))
    )

    data = pa.concat_tables([pq.read_table(item) for item in data_files])
    data = data.filter(
        pc.is_in(data.column("episode_index"), value_set=pa.array(selected, type=data.schema.field("episode_index").type))
    )
    sort_keys = [("episode_index", "ascending")]
    if "frame_index" in data.schema.names:
        sort_keys.append(("frame_index", "ascending"))
    data = data.sort_by(sort_keys)

    old_episodes = [int(value) for value in data.column("episode_index").to_pylist()]
    new_index_of = {old: new for new, old in enumerate(selected)}
    new_episodes = [new_index_of[old] for old in old_episodes]
    lengths: list[int] = []
    new_frame_indices: list[int] = []
    counter = -1
    previous = None
    for episode in new_episodes:
        if episode != previous:
            lengths.append(0)
            counter = 0
            previous = episode
        else:
            counter += 1
        lengths[-1] += 1
        new_frame_indices.append(counter)
    while len(lengths) < len(selected):
        lengths.append(0)

    if "episode_index" in data.schema.names:
        data = set_column_if_present(data, "episode_index", new_episodes)
    if "frame_index" in data.schema.names:
        data = set_column_if_present(data, "frame_index", new_frame_indices)
    if "index" in data.schema.names:
        data = set_column_if_present(data, "index", range(len(new_episodes)))

    # 任务编号重排：只保留导出片段实际使用的任务。
    used_tasks: dict[int, int] = {}
    if "task_index" in data.schema.names:
        raw_tasks = [int(value) for value in data.column("task_index").to_pylist()]
        for value in raw_tasks:
            old_task = int(value)
            if old_task not in used_tasks:
                used_tasks[old_task] = len(used_tasks)
        data = set_column_if_present(data, "task_index", [used_tasks[value] for value in raw_tasks])

    workspace = target.parent / f".{target.name}.exporting"
    if workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True)
    try:
        data_directory = workspace / "data" / "chunk-000"
        data_directory.mkdir(parents=True)
        pq.write_table(data, data_directory / "file-000.parquet")
        del data

        # meta/episodes：重排编号并指向新的数据文件与视频文件。
        episodes = episodes_meta.sort_by([("episode_index", "ascending")])
        episodes = set_column_if_present(episodes, "episode_index", range(len(selected)))
        if "data/chunk_index" in episodes.schema.names:
            episodes = set_column_if_present(episodes, "data/chunk_index", [0] * len(selected))
        if "data/file_index" in episodes.schema.names:
            episodes = set_column_if_present(episodes, "data/file_index", [0] * len(selected))
        cursor = 0
        from_indices: list[int] = []
        to_indices: list[int] = []
        for length in lengths:
            from_indices.append(cursor)
            cursor += length
            to_indices.append(cursor)
        if "dataset_from_index" in episodes.schema.names:
            episodes = set_column_if_present(episodes, "dataset_from_index", from_indices)
        if "dataset_to_index" in episodes.schema.names:
            episodes = set_column_if_present(episodes, "dataset_to_index", to_indices)
        for camera in cameras:
            prefix = f"videos/{camera}"
            starts: list[float] = []
            ends: list[float] = []
            offset = 0.0
            for length in lengths:
                starts.append(round(offset, 6))
                offset += length / fps
                ends.append(round(offset, 6))
            for suffix, values in (("/chunk_index", [0] * len(selected)), ("/file_index", [0] * len(selected))):
                if f"{prefix}{suffix}" in episodes.schema.names:
                    episodes = set_column_if_present(episodes, f"{prefix}{suffix}", values)
            for suffix, values in (("/from_timestamp", starts), ("/to_timestamp", ends)):
                if f"{prefix}{suffix}" in episodes.schema.names:
                    field = episodes.schema.field(f"{prefix}{suffix}")
                    kind = field.type
                    cast = int if pa.types.is_integer(kind) else float
                    episodes = episodes.set_column(
                        episodes.schema.names.index(f"{prefix}{suffix}"), field, pa.array([cast(value) for value in values], type=kind),
                    )
        if "meta/episodes/chunk_index" in episodes.schema.names:
            episodes = set_column_if_present(episodes, "meta/episodes/chunk_index", [0] * len(selected))
        if "meta/episodes/file_index" in episodes.schema.names:
            episodes = set_column_if_present(episodes, "meta/episodes/file_index", [0] * len(selected))

        meta_directory = workspace / "meta"
        (meta_directory / "episodes" / "chunk-000").mkdir(parents=True, exist_ok=True)
        pq.write_table(episodes, meta_directory / "episodes" / "chunk-000" / "file-000.parquet")

        source_tasks = source / "meta" / "tasks.parquet"
        if source_tasks.is_file():
            tasks = pq.read_table(source_tasks)
            keep = [old for old, _ in sorted(used_tasks.items(), key=lambda item: item[1])]
            rows = [row for row in tasks.to_pylist() if int(row.get("task_index", -1)) in keep] if "task_index" in tasks.schema.names else []
            rebuilt = pa.Table.from_pylist(
                [{**row, "task_index": index} for index, row in enumerate(rows)] if rows else [],
                schema=tasks.schema,
            )
            pq.write_table(rebuilt, meta_directory / "tasks.parquet")

        # meta/stats.json：标量/向量特征重新统计，视频特征沿用源数据集统计值。
        raw_stats = source / "meta" / "stats.json"
        source_stats: dict = {}
        if raw_stats.is_file():
            try:
                source_stats = json.loads(raw_stats.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                source_stats = {}
        data_table = pq.read_table(data_directory / "file-000.parquet")
        computed: dict[str, dict] = {}
        for name in data_table.schema.names:
            if pa.types.is_list(data_table.schema.field(name).type):
                values = column_values(data_table, name)
            elif pa.types.is_integer(data_table.schema.field(name).type) or pa.types.is_floating(data_table.schema.field(name).type):
                values = column_values(data_table, name)
            else:
                continue
            if values.size == 0:
                continue
            computed[name] = feature_stats(values)
        for camera in cameras:
            if camera in source_stats:
                computed[camera] = source_stats[camera]
        (meta_directory / "stats.json").write_text(json.dumps(computed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        # videos：每个 Episode 重新编码为独立片段后首尾相接，保证帧数与数据一致。
        template = info.get("video_path")
        if cameras and template:
            if shutil.which("ffprobe") is None:
                raise ExportError("缺少 ffprobe，无法校验导出视频的帧数")
            video_template = str(template)
            # 源视频定位用的是导出前的映射，必须从原始 meta/episodes 读取。
            original = pa.concat_tables([pq.read_table(item) for item in meta_files])
            original = original.filter(
                pc.is_in(original.column("episode_index"), value_set=pa.array(selected, type=original.schema.field("episode_index").type))
            ).sort_by([("episode_index", "ascending")])
            for camera in cameras:
                segments: list[Path] = []
                temporary = workspace / ".segments" / camera.replace("/", "_")
                temporary.mkdir(parents=True, exist_ok=True)
                source_chunk = original.column(f"videos/{camera}/chunk_index").to_pylist()
                source_file = original.column(f"videos/{camera}/file_index").to_pylist()
                starts = original.column(f"videos/{camera}/from_timestamp").to_pylist()
                ends = original.column(f"videos/{camera}/to_timestamp").to_pylist()
                for position, old in enumerate(selected):
                    relative = video_template.format(video_key=camera, chunk_index=int(source_chunk[position]), file_index=int(source_file[position]))
                    video = source / relative
                    if not video.is_file():
                        raise ExportError(f"缺少源视频: {relative}")
                    segment = temporary / f"episode-{position:04d}.mp4"
                    cut_video_segment(video, float(starts[position]), float(ends[position]), lengths[position], fps, segment)
                    segments.append(segment)
                if not segments:
                    continue
                destination = workspace / "videos" / camera / "chunk-000"
                destination.mkdir(parents=True, exist_ok=True)
                output = destination / "file-000.mp4"
                concat_videos(segments, output)
                shutil.rmtree(temporary, ignore_errors=True)
                counted = count_video_frames(output)
                if counted is not None and counted != sum(lengths):
                    raise ExportError(f"{camera} 视频帧数校验失败: 期望 {sum(lengths)} 帧，实际 {counted} 帧")

        target_info = dict(info)
        target_info["total_episodes"] = len(selected)
        target_info["total_frames"] = int(sum(lengths))
        target_info["total_tasks"] = len(used_tasks)
        target_info["splits"] = {"train": f"0:{len(selected)}"}
        target_info["data_files_size_in_mb"] = directory_size_mb(workspace / "data")
        target_info["video_files_size_in_mb"] = directory_size_mb(workspace / "videos")
        (meta_directory / "info.json").write_text(json.dumps(target_info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        workspace.rename(target)
    except Exception:
        shutil.rmtree(workspace, ignore_errors=True)
        raise

    result = {
        "ok": True,
        "dataset": target_name,
        "path": str(target),
        "sourceDataset": source_name,
        "episodes": selected,
        "frames": int(sum(lengths)),
        "cameras": cameras,
    }
    if missing:
        result["skipped"] = missing
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把指定 Episode 导出为一个新的 LeRobot v3 数据集")
    parser.add_argument("--root", required=True, help="数据集根目录")
    parser.add_argument("--source", required=True, help="源数据集名称")
    parser.add_argument("--target", required=True, help="新数据集名称")
    parser.add_argument("--episodes", type=int, nargs="*", default=[], help="要导出的 Episode 编号")
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    try:
        result = export(root, args.source, args.target, list(args.episodes))
    except ExportError as cause:
        print(json.dumps({"ok": False, "error": str(cause)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
