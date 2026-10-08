# ROS bag 到 ACT

现有 SO-101 录制的每个 `episode_xxxx/` 是一个 MCAP ROS2 bag。ACT 转换使用下列语义：

| LeRobot 字段 | ROS topic | 对齐方式 |
| --- | --- | --- |
| `observation.images.camera1` | `/camera1/image_raw` | 与固定时间网格最近的图像 |
| `observation.images.camera2` | `/camera2/image_raw` | 与固定时间网格最近的图像 |
| `observation.state` | `/joint_states` | 关节名重排为 `1..6` 后，与网格最近的实际反馈 |
| `action` | 两个 position controller command topic | 不晚于该网格时刻的最新目标位置 |

`action` 不可从 `/joint_states` 导出：它是机械臂滞后后的实际状态，不是示教者给出的目标动作。

在装有 ROS2、LeRobot 的训练环境中运行转换工具，并先做只读检查。当前相机源约 9 Hz，默认的 8 Hz 可避免重复/插值图像：

```bash
source /opt/ros/humble/setup.bash
/home/nvidia/miniconda3/envs/lerobot/bin/python3 \
  robot_data_platform/tools/rosbag_to_act/rosbag_to_lerobot.py /home/nvidia/lerobot_datasets/so101_dataset --dry-run
```

输出中每段的 `frames` 应接近 `duration_s * 8`。`skipped` 表示某时刻没有足够近的图像、状态或历史命令；先检查并剔除异常段，不能用缺失数据填零。

确认后，生成一个新的 LeRobot v3 数据集目录：

```bash
source /opt/ros/humble/setup.bash
/home/nvidia/miniconda3/envs/lerobot/bin/python3 \
  robot_data_platform/tools/rosbag_to_act/rosbag_to_lerobot.py /home/nvidia/lerobot_datasets/so101_dataset \
  --output /home/nvidia/lerobot_datasets/so101_act_v1 --repo-id local/so101_act_v1
```

转换后的关节状态和动作都是 ROS 位置控制器的弧度，固定顺序为 `[1, 2, 3, 4, 5, 6]`。训练机和 Orin 推理节点必须保持这个顺序、单位、两台相机物理位置及图像预处理完全一致。
