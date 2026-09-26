# 机械臂适配器约定

`robot_data_platform/` 负责浏览器控制、摄像头预览、ROS bag、数据管理和审核；
机械臂型号差异必须放在 ROS 2 适配器中。平台不会把某个型号的串口、关节限位或
标定路径作为通用逻辑的一部分。

## 当前适配器

仓库当前提供 SO-101 适配器：`so101_hardware`、`so101_description` 和
`robot_web_ros_bridge`。其中 `robot_web_ros_bridge` 的当前实现仍使用 SO-101 的
六关节名、标定范围及控制器话题，因此它是 SO-101 的首个实现，不代表任意机械臂
无需适配即可直接运行。

## 接入要求

新增机械臂应提供独立的 ROS 2 驱动包和 launch 文件，并满足以下边界：

- 发布标准 `sensor_msgs/msg/JointState`；关节名称、单位和顺序由该适配器配置。
- 接收安全限幅后的控制命令，并由驱动负责速度、加速度、行程、使能与急停。
- 为每路预览相机发布 `/cameraN/image_raw/compressed`，需要高画质录制时同时发布
  `/cameraN/image_raw`；启动脚本只启动实际配置的相机。
- 将电机标定、串口和机械限位存放在 `config/robot_driver/<型号>/`，不写入平台数据目录。
- 实现“停止控制并释放力”的设备动作；平台只发送请求，不能假定所有驱动的释放方式相同。

新增适配器完成后，在对应启动入口选择其 ROS 2 launch 和 bridge 参数。只有在其
关节映射、紧急停止、相机话题和 ROS bag 回放验证通过后，才应把该型号标记为受支持设备。

逐项迁移操作见 [迁移到其他机械臂](MIGRATE_TO_ANOTHER_ROBOT.md)。
