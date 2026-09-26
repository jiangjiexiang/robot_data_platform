# 通用机械臂数据平台

这是一个与机械臂型号解耦的控制、数据采集与管理网页。平台通过 ROS 2
适配器接入机械臂，网页服务负责实时控制传输、摄像头、ROS bag 和数据集管理。
当前仓库提供的第一个设备适配器是 SO-101 Leader/Follower；后续机械臂应实现
相同的 ROS 2 接口接入，而不是把型号逻辑写进平台。平台范围仅包含遥操作、数据
采集、回放、审核、上传和裁剪；LeRobot 兼容代码仅用于读写已有数据格式。

当前验收范围是：

- 网页遥操作与多路摄像头预览
- ROS bag 与 LeRobot 兼容 Dataset 的录制、追加 Episode 和视频编码
- Dataset/Episode 浏览、同步回放、审核和质量扫描
- 数据集 rsync 上传到训练主机（含录制后自动上传）和录制片段裁剪界面

## 系统结构

```text
操作电脑                                  机器人主机
┌──────────────────────┐                 ┌──────────────────────────┐
│ 浏览器                │ WebRTC / WS    │ robot-server             │
│  ├─ Web Serial Leader ├────────────────>│  ├─ ROS2 Web bridge       │
│  ├─ 遥操作 / 录制     │ HTTP            │  ├─ USB 摄像头            │
│  └─ 数据管理          ├────────────────>│  └─ Dataset recorder      │
└──────────────────────┘                 │           ↓              │
                                         │ 设备适配器 → 机械臂      │
                                         └──────────────────────────┘
```

控制链路、Web Serial、ICE/STUN/TURN 和故障定位见 [浏览器串口与实时控制链路](docs/CONTROL_TRANSPORTS.md)。

## 一键启动

项目有一键启动脚本：

```bash
cd ~/so101_hardware_cpp
./start.sh
```

脚本会完成以下操作：

1. 构建并加载当前机械臂适配器、描述包和 Web bridge。
2. 启动 `ros2_control`、控制器和 Web bridge。
3. 检查 Node.js、前端和采集依赖，并按需增量构建。
4. 自动生成或复用局域网 HTTPS 证书。
5. 启动托管网页、API、WebSocket 和 WebRTC 的 Robot Server。
6. 退出时回收本次启动的 ROS2 与网页进程组。

不接机械臂、只用数据平台（浏览 / 回放 / 审核 / 质量扫描 / 裁剪 / 上传）时：

```bash
cd ~/robot_data_platform
./start_data_platform.sh
```

该脚本不会启动 `ros2_control`、控制器和 ROS2 控制桥，服务端以 `DATA_ONLY=1` 运行，遥操作与实机录制不可用，其余数据能力不变。

Robot Server 默认通过 ROS2 compressed 图像话题接收 USB 摄像头用于网页预览；相机节点同时发布 raw 图像，录制 ROS bag 时使用 raw 话题保存最高画质。两类话题均使用 QoS 深度 1，并在预览队列只保留最新帧，降低延迟。

默认映射为 `/dev/video8 -> /camera1`、`/dev/video10 -> /camera2`，可在启动时覆盖：

```bash
ROS_CAMERA1_DEVICE=/dev/video0 ROS_CAMERA2_DEVICE=/dev/video2 ./start.sh
```

相机状态和压缩流分别可通过 `/api/cameras`、`/api/self-check`、`/video/camera` 和 `/video/camera2` 查看。ROS 模式下设备映射在启动时确定，网页中的设备选择器会锁定；需要换设备请修改上述变量后重启。

如果部署环境已有其他 ROS 相机驱动，可保留 `CAMERA_SOURCE=ros` 并设置 `ENABLE_CAMERA=0`，关闭本项目的相机启动逻辑，只让已有话题被网页桥接。旧版直接读取 V4L2 的路径仍可用：

```bash
CAMERA_SOURCE=usb ./start.sh
```

默认地址：

- 网页：脚本打印的 `https://<局域网IP>:5173`
- Robot API：`https://localhost:5173`
- 数据管理：`https://<局域网IP>:5173/#datasets`

首次启动后，将 `robot_data_platform/.certs/robot-lan-ca.crt` 导入访问网页设备的受信任根证书。若自动检测的局域网 IP 不正确，可使用 `HTTPS_HOST=192.168.1.36 ./start.sh`。浏览器 Web Serial 依赖安全上下文，不建议在网页串口模式下关闭 HTTPS。

为兼容局域网 IP、反向代理和 FRP 入口变化，Better Auth 的 Origin/CSRF 校验已关闭；登录会话和角色权限校验仍然保留。请不要将服务直接暴露到不受信任的公网。

日常启动会复用前后端构建缓存；前端源码变化时会自动重新构建生产资源。

首次部署只需为数据工具安装所需的 Python 依赖；ROS2/C++ 机械臂控制本身不依赖 LeRobot 源码：

```bash
/path/to/lerobot/bin/python3 -m pip install -e '/path/to/lerobot[feetech]'
```

如果 Python 或数据目录不在默认位置：

```bash
PYTHON_PATH=/path/to/lerobot/bin/python3 \
LEROBOT_PYTHON_PATH=/path/to/lerobot/bin/python3 \
DATASET_ROOT=/data/lerobot_datasets \
./start.sh
```

## 机械臂适配器

平台本身不绑定机械臂型号。一个设备适配器负责提供关节状态、控制命令、相机话题、
标定与紧急释放能力。当前 `start.sh` 选择 SO-101 适配器，因此下面的设备映射只对
该适配器生效；接入其他机械臂时应增加对应 ROS 2 驱动与 launch 文件。

接口边界见 [机械臂适配器约定](docs/ROBOT_ADAPTER_CONTRACT.md)。将平台迁移到另一台
机械臂的完整操作步骤见 [迁移到其他机械臂](docs/MIGRATE_TO_ANOTHER_ROBOT.md)。

### SO-101

默认设备映射如下，请以实际接线为准：

| 设备 | 串口 | 默认 ID |
| --- | --- | --- |
| Follower | `/dev/ttyACM0` | `R12253102` |
| Leader | `/dev/ttyACM1` | `R07253102` |

启动完整 ROS2 控制栈：

```bash
./start.sh
```

Follower 串口由机器人主机上的 ROS2 hardware plugin 打开。控制来源有两种：

- `主臂串口`：Leader 连接机器人主机。
- `网页串口`：Leader 连接操作电脑，由 Chrome/Edge Web Serial 读取，经 WebRTC 或 WebSocket 发送到机器人主机。

启动遥操作并确认关节和画面持续更新后即可开始录制。

## 数据采集

在“遥操作”页面右侧填写数据集名称、任务、FPS 和 Episode 参数：

1. 点击“开始录制”。
2. 完成动作后点击“停止并保存”。
3. 打开“数据管理”检查 Episode、双路视频和质量报告。

默认输出：

```text
~/robot_datasets/<dataset>/
  meta/
  data/
  videos/
  .lerobot-web/reviews.json

```

同名 Dataset 只有在 FPS、相机分辨率、关节名称和顺序一致时才会追加。录制器兼容 LeRobot 0.4 与 0.5+；兼容逻辑封装在本项目内，不修改 LeRobot。

已有安装若存在 `~/lerobot_datasets` 且尚未创建 `~/robot_datasets`，服务会继续读取
旧目录。也可以始终通过 `DATASET_ROOT` 明确指定数据位置。

采集相关环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RECORDING_MAX_SENSOR_AGE_MS` | `250` | 允许的最大传感器数据年龄 |
| `RECORDING_MAX_CAMERA_SKEW_MS` | `100` | 两路相机最大时间差 |
| `DATASET_STREAMING_ENCODING` | `auto` | LeRobot 0.5+ 实时视频编码策略 |
| `DATASET_VIDEO_CODEC` | `auto` | 视频编码器 |

## 上传数据集到训练主机

「上传训练主机」页面负责把本地数据集（当前为 rosbag 采集目录）用 rsync 增量推送到
训练主机的约定目录，传输完成后自动做一致性复核；支持保存设置、测试连接、任务进度
与日志、失败重试，以及"录制保存后自动上传"开关。rosbag → LeRobot 转换与训练都在
训练主机平台执行。配置步骤和对接约定见 [上传数据集到训练主机](docs/UPLOAD_TO_TRAINING_HOST.md)。

## ROS bag 转 LeRobot ACT 数据集

历史 ROS bag 数据集中的每个 `episode_0000/` 目录都是一个 MCAP bag。rosbag 数据集
通过「上传训练主机」页面推送到训练主机后，可用
`tools/rosbag_to_act/rosbag_to_lerobot.py`（随仓库发布，训练主机检出后即可使用）
将其转换为可供 ACT 训练使用的 LeRobot v3 数据集。转换只读取输入目录，不会修改原始 bag。

转换字段如下：

| LeRobot 字段 | ROS topic | 对齐方式 |
| --- | --- | --- |
| `observation.images.camera1` | `/camera1/image_raw` | 与固定时间网格最近的图像 |
| `observation.images.camera2` | `/camera2/image_raw` | 与固定时间网格最近的图像 |
| `observation.state` | `/joint_states` | 重排为关节 `1..6` 后的最近实际反馈 |
| `action` | 两个 position controller command topic | 不晚于该网格时刻的最新目标位置 |

`action` 必须来自控制器命令，不能以 `/joint_states` 代替；后者是存在滞后的实际反馈。

先做只读预检。默认 8 FPS 与约 9 Hz 的相机源匹配，可减少重复或插值帧：

```bash
cd ~/so101_hardware_cpp
source /opt/ros/humble/setup.bash
/home/nvidia/miniconda3/envs/lerobot/bin/python3 \
  robot_data_platform/tools/rosbag_to_act/rosbag_to_lerobot.py \
  /home/nvidia/lerobot_datasets/so101_dataset --dry-run
```

检查每个 episode 的 `frames` 是否接近 `duration_s * 8`。`skipped` 表示该采样时刻缺少
足够接近的相机、状态或历史命令；不要填零，应在正式转换时排除异常 episode。

正式转换会创建一个新的输出目录，输出目录必须不存在：

```bash
cd ~/so101_hardware_cpp
source /opt/ros/humble/setup.bash
/home/nvidia/miniconda3/envs/lerobot/bin/python3 \
  robot_data_platform/tools/rosbag_to_act/rosbag_to_lerobot.py \
  /home/nvidia/lerobot_datasets/so101_dataset \
  --output /home/nvidia/lerobot_datasets/so101_act_v1 \
  --repo-id local/so101_act_v1
```

若预检发现异常段，只转换指定 episode：

```bash
/home/nvidia/miniconda3/envs/lerobot/bin/python3 \
  robot_data_platform/tools/rosbag_to_act/rosbag_to_lerobot.py \
  /home/nvidia/lerobot_datasets/so101_dataset \
  --output /home/nvidia/lerobot_datasets/so101_act_clean_v1 \
  --repo-id local/so101_act_clean_v1 \
  --episodes 0 1 3 4
```

可用参数包括 `--fps`（1 到 30，默认 8）、`--task`（缺少 episode 任务时的备用任务名）和
`--max-image-skew-ms`、`--max-state-skew-ms`、`--max-command-age-ms`（时间对齐容差）。

LeRobot v3 将数据按分块保存，而不是每个 episode 一个目录。一个较小的数据集通常只会有
一个 Parquet 文件和每路相机一个 MP4；`meta/episodes/` 中的索引会将它们切分为各个 episode：

```text
so101_act_v1/
  meta/info.json
  meta/episodes/*.parquet
  data/chunk-000/file-000.parquet
  videos/observation.images.camera1/chunk-000/file-000.mp4
  videos/observation.images.camera2/chunk-000/file-000.mp4
```

转换后运行质量扫描，并在“数据管理”中回放双路视频，确认任务完成、画面清晰且没有碰撞、复位或示教中断：

```bash
/home/nvidia/miniconda3/envs/lerobot/bin/python3 \
  robot_data_platform/bridge/dataset_catalog.py quality \
  --root /home/nvidia/lerobot_datasets --dataset so101_act_v1
```

扫描中的 `error` 必须排除；`warning` 应人工复核。训练与部署必须保持关节顺序 `[1, 2, 3, 4, 5, 6]`、弧度单位、两台相机位置和图像预处理一致。更多转换语义见 [ROS bag 到 ACT](docs/ROSBAG_TO_ACT.md)。

## 数据管理

打开 `/#datasets` 后可以：

- 浏览 Dataset 和 Episode 元数据
- 同步播放两路相机视频
- 编辑审核状态、标签、负责人和备注
- 批量审核
- 执行数据质量扫描
- 下载视频和查看原始数据路径

审核信息只写入 `.lerobot-web/reviews.json`，不会改写原始 Parquet 或视频。

## 导出通过审核的片段

「数据选集」页除了发布清单，还可以把已通过审核的 Episode 导出成一个新的 LeRobot v3 数据集：

1. 填写目标数据集名称（默认 `<原数据集>_approved`）。
2. 点击「导出已通过片段」。
3. 导出完成后新数据集出现在「数据资产」列表，可继续查看、审核或上传训练主机。

新数据集是一份完整副本：自己的 `meta/info.json`、`meta/episodes`、`meta/tasks`、`meta/stats.json`、
`data/chunk-000/file-000.parquet`，以及按 Episode 重新拼接的两路相机视频。视频以 CRF 18 重新编码，
目的是让每段帧数与数据严格对齐（直接码流剪切会受关键帧间隔影响而漂移），导出脚本会用 `ffprobe`
逐路校验帧数，不一致则报错回滚。命令行也可单独使用：

```bash
/home/zju/miniconda3/envs/lerobot/bin/python3 \
  bridge/dataset_export.py --root ~/robot_datasets \
  --source so101_pick_box_v1 --target so101_pick_box_v1_clean \
  --episodes 0 3 5
```

## 局域网 HTTPS

浏览器 Web Serial 必须运行在安全上下文。完整启动脚本会调用 `robot_data_platform/start_robot.sh` 自动检测局域网 IP、生成证书并启用 HTTPS：

```bash
./start.sh
```

如需明确指定访问 IP：

```bash
HTTPS_HOST=192.168.1.50 ./start.sh
```

将 `robot_data_platform/.certs/robot-lan-ca.crt` 导入操作电脑的受信任根证书，然后访问脚本打印的 HTTPS 地址。

## 常用排查

```bash
# 检查串口
ls /dev/ttyACM* /dev/ttyUSB*

# 查看串口占用
fuser -v /dev/ttyACM0 /dev/ttyACM1

# 检查服务
curl -k https://localhost:5173/health

# 降低相机负载
CAMERA_FPS=15 CAMERA_WIDTH=640 CAMERA_HEIGHT=360 ./start.sh
```

Jetson 默认采用混合低延迟模式：控制与状态走 WebRTC DataChannel，视频保持摄像头
原生 MJPEG 并通过只保留最新帧的视频通道发送，避免 MJPEG → I420 → VP8 的二次
软件转码。需要在性能更强的平台测试纯 WebRTC 视频时可开启：

```bash
ENABLE_WEBRTC_VIDEO=1 RTC_VIDEO_FPS=15 RTC_VIDEO_BITRATE=1500000 ./start.sh
```

不要同时运行校准程序、独立机械臂驱动和网页遥操作，它们会争用串口。首次带实机运行时保持低速、小幅动作，并确保 Follower 周围没有障碍物。

## 项目结构

```text
bridge/
  camera_stream.py             旧版 OpenCV USB 相机采集（兼容保留）
  dataset_recorder.py          LeRobot Episode 录制
  lerobot_dataset_compat.py    LeRobot 0.4/0.5 兼容层
  dataset_catalog.py           数据集读取与质量扫描
  dataset_export.py            把指定 Episode 导出为新数据集
  teleop_robot.py              SO-101 串口驱动
frontend/                      Vue 3 网页
robot-server/                  API、WebSocket、WebRTC、录制协调
scripts/                       依赖安装和证书工具
start_robot.sh                 本机一键启动
start_data_platform.sh         仅数据平台启动（不接机械臂）
start_wifi_robot.sh            局域网 HTTPS 一键启动
../ros2_ws/src/so101_hardware/ SO-101 ros2_control hardware plugin
../ros2_ws/src/robot_web_ros_bridge/   网页与 ROS2 控制桥
../start.sh                    完整 ROS2 + 网页启动入口
```


## 开发验证

```bash
cd frontend && npm run build
cd ../robot-server && npm test
npm run test:data
cd ..

/path/to/lerobot/bin/python3 -m unittest \
  bridge.test_dataset_recorder \
  bridge.test_lerobot_dataset_compat
```
