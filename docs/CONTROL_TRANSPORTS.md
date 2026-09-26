# 浏览器串口与实时控制链路

本文说明机械臂数据平台中的 Web Serial、WebRTC、WebSocket 和 ROS2 控制桥，以及对应的配置和故障定位方法。当前示例设备适配器为 SO-101。

## 数据流

```text
操作电脑                                      机器人主机
┌──────────────────────────┐                 ┌─────────────────────────┐
│ Leader USB 串口           │                 │ robot-server            │
│   ↓ Web Serial            │                 │   ↓ ROS2 bridge         │
│ 浏览器                    │  WebRTC/WS      │ so101_hardware          │
│   读取并标定六个关节       ├────────────────>│   ↓ /dev/ttyACM*        │
│   生成 action 指令         │                 │ Follower                │
└──────────────────────────┘                 └─────────────────────────┘
```

- 网页串口模式下，Leader 插在运行 Chrome/Edge 的操作电脑上。
- Follower 始终插在机器人主机上，由 ROS2/C++ 控制桥访问。
- 控制和状态优先使用 WebRTC DataChannel；不可用时自动回退 WebSocket。
- 默认 `ENABLE_WEBRTC_VIDEO=1`，前两路摄像头通过 WebRTC 发送。可显式设置为 `0` 仅使用 WebSocket 视频。

## Web Serial

浏览器通过 `navigator.serial.requestPort()` 请求用户授权，再以 1,000,000 baud 打开 Leader 串口。网页不能静默选择 Windows 的 `COM3` 或 Linux 的 `/dev/ttyACM1`，每个新站点来源首次使用时都必须由用户确认。

连接流程：

1. 按 Leader ID 从 `/api/calibration/leader/:id` 读取标定。
2. 关闭 Leader 六个电机的扭矩和锁定，使其可以手动拖动。
3. 使用飞特协议 `SYNC_READ (0x82)` 广播读取地址 56 的两字节当前位置。
4. 校验状态包，将原始位置换算为五个关节角度和夹爪百分比。
5. 位置发生变化时发送 `action`；静止时每 200 ms 发送保活状态。

Web Serial 需要桌面版 Chrome 或 Edge，并要求 HTTPS 安全上下文（`localhost` 除外）。局域网部署时应信任项目生成的 CA 证书。

## WebRTC

浏览器先读取 `/api/rtc/config`，创建三条 DataChannel：

| 通道 | 属性 | 用途 |
| --- | --- | --- |
| `robot-control-v1` | 无序、不重传 | 最新关节目标 |
| `robot-state-v1` | 无序、不重传 | 实时关节状态 |
| `robot-safety-v1` | 有序、可靠 | 心跳和停止命令 |

信令使用 `POST /api/rtc/offer`。项目当前采用一次性 SDP 交换，不使用 Trickle ICE；浏览器和服务端各最多等待 5 秒收集 ICE 候选。

控制发送优先级：

1. WebRTC control DataChannel 已打开且缓冲区不超过 16 KiB时，使用 WebRTC。
2. 否则立即回退到控制 WebSocket。
3. WebRTC 断开后每 3 秒尝试重连，不中断仍然健康的 WebSocket 控制。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ENABLE_WEBRTC` | `1` | 设置为 `0` 或 `false` 时禁用 WebRTC |
| `ENABLE_WEBRTC_VIDEO` | `1` | 是否通过 WebRTC 发送前两路视频 |
| `RTC_CONTROL_TIMEOUT_MS` | `2000` | WebRTC 控制心跳超时 |
| `RTC_STUN_URL` | 空 | STUN 地址，例如 `stun:stun.example.com:3478` |
| `RTC_TURN_URL` | 空 | TURN 地址，例如 `turn:turn.example.com:3478` |
| `RTC_TURN_USERNAME` | 空 | TURN 用户名 |
| `RTC_TURN_CREDENTIAL` | 空 | TURN 密码 |
| `RTC_VIDEO_FPS` | `30` | WebRTC 视频最大帧率 |
| `RTC_VIDEO_BITRATE` | `1500000` | 每路 WebRTC 视频最大码率 |

同一局域网直连：

```bash
./start_robot.sh
```

跨网段但 NAT 条件较简单时可加入 STUN：

```bash
RTC_STUN_URL=stun:stun.example.com:3478 ./start_robot.sh
```

公网、FRP、访客 Wi-Fi、双 NAT 或运营商 CGNAT 应配置 TURN：

```bash
RTC_STUN_URL=stun:stun.example.com:3478 \
RTC_TURN_URL=turn:turn.example.com:3478 \
RTC_TURN_USERNAME=robot \
RTC_TURN_CREDENTIAL='replace-with-secret' \
./start_robot.sh
```

FRP 只转发 HTTPS/API 信令时不会自动转发 WebRTC UDP。可靠的公网控制应使用自己管理的 TURN，并同时提供 UDP、TCP，受限网络还应提供 TLS 端口。

## 故障定位

先检查服务端配置和连接数：

```bash
curl -k -sS https://ROBOT_HOST:5173/api/rtc/config
curl -k -sS https://ROBOT_HOST:5173/api/status
```

预期重点字段：

```json
{
  "enabled": true,
  "videoEnabled": false,
  "iceServers": []
}
```

浏览器打开 `chrome://webrtc-internals`，查看最终候选对：

| 候选 | 含义 |
| --- | --- |
| `host` | 本机地址，只适合同网段或可直接路由网络 |
| `srflx` | STUN 获取的公网映射 |
| `relay` | TURN 中继，跨复杂 NAT 最可靠 |

常见现象：

| 现象 | 优先检查 |
| --- | --- |
| `/api/rtc/config` 请求失败 | 登录会话、HTTPS 证书、反向代理路由 |
| `/api/rtc/offer` 返回 400 | 服务端日志、前后端版本、视频 transceiver 数量 |
| Offer/Answer 成功但 ICE `failed` | UDP 防火墙、AP 隔离、VPN、STUN/TURN |
| 局域网成功、公网失败 | TURN 缺失或 TURN relay 端口不可达 |
| 连接约 3 秒后回退 | Wi-Fi 丢包、路由切换、候选路径失效 |
| 控制正常但没有 WebRTC 视频 | 检查是否设置了 `ENABLE_WEBRTC_VIDEO=0`，以及浏览器 WebRTC 协商日志 |

前端日志现在会标出失败阶段：读取服务配置、创建连接、创建 Offer、收集 ICE 候选、提交 Offer或应用 Answer。

## 安全策略

- 当前部署已关闭 Better Auth 的 `disableOriginCheck` 和 `disableCSRFCheck`，因此通过变化的局域网 IP、FRP 或代理来源访问时不会出现 `Invalid origin`。这会降低 CSRF 防护；API 仍然要求有效登录会话，并继续执行 viewer/operator/admin 权限检查。
- Web Serial 只关闭 Leader 扭矩，不向 Follower 写寄存器。
- 服务端只在网页控制模式和 ROS2 bridge 正常运行时接受 `action`。
- WebRTC 控制丢失但 WebSocket 仍在线时自动回退；两个通道都失效时停止遥操作。
- 首次实机测试应保持低速、小幅动作，并保证 Follower 周围无障碍物。
