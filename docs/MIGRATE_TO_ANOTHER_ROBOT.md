# 迁移到其他机械臂

本文用于把 `robot_data_platform` 接到新的机械臂型号。平台负责网页、控制传输、
相机预览、ROS bag、数据审核和 LeRobot Studio 编辑；每种机械臂都必须有自己的 ROS 2 设备适配器。

当前仓库只完成了 SO-101 适配。不要把另一台机械臂直接接到当前 `start.sh` 后启动：
它会加载 SO-101 的串口、关节范围、控制器、标定文件和 Feetech 释力报文。

## 迁移结果

迁移完成后，新设备应满足以下能力：

- 网页能显示实时关节状态和两路相机预览。
- 浏览器或本机控制命令经过新设备的安全限位、速度和加速度限制后执行。
- “紧急停止并释放力”只作用于新设备，并且可在 ROS 2 控制器失效时执行。
- 录制的 ROS bag 包含关节状态和原始相机图像，可以转换、回放并在 LeRobot Studio 中编辑。

先完成驱动、状态、限位和释力，再接入网页控制。不要把网页控制作为第一次驱动实机的工具。

## 1. 建立设备目录

为新型号创建独立目录和 ROS 2 包，示例型号使用 `my_arm`：

```text
config/robot_driver/my_arm/
  calibration/                标定文件，只属于该型号
  limits.json                 机械行程、速度、加速度和默认安全姿态
ros2_ws/src/
  my_arm_hardware/            驱动、通信、力矩控制和安全检查
  my_arm_description/         URDF/Xacro、关节名称和坐标系
  my_arm_web_bridge/          网页协议与 ROS 2 话题之间的适配器
```

不要修改或复用 `config/robot_driver/calibration/follower/R12253102.json`。
每台设备至少要有独立的型号、序列号、标定版本和限位来源记录。

## 2. 先完成 ROS 2 驱动

新设备的 launch 文件至少应启动驱动、`robot_state_publisher`、控制器和
`joint_state_broadcaster`。在没有网页和相机的情况下验证：

```bash
source /opt/ros/humble/setup.bash
source ros2_ws/install/setup.bash
ros2 topic echo --once /joint_states
ros2 control list_controllers
```

`/joint_states` 必须持续发布 `sensor_msgs/msg/JointState`，其中 `name`、`position`、
`velocity` 的对应关系稳定。位置单位统一使用弧度；夹爪或直线轴也必须在适配器里定义
明确的物理单位和安全范围。

建议由驱动提供以下控制接口：

| 功能 | 推荐 ROS 2 接口 | 要求 |
| --- | --- | --- |
| 状态 | `/joint_states` | 所有关节名称唯一，时间戳有效 |
| 手动位置控制 | `<型号控制器>/commands` | 只接收经过限位检查的目标 |
| 控制器启停 | `controller_manager` | 可安全切换到 inactive |
| 释放力 | 型号专属 ROS 2 service/action 或驱动接口 | 可重复调用，失败可诊断 |
| 相机预览 | `/cameraN/image_raw/compressed` | 最新帧优先、QoS 深度 1 |
| 高画质录制 | `/cameraN/image_raw` | 与预览分开，不使用 compressed 代替 raw |

## 3. 编写网页桥接适配器

当前 [`robot_web_ros_bridge`](../../ros2_ws/src/robot_web_ros_bridge/) 是 SO-101 的
参考实现，不可原样用于其他设备。它目前固定了：

- 六个关节、SO-101 关节名和归一化范围。
- `/arm_position_controller/commands` 与 `/gripper_position_controller/commands`。
- SO-101 的夹爪行程和每关节 slew rate。
- ROS 关节名 `1` 到 `6`。

推荐为新型号创建 `my_arm_web_bridge`。桥接器从标准输入读取平台消息，检查字段完整性、
有限数值、顺序、行程、速度和控制超时，然后才发布 ROS 2 命令。输出应使用 JSON Lines：

```json
{"type":"teleop_observation","leader":{"joint_a":0.0},"follower":{"joint_a":0.0},"ts":1730000000.0,"applied_seq":42}
```

其中 `follower` 是实际反馈而不是目标值，`applied_seq` 是已实际采用的控制序号。
相机帧沿用 `camera_frame` 消息，并仅发送 `/cameraN/image_raw/compressed` 的 JPEG 数据。

当前网页的手动控制和回放仍按 SO-101 的六关节 payload 校验。若新设备不是同样的六关节
结构，必须同时更新以下位置，使关节名、单位、百分比显示和回放映射一致：

- `robot_data_platform/frontend/src/composables/useWebSocket.ts`
- `robot_data_platform/frontend/src/App.vue`
- `robot_data_platform/robot-server/src/index.ts`
- `robot_data_platform/bridge/rosbag_playback.py`

不要仅在前端改标签。前端、桥接器、ROS 控制器、录制和回放必须使用同一份型号配置。

## 4. 配置相机与录制

平台默认使用两路规范话题：

```text
/camera1/image_raw/compressed   网页预览
/camera2/image_raw/compressed   网页预览
/camera1/image_raw              ROS bag 原始图像
/camera2/image_raw              ROS bag 原始图像
```

新设备已有相机话题时，优先在新设备的 launch 中重映射到这些规范话题。这样无需改网页和
视频转换逻辑。若必须使用不同名字或超过两路相机，需要同步更新 Robot Server 的
`BAG_RECORD_TOPICS`、预览订阅和前端相机视图；不要只改录制话题。

开始录制前确认原始图像确实在发布：

```bash
ros2 topic info /camera1/image_raw
ros2 topic info /camera1/image_raw/compressed
ros2 topic info /camera2/image_raw
ros2 topic info /camera2/image_raw/compressed
```

录制结束后检查 MCAP：

```bash
ros2 bag info <数据集目录>/episodes/<片段>/rosbag
```

其中应包含 `/joint_states` 和两路 raw 图像。compressed 话题只能用于预览，不能替代
高画质原始录制。

## 5. 实现型号专属紧急释放

这是迁移的必做项。当前 Robot Server 的 `/api/emergency-release` 会直接向 SO-101
Feetech 总线写入扭矩关闭报文，且只适用于串口 ID 1 到 6。新的机械臂必须先替换这条
直接串口路径，不能依赖该实现的 ROS 2 回退逻辑。

新适配器应提供一个独立的、无运动副作用的“停止并释放力”操作：

1. 立即拒绝新的控制命令。
2. 停止或失活位置控制器。
3. 按该设备的协议关闭扭矩、使能或制动保持。
4. 返回可审计的成功、失败和设备状态。
5. 重复调用不能让机械臂运动，也不能报成未处理异常。

先在空载、安全区域内从命令行验证该操作，再把它接到网页按钮。不可把“释放力”替换为
发送零位置、保持当前位置或 ROS 进程退出。

## 6. 新建启动入口

根目录 `start.sh` 目前是 SO-101 的启动入口。新型号应先新建独立脚本，例如
`start_my_arm.sh`，并在其中设置：

```bash
export ROS_BRIDGE_COMMAND=ros2
export ROS_BRIDGE_ARGS="run my_arm_web_bridge web_ros_bridge"
export ROS_CALIB_FILE="$PWD/config/robot_driver/my_arm/calibration/<serial>.json"
export BAG_RECORD_TOPICS="/joint_states,/my_arm_controller/commands,/camera1/image_raw,/camera2/image_raw"
```

脚本还需要构建新型号的 ROS 2 包、启动其 launch 文件，并在启动 `robot_data_platform`
前确认标定文件、串口/网络设备和相机话题存在。SO-101 的 `start.sh` 应保持可用，作为
已验证设备的回归入口。

## 7. 分阶段验收

按顺序完成，每一步通过后再继续：

1. 驱动只读：读取所有关节与相机，不给电机发送命令。
2. 安全命令：在低速、小范围内逐关节验证正负方向、软件限位、速度和加速度。
3. 释力：断开网页或 ROS 2 控制器后，仍能独立执行停止并释放力。
4. 网页控制：检查状态值、百分比、单位和遥操作方向，不录制。
5. 相机：确认预览用 compressed，录制用 raw，检查局域网延迟。
6. 录制：录一段短 bag，检查关节状态、控制命令和 raw 图像话题。
7. 回放与编辑：检查录制视频和数据集，再用 LeRobot Studio 编辑数据。
8. 回归：重新启动 SO-101 `start.sh`，确认原有设备仍可控制、录制和释力。

任何一步发现关节名不一致、单位不清楚、限位缺失、急停不可用或 bag 缺少 raw 图像时，
停止迁移并修复适配器，不要通过前端屏蔽错误继续使用。
