import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execSync, execFile, execFileSync, spawn, ChildProcess } from "child_process";
import { RobotBridge, BridgeMessage } from "./robotBridge";
import { BagRecorderProcess } from "./bagRecorder";
import { MJPEGStreamManager } from "./streams";
import { RtcGateway } from "./rtcGateway";
import { CameraBridgeMessage, GStreamerCameraBridge } from "./gstreamerCameraBridge";
import { AuthRole, AuthUser, RobotAuth, initializeRobotAuth } from "./auth";

// 配置
const PORT = parseInt(process.env.PORT || "43127");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const ROBOT_DRIVER_CALIBRATION_ROOT = path.join(PROJECT_ROOT, "config", "robot_driver", "calibration");
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(__dirname, "../../bridge");
const TELEOP_SCRIPT = path.join(BRIDGE_DIR, "teleop_robot.py");
const PLAYBACK_SCRIPT = path.join(BRIDGE_DIR, "dataset_playback.py");
const ROSBAG_PLAYBACK_SCRIPT = path.join(BRIDGE_DIR, "rosbag_playback.py");
const DATASET_CATALOG_SCRIPT = path.join(BRIDGE_DIR, "dataset_catalog.py");
const ROSBAG_VIDEO_CONVERTER_SCRIPT = path.join(BRIDGE_DIR, "rosbag_to_mp4.py");
const ROSBAG_CLIP_SCRIPT = path.join(BRIDGE_DIR, "clip_rosbag.py");
const ROSBAG_JOINT_STATE_SCRIPT = path.join(BRIDGE_DIR, "rosbag_joint_states.py");
const DATASET_EXPORT_SCRIPT = path.join(BRIDGE_DIR, "dataset_export.py");
const VIDEO_TRIM_SCRIPT = path.join(BRIDGE_DIR, "trim_videos.py");
const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const ROS_PYTHON_PATH = process.env.ROS_PYTHON_PATH || "/usr/bin/python3.10";
const CONTROL_PYTHON_PATH = PYTHON_PATH;
const LOCAL_ROS_BRIDGE = path.resolve(__dirname, "../../../ros2_ws/install/robot_web_ros_bridge/lib/robot_web_ros_bridge/web_ros_bridge");
const ROS_BRIDGE_COMMAND = process.env.ROS_BRIDGE_COMMAND || (fs.existsSync(LOCAL_ROS_BRIDGE) ? LOCAL_ROS_BRIDGE : "ros2");
const ROS_BRIDGE_ARGS = (process.env.ROS_BRIDGE_ARGS ?? (ROS_BRIDGE_COMMAND === "ros2" ? "run robot_web_ros_bridge web_ros_bridge" : "")).split(/\s+/).filter(Boolean);
const WEB_MANUAL_SLEW_SCALE = 4.0;
const FOLLOWER_CALIBRATION_FILE = process.env.ROS_CALIB_FILE || path.join(ROBOT_DRIVER_CALIBRATION_ROOT, "follower", "R12253102.json");
const FOLLOWER_SERIAL_PORT = process.env.ROS_FOLLOWER_PORT || "/dev/serial/by-id/usb-1a86_USB_Single_Serial_5A7A059427-if00";
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");
const DEFAULT_DATASET_ROOT = path.join(process.env.HOME || "/tmp", "robot_datasets");
const LEGACY_DATASET_ROOT = path.join(process.env.HOME || "/tmp", "lerobot_datasets");
// Keep existing installations on their current data directory unless the
// operator explicitly selects a new one. Fresh installations use a neutral name.
const DATASET_ROOT = path.resolve(process.env.DATASET_ROOT || (
  fs.existsSync(LEGACY_DATASET_ROOT) && !fs.existsSync(DEFAULT_DATASET_ROOT)
    ? LEGACY_DATASET_ROOT
    : DEFAULT_DATASET_ROOT
));
const ENABLE_CAMERA = process.env.ENABLE_CAMERA !== "0" && process.env.ENABLE_CAMERA !== "false";
// 仅数据平台模式：不连接任何机械臂，不启动 ROS2 桥接，也不占用串口。
// 数据管理、回放、审核、裁剪和上传仍然可用，遥操作与实机录制不可用。
const DATA_ONLY = process.env.DATA_ONLY === "1" || process.env.DATA_ONLY === "true";
// ROS compressed image topics are the canonical camera source. CAMERA_SOURCE=usb
// remains available for deployments that need direct GStreamer capture.
const CAMERA_SOURCE = (process.env.CAMERA_SOURCE || "ros").toLowerCase();
const USE_ROS_CAMERA = CAMERA_SOURCE !== "usb" && CAMERA_SOURCE !== "gstreamer";
const CAMERA_FPS = parseInt(process.env.CAMERA_FPS || "30", 10);
const CAMERA_WIDTH = parseInt(process.env.CAMERA_WIDTH || "1280", 10);
const CAMERA_HEIGHT = parseInt(process.env.CAMERA_HEIGHT || "720", 10);
// 远程网页预览推流使用独立分辨率；录制仍用 CAMERA_* 高清参数。
const WEB_STREAM_WIDTH = parseInt(process.env.WEB_STREAM_WIDTH || CAMERA_WIDTH.toString(), 10);
const WEB_STREAM_HEIGHT = parseInt(process.env.WEB_STREAM_HEIGHT || CAMERA_HEIGHT.toString(), 10);
const WEB_STREAM_FPS = parseInt(process.env.WEB_STREAM_FPS || CAMERA_FPS.toString(), 10);
const RECORDING_MAX_SENSOR_AGE_MS = parseInt(process.env.RECORDING_MAX_SENSOR_AGE_MS || "250", 10);
const RECORDING_MAX_CAMERA_SKEW_MS = parseInt(process.env.RECORDING_MAX_CAMERA_SKEW_MS || "100", 10);
const CONTROL_OBSERVATION_FPS = parseInt(process.env.CONTROL_OBSERVATION_FPS || "30", 10);
const ENABLE_WEBRTC = process.env.ENABLE_WEBRTC !== "0" && process.env.ENABLE_WEBRTC !== "false";
const ENABLE_WEBRTC_VIDEO = process.env.ENABLE_WEBRTC_VIDEO === "1" || process.env.ENABLE_WEBRTC_VIDEO === "true";
const RTC_VIDEO_FPS = parseInt(process.env.RTC_VIDEO_FPS || "15", 10);
const RTC_VIDEO_BITRATE = parseInt(process.env.RTC_VIDEO_BITRATE || "1500000", 10);
const RTC_CONTROL_TIMEOUT_MS = parseInt(process.env.RTC_CONTROL_TIMEOUT_MS || "2000", 10);
const RTC_ICE_SERVERS = [
  ...(process.env.RTC_STUN_URL ? [{ urls: process.env.RTC_STUN_URL }] : []),
  ...(process.env.RTC_TURN_URL ? [{
    urls: process.env.RTC_TURN_URL,
    username: process.env.RTC_TURN_USERNAME,
    credential: process.env.RTC_TURN_CREDENTIAL,
  }] : []),
];
const RECORDER_JOINT_NAMES = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
] as const;
const configuredBagTopics = (process.env.BAG_RECORD_TOPICS || [
  "/joint_states",
  "/arm_position_controller/commands",
  "/gripper_position_controller/commands",
  "/camera1/image_raw",
  "/camera2/image_raw",
].join(",")).split(",").map((topic) => topic.trim()).filter(Boolean);
const BAG_CAMERA_TOPICS = new Set([
  "/camera1/image_raw", "/camera2/image_raw", "/camera3/image_raw", "/camera4/image_raw",
  "/camera1/image_raw/compressed", "/camera2/image_raw/compressed",
  "/camera3/image_raw/compressed", "/camera4/image_raw/compressed",
]);
const BAG_RECORD_TOPICS = [...new Set([
  ...configuredBagTopics.filter((topic) => !BAG_CAMERA_TOPICS.has(topic)),
  "/camera1/image_raw", "/camera2/image_raw",
])];
const TRAINING_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "training");
const RUNTIME_LOG_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "logs");
const CONTROL_LATENCY_LOG_ROOT = path.join(RUNTIME_LOG_ROOT, "latency");
const DATASET_TRASH_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "trash");

type RuntimeLogLevel = "info" | "warn" | "error";
type RuntimeLogSource = "teleop" | "recorder" | "system";

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localLogSessionKey(date = new Date()): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join("-");
  return `${localDateKey(date)}_${time}_${process.pid}`;
}

const RUNTIME_LOG_SESSION_ID = localLogSessionKey();
const pendingLogWrites = new Map<string, string[]>();
const pendingLogFlushes = new Map<string, NodeJS.Timeout>();

function queueJsonlLog(root: string, filename: string, entry: Record<string, unknown>): void {
  const file = path.join(root, filename);
  const lines = pendingLogWrites.get(file) || [];
  lines.push(`${JSON.stringify(entry)}\n`);
  pendingLogWrites.set(file, lines);
  if (pendingLogFlushes.has(file)) return;

  const timer = setTimeout(() => {
    pendingLogFlushes.delete(file);
    const buffered = pendingLogWrites.get(file);
    pendingLogWrites.delete(file);
    if (!buffered?.length) return;
    fs.mkdir(root, { recursive: true }, (mkdirError) => {
      if (mkdirError) {
        console.error("[Logs] 创建日志目录失败:", mkdirError);
        return;
      }
      fs.appendFile(file, buffered.join(""), "utf-8", (writeError) => {
        if (writeError) console.error("[Logs] 写入本地日志失败:", writeError);
      });
    });
  }, 250);
  timer.unref();
  pendingLogFlushes.set(file, timer);
}

function persistRuntimeLog(source: RuntimeLogSource, level: RuntimeLogLevel, message: string): void {
  queueJsonlLog(RUNTIME_LOG_ROOT, `${RUNTIME_LOG_SESSION_ID}.jsonl`, {
    timestamp: new Date().toISOString(), source, level, message,
  });
}

function auditUserLabel(user: AuthUser): string {
  const localAccountSuffix = "@robot.local";
  const account = user.email.endsWith(localAccountSuffix) ? user.email.slice(0, -localAccountSuffix.length) : user.email;
  return `${user.name}(${account})`;
}

function requestClientIp(req: import("http").IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (value?.trim() || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function persistAuditLog(message: string): void {
  persistRuntimeLog("system", "info", `[审计] ${message}`);
}

type MotionAudit = {
  active: boolean;
  startedAt: number;
  lastActionAt: number;
  timer: NodeJS.Timeout | null;
  channel: "WebSocket" | "HTTP" | "WebRTC";
  user: string;
  ip: string;
};

function recordMotion(audit: MotionAudit): void {
  const now = Date.now();
  audit.lastActionAt = now;
  if (!audit.active) {
    audit.active = true;
    audit.startedAt = now;
    persistAuditLog(`机械臂开始运动；用户=${audit.user}；IP=${audit.ip}；通道=${audit.channel}`);
  }
  if (audit.timer) clearTimeout(audit.timer);
  audit.timer = setTimeout(() => {
    audit.timer = null;
    if (!audit.active) return;
    audit.active = false;
    const durationSeconds = Math.max(0.1, (audit.lastActionAt - audit.startedAt) / 1000);
    persistAuditLog(`机械臂停止运动；用户=${audit.user}；IP=${audit.ip}；通道=${audit.channel}；持续=${durationSeconds.toFixed(1)}秒`);
  }, 1000);
  audit.timer.unref();
}

function finishMotionAudit(audit: MotionAudit): void {
  if (audit.timer) clearTimeout(audit.timer);
  audit.timer = null;
  if (!audit.active) return;
  audit.active = false;
  const durationSeconds = Math.max(0.1, (audit.lastActionAt - audit.startedAt) / 1000);
  persistAuditLog(`机械臂停止运动；用户=${audit.user}；IP=${audit.ip}；通道=${audit.channel}；持续=${durationSeconds.toFixed(1)}秒`);
}

function persistControlLatency(metrics: Record<string, number | null>): void {
  queueJsonlLog(CONTROL_LATENCY_LOG_ROOT, `${RUNTIME_LOG_SESSION_ID}.jsonl`, {
    timestamp: new Date().toISOString(),
    ...metrics,
  });
}

persistRuntimeLog("system", "info", `Robot Server 启动，会话 ${RUNTIME_LOG_SESSION_ID}`);

function detectUsbCameraIndices(): number[] {
  try {
    const out = execSync("v4l2-ctl --list-devices 2>/dev/null", { encoding: "utf-8" });
    const indices: number[] = [];
    const blocks = out.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;
      const name = lines[0].toLowerCase();
      if (name.includes("tegra") || name.includes("vi-output")) continue;
      // 每个 USB 摄像头设备块中有多个 video 节点，只取第一个
      for (let i = 1; i < lines.length; i++) {
        const m = lines[i].trim().match(/\/dev\/video(\d+)/);
        if (m) {
          indices.push(parseInt(m[1], 10));
          break;
        }
      }
    }
    indices.sort((a, b) => a - b);
    return indices;
  } catch {
    return [];
  }
}

const app = express();
app.use(cors());

let robotAuth: RobotAuth | null = null;

function authSession(req: import("http").IncomingMessage) {
  if (!robotAuth) return Promise.resolve(null);
  return robotAuth.getSession(req.headers);
}

function rejectUnauthorized(res: express.Response): void {
  res.status(401).json({ ok: false, error: "需要登录" });
}

function isOperator(user: AuthUser | null): boolean {
  return user?.role === "operator" || user?.role === "admin";
}

function isAdmin(user: AuthUser | null): boolean {
  return user?.role === "admin";
}

// Better Auth must receive the raw request body, so its handler is mounted
// before express.json().
app.post("/api/auth/sign-up/email", (req, res, next) => {
  if (!robotAuth) return res.status(503).json({ ok: false, error: "认证服务尚未就绪" });
  if (robotAuth.userCount() > 0) return res.status(403).json({ ok: false, error: "注册已关闭，请联系管理员创建账号" });
  next();
});
app.all("/api/auth/*splat", (req, res) => {
  if (!robotAuth) return res.status(503).json({ ok: false, error: "认证服务尚未就绪" });
  void robotAuth.handle(req, res).catch((error) => {
    console.error("[Auth] 请求处理失败:", error);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "认证服务异常" });
  });
});
app.use(express.json());

app.get("/api/auth-bootstrap-status", (_req, res) => {
  res.json({ ok: true, setupRequired: robotAuth ? robotAuth.userCount() === 0 : true });
});
app.post("/api/auth-bootstrap-claim", async (req, res) => {
  const session = await authSession(req);
  if (!session || !robotAuth || !robotAuth.promoteFirstUser(session.user.id)) {
    return res.status(403).json({ ok: false, error: "管理员初始化已完成" });
  }
  res.json({ ok: true, role: "operator" });
});

// All application APIs require a session. Unsafe methods require an operator
// or administrator; read-only telemetry and latency metrics remain available
// to viewers.
app.use("/api", async (req, res, next) => {
  if (req.path.startsWith("/auth") || req.path === "/auth-bootstrap-status" || req.path === "/auth-bootstrap-claim") return next();
  const session = await authSession(req);
  if (!session) return rejectUnauthorized(res);
  (req as import("express").Request & { authUser?: AuthUser }).authUser = session.user;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.path !== "/logs/latency") {
    if (!isOperator(session.user)) return res.status(403).json({ ok: false, error: "当前账号只有查看权限" });
  }
  next();
});
app.use("/video", async (req, res, next) => {
  if (!(await authSession(req))) return rejectUnauthorized(res);
  next();
});

function adminSession(req: express.Request, res: express.Response): AuthUser | null {
  const user = (req as express.Request & { authUser?: AuthUser }).authUser || null;
  if (!isAdmin(user)) {
    res.status(403).json({ ok: false, error: "只有管理员可以管理账号" });
    return null;
  }
  return user;
}

app.get("/api/admin/users", (req, res) => {
  if (!adminSession(req, res) || !robotAuth) return;
  res.json({ ok: true, users: robotAuth.listUsers() });
});

app.post("/api/admin/users", async (req, res) => {
  if (!adminSession(req, res) || !robotAuth) return;
  const account = String(req.body?.account || "").trim();
  const name = String(req.body?.name || account).trim();
  const password = String(req.body?.password || "");
  const requestedRole = String(req.body?.role || "");
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(account)) return res.status(400).json({ ok: false, error: "账号需为3-32位字母、数字、下划线或短横线" });
  if (password.length < 5) return res.status(400).json({ ok: false, error: "密码至少5位" });
  if (!name || !["viewer", "operator", "admin"].includes(requestedRole)) return res.status(400).json({ ok: false, error: "请填写有效的名称和权限" });
  const role = requestedRole as AuthRole;
  try {
    const user = await robotAuth.createUser(name, account, password, role);
    res.json({ ok: true, user: robotAuth.listUsers().find((item) => item.id === user.id) });
  } catch (error) {
    const message = String(error).toLowerCase().includes("unique") ? "账号已存在" : "创建账号失败";
    res.status(400).json({ ok: false, error: message });
  }
});

app.patch("/api/admin/users/:id/role", (req, res) => {
  const current = adminSession(req, res);
  if (!current || !robotAuth) return;
  const requestedRole = String(req.body?.role || "");
  if (!["viewer", "operator", "admin"].includes(requestedRole)) return res.status(400).json({ ok: false, error: "权限无效" });
  const role = requestedRole as AuthRole;
  const users = robotAuth.listUsers();
  const target = users.find((user) => user.id === req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "账号不存在" });
  if (target.id === current.id && role !== "admin") return res.status(400).json({ ok: false, error: "不能降低当前管理员权限" });
  if (target.role === "admin" && role !== "admin" && users.filter((user) => user.role === "admin").length <= 1) return res.status(400).json({ ok: false, error: "至少保留一个管理员" });
  if (!robotAuth.updateUserRole(target.id, role)) return res.status(500).json({ ok: false, error: "修改权限失败" });
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/password", async (req, res) => {
  if (!adminSession(req, res) || !robotAuth) return;
  const password = String(req.body?.password || "");
  if (password.length < 5) return res.status(400).json({ ok: false, error: "密码至少5位" });
  if (!robotAuth.listUsers().some((user) => user.id === req.params.id)) return res.status(404).json({ ok: false, error: "账号不存在" });
  if (!await robotAuth.resetUserPassword(req.params.id, password)) return res.status(400).json({ ok: false, error: "密码重置失败" });
  res.json({ ok: true });
});

app.delete("/api/admin/users/:id", (req, res) => {
  const current = adminSession(req, res);
  if (!current || !robotAuth) return;
  const users = robotAuth.listUsers();
  const target = users.find((user) => user.id === req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "账号不存在" });
  if (target.id === current.id) return res.status(400).json({ ok: false, error: "不能删除当前账号" });
  if (target.role === "admin" && users.filter((user) => user.role === "admin").length <= 1) return res.status(400).json({ ok: false, error: "至少保留一个管理员" });
  if (!robotAuth.deleteUser(target.id)) return res.status(500).json({ ok: false, error: "删除账号失败" });
  res.json({ ok: true });
});

const httpsCert = process.env.HTTPS_CERT;
const httpsKey = process.env.HTTPS_KEY;
const USE_HTTPS = Boolean(httpsCert && httpsKey);
const server = httpsCert && httpsKey
  ? createHttpsServer({ cert: fs.readFileSync(httpsCert), key: fs.readFileSync(httpsKey) }, app)
  : createHttpServer(app);
// 控制和视频必须使用不同连接；视频拥塞时不能阻塞 30/60Hz 控制链路。
const controlWss = new WebSocketServer({ noServer: true });
const streamWss = new WebSocketServer({ noServer: true });

// 显式路由 WebSocket Upgrade，避免多个 WebSocketServer 监听同一 HTTP Server
// 时请求被错误当成普通 HTTP/SPA 请求，导致浏览器出现 Invalid frame header。
server.on("upgrade", async (request, socket, head) => {
  const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
  const session = await authSession(request);
  if (!session || (pathname === "/ws/control" && !isOperator(session.user))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (pathname === "/ws/control") {
    controlWss.handleUpgrade(request, socket, head, (ws) => controlWss.emit("connection", ws, request));
  } else if (pathname === "/ws/stream") {
    streamWss.handleUpgrade(request, socket, head, (ws) => streamWss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

const streamManager = new MJPEGStreamManager();

// 桥接状态
let bridge: RobotBridge | null = null;
let telemetryBridge: RobotBridge | null = null;
let stopping = false;
// The hardware starts in passive feedback mode with torque off. Position
// controllers are enabled only for an explicit control session.
let hardwareReleased = true;
let hardwareNeedsActivation = false;
let shuttingDown = false;
let remoteLeaderActive = false;
let activeControlSource: "web" | "com" | null = null;
let latestObservation: BridgeMessage | null = null;
let latestObservationAt = 0;
const clients = new Set<WebSocket>();
const controlClientUsers = new Map<WebSocket, string>();
type StreamClientState = {
  ws: WebSocket;
  pending: Map<number, { count: number; lastSentAt: number }>;
};
const streamClients = new Map<WebSocket, StreamClientState>();
let controlDisconnectTimer: NodeJS.Timeout | null = null;

function stopTeleop(): boolean {
  if (!bridge || !bridge.isRunning()) return false;
  stopPlayback();
  requestRecordingSave();
  stopping = true;
  bridge.stop();
  broadcastControl({ type: "status", running: false });
  return true;
}

function setHardwareComponentState(state: "inactive" | "active"): Promise<void> {
  return new Promise((resolve, reject) => {
    const spinTime = state === "inactive" ? "1" : "3";
    const timeout = state === "inactive" ? 5_000 : 15_000;
    execFile("ros2", ["control", "set_hardware_component_state", "RobotSystem", state, "--spin-time", spinTime],
      { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const detail = `${stdout}\n${stderr}`;
        // joint_state_broadcaster activates the hardware to publish passive
        // feedback at startup. Treat an idempotent lifecycle request as a
        // success so the position controllers can still be enabled below.
        if (error && !new RegExp(`already.*${state}|${state}.*already`, "i").test(detail)) {
          reject(new Error(stderr.trim().split("\n").pop() || error.message));
          return;
        }
        resolve();
      });
  });
}

function disableFollowerTorqueDirectly(): void {
  let serialPort: string;
  try {
    serialPort = fs.realpathSync(FOLLOWER_SERIAL_PORT);
  } catch {
    throw new Error(`找不到 Follower 串口: ${FOLLOWER_SERIAL_PORT}`);
  }
  if (!/^\/dev\/tty(?:ACM|USB)\d+$/.test(serialPort)) {
    throw new Error(`拒绝向非 Follower 串口释力: ${serialPort}`);
  }

  // Feetech protocol: WRITE Torque_Enable (address 40) = 0 for IDs 1-6.
  // This path deliberately bypasses ROS so an unavailable controller_manager
  // can never prevent the emergency stop from releasing the arm.
  const packets = Buffer.from([
    0xff, 0xff, 0x01, 0x04, 0x03, 0x28, 0x00, 0xcf,
    0xff, 0xff, 0x02, 0x04, 0x03, 0x28, 0x00, 0xce,
    0xff, 0xff, 0x03, 0x04, 0x03, 0x28, 0x00, 0xcd,
    0xff, 0xff, 0x04, 0x04, 0x03, 0x28, 0x00, 0xcc,
    0xff, 0xff, 0x05, 0x04, 0x03, 0x28, 0x00, 0xcb,
    0xff, 0xff, 0x06, 0x04, 0x03, 0x28, 0x00, 0xca,
  ]);
  execFileSync("stty", ["-F", serialPort, "1000000", "raw", "-echo"], {
    timeout: 500,
    stdio: "ignore",
  });
  const fd = fs.openSync(serialPort, "w");
  try {
    fs.writeSync(fd, packets);
  } finally {
    fs.closeSync(fd);
  }
}

async function setManualControllersActive(): Promise<void> {
  const controllers = ["arm_position_controller", "gripper_position_controller"];
  const activate = (toActivate: string[]) => new Promise<void>((resolve, reject) => {
    execFile("ros2", [
      "control", "switch_controllers",
      "--activate", ...toActivate,
      "--strict", "--spin-time", "1",
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim().split("\n").pop() || error.message));
        return;
      }
      resolve();
    });
  });
  try {
    // Fresh startup has both controllers inactive; avoid a separate
    // list_controllers discovery round trip on the critical start path.
    await activate(controllers);
    return;
  } catch {
    // A repeated start may find one or both controllers already active.
    const activeControllers = await new Promise<Set<string>>((resolve, reject) => {
      execFile("ros2", ["control", "list_controllers", "--spin-time", "1"],
        { timeout: 8_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim().split("\n").pop() || error.message));
            return;
          }
          const active = new Set<string>();
          for (const controller of controllers) {
            if (new RegExp(`^${controller}\\s+.*\\sactive\\s*$`, "m").test(stdout)) active.add(controller);
          }
          resolve(active);
        });
    });
    const toActivate = controllers.filter((controller) => !activeControllers.has(controller));
    if (toActivate.length > 0) await activate(toActivate);
  }
}

function startTelemetryBridge(): void {
  if (DATA_ONLY) return;
  if (shuttingDown || bridge?.isRunning() || telemetryBridge?.isRunning()) return;
  const observer = new RobotBridge(ROS_BRIDGE_COMMAND, ROS_BRIDGE_ARGS, CONTROL_PYTHON_PATH, true);
  telemetryBridge = observer;
  observer.on("message", (msg: BridgeMessage) => {
    if (handleRosCameraFrame(msg)) return;
    if (msg.type !== "teleop_observation" || bridge?.isRunning()) return;
    latestObservation = msg; latestObservationAt = Date.now(); broadcastControl(msg);
  });
  observer.on("exit", () => {
    if (telemetryBridge === observer) telemetryBridge = null;
    if (!shuttingDown && !bridge?.isRunning()) setTimeout(startTelemetryBridge, 1000).unref();
  });
  observer.on("error", (error) => console.error("[Telemetry] 只读关节桥错误:", error));
  observer.start();
}

let rtcMotionAudit: MotionAudit | null = null;
const rtcGateway = new RtcGateway({
  enabled: ENABLE_WEBRTC,
  videoEnabled: ENABLE_WEBRTC_VIDEO,
  iceServers: RTC_ICE_SERVERS,
  maxVideoFps: RTC_VIDEO_FPS,
  maxVideoBitrate: RTC_VIDEO_BITRATE,
  controlTimeoutMs: RTC_CONTROL_TIMEOUT_MS,
  onControl: (message) => {
    if (message?.type === "action" && bridge?.isRunning() && activeControlSource === "web" && !stopping) {
      bridge.send(message as BridgeMessage);
      if (rtcMotionAudit) recordMotion(rtcMotionAudit);
    }
  },
  onSafetyStop: () => { stopTeleop(); },
  onControlLost: (reason, idleMs) => {
    if (rtcMotionAudit) finishMotionAudit(rtcMotionAudit);
    const detail = `${reason}, ${Math.round(idleMs)}ms 未收到控制消息`;
    // The browser keeps a separate control WebSocket open as a transport
    // fallback. A transient RTC failure must not tear down an otherwise healthy
    // teleop session; the Python command timeout already holds position until
    // fresh fallback actions arrive.
    if (activeControlSource === "web" && clients.size > 0) {
      console.warn(`[WebRTC] 控制链路异常 (${detail})，已切换到 WebSocket 控制`);
      return;
    }
    if (activeControlSource === "web" && stopTeleop()) {
      console.warn(`[WebRTC] 控制链路异常 (${detail}) 且 WebSocket 不可用，已停止遥操作`);
    }
  },
});

// 摄像头是可选资源：关闭时不启动 GStreamer，也不占用 USB 摄像头。
let cameraBridge: GStreamerCameraBridge | null = null;
let activeCameraIndex = -1;
let cameraLastFrameAt = 0;
let cameraError: string | null = null;
let cameraMetrics: Record<string, unknown> = {};
let latestCameraFrame: Buffer | null = null;
let cameraLocalFrameAt = 0;
function startCamera(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge) cameraBridge.stop();
  activeCameraIndex = index;
  cameraLastFrameAt = 0;
  cameraError = null;
  cameraMetrics = {};
  if (USE_ROS_CAMERA) {
    if (cameraBridge) cameraBridge.stop();
    cameraBridge = null;
    cameraMetrics = { source: "ros", topic: "/camera1/image_raw/compressed" };
    console.log(`[Camera] 网页流已绑定 ROS 话题 /camera1/image_raw/compressed`);
    return;
  }
  cameraBridge = new GStreamerCameraBridge(
    index, WEB_STREAM_WIDTH, WEB_STREAM_HEIGHT, WEB_STREAM_FPS,
  );
  cameraBridge.on("message", (msg: CameraBridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      cameraLastFrameAt = Date.now();
      const jpeg = msg.data;
      latestCameraFrame = jpeg;
      cameraLocalFrameAt = Date.now();
      streamManager.updateFrame("camera", jpeg);
      broadcastBinaryFrame(STREAM_TYPE_CAMERA, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
    } else if (msg.type === "camera_error") {
      cameraError = String(msg.error || "摄像头不可用");
      console.error(`[Camera] ${cameraError}`);
    } else if (msg.type === "camera_ready") {
      cameraError = null;
      cameraMetrics = { ...cameraMetrics, ...msg };
    } else if (msg.type === "camera_status") {
      cameraMetrics = { ...cameraMetrics, ...msg };
    }
  });
  cameraBridge.start();
  console.log(`[Camera] 已启用 /dev/video${index} (USB MJPEG, ${CAMERA_WIDTH}x${CAMERA_HEIGHT}@${CAMERA_FPS} FPS)`);
}

// 第二个摄像头（可选）
let cameraBridge2: GStreamerCameraBridge | null = null;
let activeCameraIndex2 = -1;
let camera2LastFrameAt = 0;
let camera2Error: string | null = null;
let camera2Metrics: Record<string, unknown> = {};
let latestCamera2Frame: Buffer | null = null;
let camera2LocalFrameAt = 0;

function handleRosCameraFrame(msg: BridgeMessage): boolean {
  if (!ENABLE_CAMERA || !USE_ROS_CAMERA || msg.type !== "camera_frame") return false;
  const camera = Number(msg.camera);
  if (!Number.isInteger(camera) || camera < 1 || camera > 2 || typeof msg.data !== "string") return false;
  let jpeg: Buffer;
  try {
    jpeg = Buffer.from(msg.data, "base64");
  } catch {
    return false;
  }
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
  const now = Date.now();
  const ts = typeof msg.ts === "number" && Number.isFinite(msg.ts) ? msg.ts : now / 1000;
  if (camera === 1) {
    cameraLastFrameAt = now; cameraError = null; latestCameraFrame = jpeg; cameraLocalFrameAt = now;
    cameraMetrics = { ...cameraMetrics, source: "ros", topic: "/camera1/image_raw/compressed" };
  } else if (camera === 2) {
    camera2LastFrameAt = now; camera2Error = null; latestCamera2Frame = jpeg; camera2LocalFrameAt = now;
    camera2Metrics = { ...camera2Metrics, source: "ros", topic: "/camera2/image_raw/compressed" };
  }
  streamManager.updateFrame(camera === 1 ? "camera" : `camera${camera}`, jpeg);
  broadcastBinaryFrame(camera, ts, jpeg);
  return true;
}

function startCamera2(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge2) cameraBridge2.stop();
  activeCameraIndex2 = index;
  camera2LastFrameAt = 0;
  camera2Error = null;
  camera2Metrics = {};
  if (USE_ROS_CAMERA) {
    if (cameraBridge2) cameraBridge2.stop();
    cameraBridge2 = null;
    camera2Metrics = { source: "ros", topic: "/camera2/image_raw/compressed" };
    console.log(`[Camera2] 网页流已绑定 ROS 话题 /camera2/image_raw/compressed`);
    return;
  }
  cameraBridge2 = new GStreamerCameraBridge(
    index, WEB_STREAM_WIDTH, WEB_STREAM_HEIGHT, WEB_STREAM_FPS,
  );
  cameraBridge2.on("message", (msg: CameraBridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      camera2LastFrameAt = Date.now();
      const jpeg = msg.data;
      latestCamera2Frame = jpeg;
      camera2LocalFrameAt = Date.now();
      streamManager.updateFrame("camera2", jpeg);
      broadcastBinaryFrame(STREAM_TYPE_CAMERA2, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
    } else if (msg.type === "camera_error") {
      camera2Error = String(msg.error || "摄像头不可用");
      console.error(`[Camera2] ${camera2Error}`);
    } else if (msg.type === "camera_ready") {
      camera2Error = null;
      camera2Metrics = { ...camera2Metrics, ...msg };
    } else if (msg.type === "camera_status") {
      camera2Metrics = { ...camera2Metrics, ...msg };
    }
  });
  cameraBridge2.start();
  console.log(`[Camera2] 已启用 /dev/video${index} (USB MJPEG, ${CAMERA_WIDTH}x${CAMERA_HEIGHT}@${CAMERA_FPS} FPS)`);
}

if (ENABLE_CAMERA) {
  const usbIndices = detectUsbCameraIndices();
  const selectedCameraIndices = usbIndices.slice(0, 2);
  if (selectedCameraIndices.length > 0) {
    console.log(`[Camera] 检测到 ${selectedCameraIndices.length} 个 USB 摄像头: ${selectedCameraIndices.map(i => `/dev/video${i}`).join(", ")}`);
    if (USE_ROS_CAMERA) {
      activeCameraIndex = selectedCameraIndices[0] ?? -1;
      activeCameraIndex2 = selectedCameraIndices[1] ?? -1;
      if (activeCameraIndex >= 0) cameraMetrics = { source: "ros", topic: "/camera1/image_raw/compressed" };
      if (activeCameraIndex2 >= 0) camera2Metrics = { source: "ros", topic: "/camera2/image_raw/compressed" };
      console.log("[Camera] 使用 ROS image_raw/compressed 话题，网页不直接打开 V4L2 设备");
    } else {
      startCamera(selectedCameraIndices[0]);
      if (selectedCameraIndices.length > 1) startCamera2(selectedCameraIndices[1]);
    }
  } else {
    console.log("[Camera] 未检测到 USB 摄像头");
  }
} else {
  console.log("[Camera] 默认关闭；需要摄像头时设置 ENABLE_CAMERA=1");
}

type RecordingState = "idle" | "preparing" | "recording" | "saving" | "error";
interface RecordingStatus {
  state: RecordingState;
  dataset: string | null;
  task: string | null;
  startedAt: number | null;
  episode: number | null;
  path: string | null;
  error: string | null;
  plannedEpisodes: number;
  episodeTime: number;
  resetTime: number;
  resume: boolean;
  lastResult: "saved" | "discarded" | null;
}

let recorder: BagRecorderProcess | null = null;
let recordingEpisodeDir: string | null = null;
let recordingSidecarPath: string | null = null;
let recordingAutoStopTimer: NodeJS.Timeout | null = null;
let recordingStopInFlight = false;
const CONTROL_DISCONNECT_GRACE_MS = 10_000;
type PlaybackState = "idle" | "preparing" | "playing" | "stopping" | "error";
interface PlaybackStatus { state: PlaybackState; dataset: string | null; episode: number | null; frame: number; frames: number; fps: number; speed: number; error: string | null; }
let playback: RobotBridge | null = null;
let playbackStatus: PlaybackStatus = { state: "idle", dataset: null, episode: null, frame: 0, frames: 0, fps: 0, speed: 1, error: null };
let recordingStatus: RecordingStatus = {
  state: "idle", dataset: null, task: null, startedAt: null,
  episode: null, path: null, error: null, plannedEpisodes: 1, episodeTime: 20, resetTime: 0, resume: true,
  lastResult: null,
};

function publishRecordingStatus(): void {
  broadcastControl({ type: "recording_status", ...recordingStatus });
}

function clearRecordingAutoStopTimer(): void {
  if (recordingAutoStopTimer) {
    clearTimeout(recordingAutoStopTimer);
    recordingAutoStopTimer = null;
  }
}

function finalizeRecordingSidecar(endedAt: number): void {
  if (!recordingSidecarPath) return;
  try {
    const raw = fs.existsSync(recordingSidecarPath)
      ? JSON.parse(fs.readFileSync(recordingSidecarPath, "utf8"))
      : {};
    fs.writeFileSync(recordingSidecarPath, JSON.stringify({ ...raw, endedAt }, null, 2));
  } catch (error) {
    console.error("[Server] 写入录制元数据失败:", error);
  }
}

function convertRecordingVideos(episodeDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ROS_PYTHON_PATH, [ROSBAG_VIDEO_CONVERTER_SCRIPT, episodeDir], { timeout: 600_000, maxBuffer: 2 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || `视频转换失败: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

async function ensureRosbagVideos(dataset: string, detail: Record<string, unknown>): Promise<boolean> {
  const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
  let converted = false;
  for (const episode of episodes) {
    const item = episode as Record<string, unknown>;
    const index = Number(item.episode);
    const videos = item.videos;
    if (!Number.isInteger(index)) continue;
    const directory = path.join(datasetPath(dataset), `episode_${String(index).padStart(4, "0")}`);
    if (!fs.existsSync(directory) || !fs.readdirSync(directory).some((name) => name.endsWith(".mcap"))) continue;
    const manifestPath = path.join(directory, "video_manifest.json");
    let h264Ready = false;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, { codec?: string }>;
      h264Ready = Object.keys(videos || {}).length > 0
        && Object.values(manifest).some((entry) => entry?.codec === "h264-baseline");
    } catch { /* Convert missing or legacy video manifests. */ }
    if (h264Ready) continue;
    await convertRecordingVideos(directory);
    converted = true;
  }
  return converted;
}

function requestRecordingSave(): boolean {
  if (!recorder?.isRunning() || !["preparing", "recording"].includes(recordingStatus.state)) return false;
  clearRecordingAutoStopTimer();
  recordingStatus = { ...recordingStatus, state: "saving" };
  publishRecordingStatus();
  recordingStopInFlight = true;
  const activeRecorder = recorder;
  void activeRecorder.stop().then(async () => {
    if (recorder !== activeRecorder) return;
    recorder = null;
    recordingStopInFlight = false;
    finalizeRecordingSidecar(Date.now());
    try {
      await convertRecordingVideos(activeRecorder.getOutputDir());
    } catch (error) {
      console.error("[Server] 录制视频转换失败:", error);
    }
    clearDatasetCatalogCache(recordingStatus.dataset || undefined);
    const savedDataset = recordingStatus.dataset;
    recordingStatus = { ...recordingStatus, state: "idle", lastResult: "saved" };
    publishRecordingStatus();
    // 上传设置里开启“自动上传”时，录制保存完成后立即把该数据集入队推送训练主机。
    if (savedDataset && readUploadSettings().enabled && !activeUploadTaskFor(savedDataset)) {
      queueDatasetUpload(savedDataset, "自动上传");
    }
  });
  return true;
}

function requestRecordingCancel(): boolean {
  if (!recorder?.isRunning() || !["preparing", "recording"].includes(recordingStatus.state)) return false;
  clearRecordingAutoStopTimer();
  recordingStatus = { ...recordingStatus, state: "saving" };
  publishRecordingStatus();
  recordingStopInFlight = true;
  const activeRecorder = recorder;
  const dirToRemove = recordingEpisodeDir;
  const sidecarToRemove = recordingSidecarPath;
  void activeRecorder.stop().then(() => {
    if (recorder !== activeRecorder) return;
    recorder = null;
    recordingStopInFlight = false;
    try {
      if (dirToRemove) fs.rmSync(dirToRemove, { recursive: true, force: true });
    } catch (error) {
      console.error("[Server] 删除录制目录失败:", error);
    }
    try {
      if (sidecarToRemove) fs.rmSync(sidecarToRemove, { force: true });
    } catch {
      // best-effort
    }
    recordingStatus = { ...recordingStatus, state: "idle", lastResult: "discarded" };
    publishRecordingStatus();
  });
  return true;
}

function recordingIsActive(): boolean {
  return ["preparing", "recording", "saving"].includes(recordingStatus.state);
}

function playbackIsActive(): boolean {
  return ["preparing", "playing", "stopping"].includes(playbackStatus.state);
}

function publishPlaybackStatus(): void {
  broadcastControl({ type: "playback_status", ...playbackStatus });
}

function stopPlayback(): boolean {
  if (!playback?.isRunning()) return false;
  playbackStatus = { ...playbackStatus, state: "stopping" };
  publishPlaybackStatus();
  playback.stop();
  return true;
}

function cleanDatasetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : null;
}

function datasetPath(name: string): string {
  return path.join(DATASET_ROOT, name);
}

const datasetCatalogCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const datasetCatalogPending = new Map<string, Promise<Record<string, unknown>>>();

function clearDatasetCatalogCache(dataset?: string): void {
  for (const key of datasetCatalogCache.keys()) {
    if (!dataset || key === "list:" || key.endsWith(`:${dataset}`)) datasetCatalogCache.delete(key);
  }
}

function runDatasetCatalog(command: "list" | "detail" | "quality", dataset?: string, refresh = false): Promise<Record<string, unknown>> {
  const cacheKey = `${command}:${dataset || ""}`;
  const cached = datasetCatalogCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  const pending = datasetCatalogPending.get(cacheKey);
  if (!refresh && pending) return pending;
  const args = [DATASET_CATALOG_SCRIPT, command, "--root", DATASET_ROOT];
  if (dataset) args.push("--dataset", dataset);
  const request = new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(PYTHON_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim().split("\n").pop() || error.message));
        return;
      }
      try {
        const value = JSON.parse(stdout) as Record<string, unknown>;
        datasetCatalogCache.set(cacheKey, { expiresAt: Date.now() + (command === "list" ? 10_000 : 30_000), value });
        resolve(value);
      } catch {
        reject(new Error("数据目录返回了无效响应"));
      }
    });
  });
  datasetCatalogPending.set(cacheKey, request);
  void request.then(() => {
    if (datasetCatalogPending.get(cacheKey) === request) datasetCatalogPending.delete(cacheKey);
  }, () => {
    if (datasetCatalogPending.get(cacheKey) === request) datasetCatalogPending.delete(cacheKey);
  });
  return request;
}

interface EpisodeReview {
  status: "unreviewed" | "approved" | "rejected";
  tags: string[];
  notes: string;
  assignee: string;
  reviewer: string;
  qualityFlags: string[];
  createdAt: string;
  updatedAt: string;
}

function readReviews(root: string): { episodes: Record<string, EpisodeReview> } {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, ".lerobot-web", "reviews.json"), "utf-8"));
    return value && typeof value.episodes === "object" ? value : { episodes: {} };
  } catch {
    return { episodes: {} };
  }
}

function writeReviews(root: string, reviews: { episodes: Record<string, EpisodeReview> }): void {
  const directory = path.join(root, ".lerobot-web");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "reviews.json");
  const temporary = path.join(directory, `reviews.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(reviews, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function appendAudit(root: string, entry: Record<string, unknown>): void {
  const directory = path.join(root, ".lerobot-web");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

interface TrainingCollection {
  schemaVersion: 1;
  id: string;
  name: string;
  dataset: string;
  createdAt: string;
  sourceModifiedAt: string;
  episodes: Array<{ episode: number; tags: string[]; reviewUpdatedAt: string }>;
}

function collectionsDirectory(root: string): string {
  return path.join(root, ".lerobot-web", "collections");
}

function readCollections(root: string): TrainingCollection[] {
  const directory = collectionsDirectory(root);
  try {
    return fs.readdirSync(directory)
      .filter((file) => /^v\d{3}\.json$/.test(file))
      .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf-8")) as TrainingCollection)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function listDatasetFiles(root: string, directory = root): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".lerobot-web") return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listDatasetFiles(root, absolute) : entry.isFile() ? [path.relative(root, absolute)] : [];
  });
}

function readAudit(root: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(path.join(root, ".lerobot-web", "audit.jsonl"), "utf-8")
      .split("\n").filter(Boolean).slice(-200).reverse()
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

type TrainingState = "draft" | "running" | "stopping" | "completed" | "failed" | "cancelled";
interface TrainingMetric {
  step: number;
  samples: number | null;
  epochs: number | null;
  loss: number | null;
  gradNorm: number | null;
  learningRate: number | null;
  updateSeconds: number | null;
  dataSeconds: number | null;
}
interface TrainingJob {
  id: string;
  name: string;
  dataset: string;
  collection: string;
  episodes: number[];
  policy: string;
  device: "cuda" | "cpu";
  batchSize: number;
  steps: number;
  logFreq?: number;
  saveFreq?: number;
  numWorkers?: number;
  seed?: number;
  hostId?: string;
  attempts?: number;
  state: TrainingState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputDir: string;
  command: string[];
  exitCode: number | null;
  error: string | null;
  logs: string[];
  archivedAt?: string | null;
  bestAt?: string | null;
}

type ModelStage = "candidate" | "production" | "archived";
interface RegisteredModel {
  id: string;
  name: string;
  version: number;
  jobId: string;
  checkpoint: string;
  step: number;
  policy: string;
  dataset: string;
  collection: string;
  modelPath: string;
  sizeBytes: number;
  sha256: string;
  stage: ModelStage;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface DeploymentRevision {
  id: string;
  targetId: string;
  modelId: string;
  modelName: string;
  modelVersion: number;
  artifactPath: string;
  sha256: string;
  action: "deploy" | "rollback";
  rollbackOf: string | null;
  status: "active" | "superseded";
  deployedAt: string;
  deployedBy: string;
  notes: string;
  releaseGate: ReleaseGateResult | null;
  overrideReason: string;
}
interface DeploymentTarget {
  id: string;
  name: string;
  currentRevisionId: string | null;
  updatedAt: string | null;
  revisions: DeploymentRevision[];
  runtime: DeploymentRuntime;
}
interface InferenceIncident {
  id: string;
  targetId: string;
  revisionId: string | null;
  modelId: string | null;
  severity: "warning" | "error" | "critical";
  category: string;
  description: string;
  status: "open" | "resolved";
  reportedAt: string;
  reportedBy: string;
  resolvedAt: string | null;
  resolution: string;
}
interface DeploymentRuntime {
  status: "offline" | "healthy" | "degraded";
  lastHeartbeat: string | null;
  startedAt: string | null;
  inferenceCount: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  recentLatencies: number[];
  lastError: string;
  processId: string;
  updatedAt: string | null;
}
interface ReleaseGateConfig {
  minEvaluatedEpisodes: number;
  minSuccessRate: number;
  minConfidenceLow: number;
  blockOpenSeverity: "none" | "critical" | "error";
  updatedAt: string | null;
  updatedBy: string;
}
interface ReleaseGateCheck {
  id: "evaluatedEpisodes" | "successRate" | "confidenceLow" | "openIncidents";
  label: string;
  passed: boolean;
  actual: number;
  threshold: number | null;
}
interface ReleaseGateResult {
  ready: boolean;
  checkedAt: string;
  checks: ReleaseGateCheck[];
  config: ReleaseGateConfig;
}
interface DeploymentStore {
  schemaVersion: 2;
  targets: DeploymentTarget[];
  incidents: InferenceIncident[];
  releaseGate: ReleaseGateConfig;
}

type EvaluationState = "draft" | "running" | "stopping" | "completed" | "failed" | "cancelled";
interface EvaluationJob {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelVersion: number;
  evalDataset: string;
  task: string;
  followerPort: string;
  followerId: string;
  leaderPort: string;
  leaderId: string;
  cameraIndices: [number, number];
  device: "cuda" | "cpu";
  numEpisodes: number;
  episodeTime: number;
  resetTime: number;
  state: EvaluationState;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputDatasetPath: string;
  command: string[];
  exitCode: number | null;
  error: string | null;
  logs: string[];
}

type EvaluationOutcomeStatus = "unreviewed" | "success" | "failure" | "invalid";
interface EvaluationOutcome {
  status: EvaluationOutcomeStatus;
  failureReason: string;
  notes: string;
  reviewer: string;
  createdAt: string;
  updatedAt: string;
}
interface EvaluationResults {
  schemaVersion: 1;
  jobId: string;
  modelId: string;
  episodes: Record<string, EvaluationOutcome>;
}

interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

const trainingProcesses = new Map<string, ChildProcess>();
const evaluationProcesses = new Map<string, ChildProcess>();
const deploymentRuntimeQueues = new Map<string, Promise<void>>();

function enqueueDeploymentRuntime<T>(targetId: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = deploymentRuntimeQueues.get(targetId) || Promise.resolve();
  const result = previous.then(operation, operation);
  deploymentRuntimeQueues.set(targetId, result.then(() => undefined, () => undefined));
  return result;
}

function trainingJobsFile(): string {
  return path.join(TRAINING_ROOT, "jobs.json");
}

function modelRegistryFile(): string {
  return path.join(TRAINING_ROOT, "models.json");
}

function evaluationJobsFile(): string {
  return path.join(TRAINING_ROOT, "evaluations.json");
}

function deploymentsFile(): string {
  return path.join(TRAINING_ROOT, "deployments.json");
}

function defaultReleaseGate(): ReleaseGateConfig {
  return { minEvaluatedEpisodes: 10, minSuccessRate: 0.8, minConfidenceLow: 0.5, blockOpenSeverity: "error", updatedAt: null, updatedBy: "系统默认" };
}

function defaultDeploymentRuntime(): DeploymentRuntime {
  return { status: "offline", lastHeartbeat: null, startedAt: null, inferenceCount: 0, successCount: 0, errorCount: 0, avgLatencyMs: null, p95LatencyMs: null, recentLatencies: [], lastError: "", processId: "", updatedAt: null };
}

function readDeploymentStore(): DeploymentStore {
  try {
    const value = JSON.parse(fs.readFileSync(deploymentsFile(), "utf-8"));
    if (Array.isArray(value.targets) && Array.isArray(value.incidents)) {
      return { schemaVersion: 2, targets: value.targets.map((target: DeploymentTarget) => ({ ...target, runtime: { ...defaultDeploymentRuntime(), ...(target.runtime || {}) } })), incidents: value.incidents, releaseGate: { ...defaultReleaseGate(), ...(value.releaseGate || {}) } };
    }
  } catch { /* initialize below */ }
  return { schemaVersion: 2, targets: [{ id: "local-robot", name: "本机机器人", currentRevisionId: null, updatedAt: null, revisions: [], runtime: defaultDeploymentRuntime() }], incidents: [], releaseGate: defaultReleaseGate() };
}

function writeDeploymentStore(store: DeploymentStore): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = deploymentsFile(); const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", "utf-8"); fs.renameSync(temporary, target);
}

function deploymentDirectory(targetId: string): string {
  return path.join(TRAINING_ROOT, "deployments", targetId);
}

function readEvaluationJobs(): EvaluationJob[] {
  try {
    const value = JSON.parse(fs.readFileSync(evaluationJobsFile(), "utf-8"));
    return Array.isArray(value.jobs) ? value.jobs : [];
  } catch {
    return [];
  }
}

function writeEvaluationJobs(jobs: EvaluationJob[]): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = evaluationJobsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ jobs }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function updateEvaluationJob(id: string, update: (job: EvaluationJob) => void): EvaluationJob | null {
  const jobs = readEvaluationJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;
  update(job); writeEvaluationJobs(jobs); return job;
}

function evaluationResultsFile(job: EvaluationJob): string {
  return path.join(job.outputDatasetPath, ".lerobot-web", "evaluation.json");
}

function readEvaluationResults(job: EvaluationJob): EvaluationResults {
  try {
    const value = JSON.parse(fs.readFileSync(evaluationResultsFile(job), "utf-8"));
    return value && value.jobId === job.id && typeof value.episodes === "object"
      ? value as EvaluationResults
      : { schemaVersion: 1, jobId: job.id, modelId: job.modelId, episodes: {} };
  } catch {
    return { schemaVersion: 1, jobId: job.id, modelId: job.modelId, episodes: {} };
  }
}

function writeEvaluationResults(job: EvaluationJob, results: EvaluationResults): void {
  const directory = path.dirname(evaluationResultsFile(job));
  fs.mkdirSync(directory, { recursive: true });
  const target = evaluationResultsFile(job); const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(results, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function evaluationEpisodeCount(job: EvaluationJob): number {
  try { return Number(JSON.parse(fs.readFileSync(path.join(job.outputDatasetPath, "meta", "info.json"), "utf-8")).total_episodes || 0); }
  catch { return 0; }
}

function wilsonInterval(success: number, failure: number): { confidenceLow: number | null; confidenceHigh: number | null } {
  const evaluated = success + failure;
  if (!evaluated) return { confidenceLow: null, confidenceHigh: null };
  const rate = success / evaluated; const z = 1.96; const denominator = 1 + z * z / evaluated;
  const center = (rate + z * z / (2 * evaluated)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / evaluated + z * z / (4 * evaluated * evaluated)) / denominator;
  return { confidenceLow: Math.max(0, center - margin), confidenceHigh: Math.min(1, center + margin) };
}

function summarizeEvaluation(job: EvaluationJob): Record<string, number | null> {
  const total = evaluationEpisodeCount(job); const results = readEvaluationResults(job);
  let success = 0; let failure = 0; let invalid = 0;
  for (let episode = 0; episode < total; episode += 1) {
    const status = results.episodes[String(episode)]?.status || "unreviewed";
    if (status === "success") success += 1; else if (status === "failure") failure += 1; else if (status === "invalid") invalid += 1;
  }
  const evaluated = success + failure; const successRate = evaluated ? success / evaluated : null;
  const { confidenceLow, confidenceHigh } = wilsonInterval(success, failure);
  return { total, reviewed: success + failure + invalid, success, failure, invalid, pending: total - success - failure - invalid, evaluated, successRate, confidenceLow, confidenceHigh };
}

function aggregateModelEvaluation(modelId: string): { jobs: number; episodes: number; success: number; failure: number; successRate: number | null; confidenceLow: number | null; confidenceHigh: number | null } {
  const summaries = readEvaluationJobs().filter((job) => job.modelId === modelId).map(summarizeEvaluation).filter((summary) => Number(summary.total || 0) > 0);
  const success = summaries.reduce((sum, item) => sum + Number(item.success || 0), 0);
  const failure = summaries.reduce((sum, item) => sum + Number(item.failure || 0), 0);
  const evaluated = success + failure;
  return {
    jobs: summaries.length,
    episodes: summaries.reduce((sum, item) => sum + Number(item.total || 0), 0),
    success,
    failure,
    successRate: evaluated ? success / evaluated : null,
    ...wilsonInterval(success, failure),
  };
}

function evaluateReleaseGate(modelId: string, store: DeploymentStore): ReleaseGateResult {
  const evaluation = aggregateModelEvaluation(modelId); const evaluated = evaluation.success + evaluation.failure; const config = store.releaseGate;
  const severities = config.blockOpenSeverity === "none" ? [] : config.blockOpenSeverity === "critical" ? ["critical"] : ["error", "critical"];
  const openIncidents = store.incidents.filter((incident) => incident.modelId === modelId && incident.status === "open" && severities.includes(incident.severity)).length;
  const checks: ReleaseGateCheck[] = [
    { id: "evaluatedEpisodes", label: "有效评估 Episodes", passed: evaluated >= config.minEvaluatedEpisodes, actual: evaluated, threshold: config.minEvaluatedEpisodes },
    { id: "successRate", label: "评估成功率", passed: evaluation.successRate !== null && evaluation.successRate >= config.minSuccessRate, actual: evaluation.successRate ?? 0, threshold: config.minSuccessRate },
    { id: "confidenceLow", label: "95% 置信区间下界", passed: evaluation.confidenceLow !== null && evaluation.confidenceLow >= config.minConfidenceLow, actual: evaluation.confidenceLow ?? 0, threshold: config.minConfidenceLow },
    { id: "openIncidents", label: "未关闭阻断异常", passed: openIncidents === 0, actual: openIncidents, threshold: 0 },
  ];
  return { ready: checks.every((check) => check.passed), checkedAt: new Date().toISOString(), checks, config: { ...config } };
}

function readRegisteredModels(): RegisteredModel[] {
  try {
    const value = JSON.parse(fs.readFileSync(modelRegistryFile(), "utf-8"));
    return Array.isArray(value.models) ? value.models : [];
  } catch {
    return [];
  }
}

function writeRegisteredModels(models: RegisteredModel[]): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = modelRegistryFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ models }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function readTrainingJobs(): TrainingJob[] {
  try {
    const value = JSON.parse(fs.readFileSync(trainingJobsFile(), "utf-8"));
    return Array.isArray(value.jobs) ? value.jobs : [];
  } catch {
    return [];
  }
}

function writeTrainingJobs(jobs: TrainingJob[]): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = trainingJobsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ jobs }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function updateTrainingJob(id: string, update: (job: TrainingJob) => void): TrainingJob | null {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;
  update(job);
  writeTrainingJobs(jobs);
  return job;
}

function parseCompactNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)([KMB])?$/i);
  if (!match) return null;
  const scale = ({ K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[(match[2] || "").toUpperCase()] || 1;
  const parsed = Number(match[1]) * scale;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMetricValue(line: string, key: string): number | null {
  const match = line.match(new RegExp(`${key}:([+-]?[\\d.]+(?:e[+-]?\\d+)?)`, "i"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function trainingMetrics(job: TrainingJob): TrainingMetric[] {
  const metrics: TrainingMetric[] = [];
  for (const line of job.logs) {
    const stepMatch = line.match(/step:([\d.]+[KMB]?)/i);
    if (!stepMatch) continue;
    const step = parseCompactNumber(stepMatch[1]);
    if (step === null) continue;
    const samplesMatch = line.match(/smpl:([\d.]+[KMB]?)/i);
    metrics.push({
      step,
      samples: parseCompactNumber(samplesMatch?.[1]),
      epochs: parseMetricValue(line, "epch"),
      loss: parseMetricValue(line, "loss"),
      gradNorm: parseMetricValue(line, "grdn"),
      learningRate: parseMetricValue(line, "lr"),
      updateSeconds: parseMetricValue(line, "updt_s"),
      dataSeconds: parseMetricValue(line, "data_s"),
    });
  }
  return metrics;
}

function jobOutputPath(job: TrainingJob): string | null {
  const outputs = path.resolve(TRAINING_ROOT, "outputs");
  const output = path.resolve(job.outputDir);
  return output.startsWith(outputs + path.sep) ? output : null;
}

function directorySize(directory: string): number {
  let size = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) size += directorySize(target);
    else if (entry.isFile()) size += fs.statSync(target).size;
  }
  return size;
}

function trainingCheckpoints(job: TrainingJob): Array<{ step: number; name: string; path: string; configPath: string; modelPath: string | null; sizeBytes: number; modifiedAt: string }> {
  const output = jobOutputPath(job);
  if (!output) return [];
  const directory = path.join(output, "checkpoints");
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => {
        const checkpointPath = path.join(directory, entry.name);
        const configPath = path.join(checkpointPath, "pretrained_model", "train_config.json");
        const modelPath = path.join(checkpointPath, "pretrained_model", "model.safetensors");
        if (!fs.existsSync(configPath)) return null;
        return { step: Number(entry.name), name: entry.name, path: checkpointPath, configPath, modelPath: fs.existsSync(modelPath) ? modelPath : null, sizeBytes: directorySize(checkpointPath), modifiedAt: fs.statSync(checkpointPath).mtime.toISOString() };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.step - a.step);
  } catch {
    return [];
  }
}

function runPythonCheck(script: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => execFile(PYTHON_PATH, ["-c", script], { timeout: 15000 }, (error, stdout, stderr) => {
    resolve({ ok: !error, output: (stdout || stderr || error?.message || "").trim() });
  }));
}

function analyzeJpegFrame(frame: Buffer): Promise<{ mean: number; blackRatio: number } | null> {
  const script = "import sys,json,cv2,numpy as np; a=np.frombuffer(sys.stdin.buffer.read(),np.uint8); im=cv2.imdecode(a,cv2.IMREAD_GRAYSCALE); print(json.dumps({'mean':round(float(im.mean()),1),'blackRatio':round(float((im<8).mean()),3)})) if im is not None else sys.exit(2)";
  return new Promise((resolve) => {
    const child = spawn(PYTHON_PATH, ["-c", script], { stdio: ["pipe", "pipe", "ignore"] });
    let output = ""; let settled = false;
    const finish = (value: { mean: number; blackRatio: number } | null) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 5000); timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
    child.on("exit", (code) => { clearTimeout(timer); if (code !== 0) { finish(null); return; } try { finish(JSON.parse(output)); } catch { finish(null); } });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.stdin?.end(frame);
  });
}

function estimateTrainingResources(job: TrainingJob): { gpuMemoryGb: number; systemMemoryGb: number; basis: string } {
  const baseGpu: Record<string, number> = { act: 1.8, diffusion: 3.2, tdmpc: 2.4, vqbet: 3, smolvla: 4.5, pi0: 8, "pi0-fast": 6.5, sac: 1.8, reward_classifier: 1.8 };
  const perBatch: Record<string, number> = { act: .12, diffusion: .16, tdmpc: .14, vqbet: .16, smolvla: .2, pi0: .3, "pi0-fast": .25, sac: .1, reward_classifier: .1 };
  const gpuMemoryGb = job.device === "cuda" ? +(baseGpu[job.policy] + perBatch[job.policy] * job.batchSize).toFixed(1) : 0;
  const systemMemoryGb = +(2 + job.batchSize * .06 + (job.numWorkers || 0) * .2).toFixed(1);
  return { gpuMemoryGb, systemMemoryGb, basis: "保守估算：策略基础占用 + batch/workers 增量，实际以启动后监控为准" };
}

async function trainingPreflight(job: TrainingJob): Promise<{ ready: boolean; checks: PreflightCheck[]; checkedAt: string }> {
  const checks: PreflightCheck[] = [];
  const datasetRoot = datasetPath(job.dataset);
  const collectionPath = path.join(collectionsDirectory(datasetRoot), `${job.collection}.json`);
  const datasetReady = fs.existsSync(datasetRoot) && fs.existsSync(collectionPath);
  checks.push({ id: "dataset", label: "训练数据", status: datasetReady ? "pass" : "fail", detail: datasetReady ? `${job.episodes.length} 个已发布 Episode 可用` : "数据集或训练选集已不存在" });
  if (datasetReady) {
    try {
      const quality = await runDatasetCatalog("quality", job.dataset) as { episodes?: Array<{ episode: number; flags?: Array<{ level: string }> }> };
      const selected = (quality.episodes || []).filter((episode) => job.episodes.includes(episode.episode));
      const errors = selected.reduce((sum, episode) => sum + (episode.flags || []).filter((flag) => flag.level === "error").length, 0);
      const warnings = selected.reduce((sum, episode) => sum + (episode.flags || []).filter((flag) => flag.level === "warning").length, 0);
      checks.push({ id: "dataset_quality", label: "数据质量扫描", status: errors ? "fail" : warnings ? "warning" : "pass", detail: errors ? `${errors} 个错误风险，已阻止训练` : warnings ? `${warnings} 个警告风险，请确认后继续` : "黑屏、冻结、轨迹突变和重复风险均未发现" });
    } catch (error) {
      checks.push({ id: "dataset_quality", label: "数据质量扫描", status: "fail", detail: error instanceof Error ? error.message : "质量扫描失败" });
    }
  }

  const python = await runPythonCheck("import lerobot,torch; print(torch.__version__)");
  checks.push({ id: "runtime", label: "LeRobot 运行环境", status: python.ok ? "pass" : "fail", detail: python.ok ? `PyTorch ${python.output}` : python.output || "无法导入 lerobot/torch" });

  const cuda = await runPythonCheck("import torch; print(torch.cuda.is_available())");
  const cudaAvailable = cuda.ok && cuda.output.split(/\s+/).pop() === "True";
  checks.push({ id: "device", label: "计算设备", status: job.device === "cpu" || cudaAvailable ? "pass" : "fail", detail: job.device === "cpu" ? "使用 CPU（适合流程验证）" : cudaAvailable ? "CUDA 可用" : "任务要求 CUDA，但当前 PyTorch 无 CUDA" });

  if (["pi0", "pi0-fast"].includes(job.policy)) {
    const dependency = await runPythonCheck("import transformers,peft; print('lerobot[pi] ready')");
    checks.push({ id: "policy_dependency", label: "Pi0 依赖", status: dependency.ok ? "pass" : "fail", detail: dependency.ok ? dependency.output : "缺少 Pi0 依赖，请安装 lerobot[pi]" });
  } else if (job.policy === "smolvla") {
    const dependency = await runPythonCheck("import transformers; print('SmolVLA ready')");
    checks.push({ id: "policy_dependency", label: "SmolVLA 依赖", status: dependency.ok ? "pass" : "fail", detail: dependency.ok ? dependency.output : "缺少 SmolVLA 依赖，请安装 lerobot[smolvla]" });
  }

  const resources = resourceSample() as { diskFreeGb: number };
  const memoryFreeGb = os.freemem() / 1024 ** 3;
  const estimate = estimateTrainingResources(job);
  checks.push({ id: "disk", label: "磁盘空间", status: resources.diskFreeGb >= 5 ? "pass" : resources.diskFreeGb >= 2 ? "warning" : "fail", detail: `可用 ${resources.diskFreeGb} GB，建议至少保留 5 GB` });
  checks.push({ id: "memory", label: "可用内存", status: memoryFreeGb >= estimate.systemMemoryGb ? "pass" : memoryFreeGb >= estimate.systemMemoryGb * .75 ? "warning" : "fail", detail: `可用 ${memoryFreeGb.toFixed(1)} GB · 预计需要 ${estimate.systemMemoryGb} GB` });
  const profile = await hostProfile(); const gpu = profile.gpu as { available?: boolean; memoryGb?: number | null };
  const gpuCapacity = Number(gpu.memoryGb || 0);
  const gpuStatus = job.device === "cpu" ? "pass" : !gpu.available ? "fail" : estimate.gpuMemoryGb > gpuCapacity ? "fail" : estimate.gpuMemoryGb > gpuCapacity * .85 ? "warning" : "pass";
  checks.push({ id: "resource_estimate", label: "训练资源估算", status: gpuStatus, detail: job.device === "cpu" ? `${estimate.systemMemoryGb} GB 系统内存需求 · ${estimate.basis}` : `预计显存 ${estimate.gpuMemoryGb} GB / 实机 ${gpuCapacity || "未检测到"} GB · ${estimate.basis}` });
  checks.push({ id: "exclusive", label: "设备占用", status: evaluationProcesses.size === 0 ? "pass" : "fail", detail: evaluationProcesses.size === 0 ? "没有评估任务占用设备" : "评估任务正在运行" });
  return { ready: !checks.some((check) => check.status === "fail"), checks, checkedAt: new Date().toISOString() };
}

function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyDeploymentArtifact(model: RegisteredModel): Promise<{ modelFile: string; artifactPath: string }> {
  const outputsRoot = path.resolve(TRAINING_ROOT, "outputs");
  const modelFile = fs.realpathSync(model.modelPath);
  if (!modelFile.startsWith(outputsRoot + path.sep) || path.basename(modelFile) !== "model.safetensors") throw new Error("模型产物不在受管理的训练输出目录中");
  const artifactPath = path.dirname(modelFile);
  if (!fs.existsSync(path.join(artifactPath, "config.json"))) throw new Error("模型目录缺少 config.json");
  const hash = await fileSha256(modelFile);
  if (hash !== model.sha256) throw new Error("模型 SHA-256 与登记记录不一致，已阻止部署");
  return { modelFile, artifactPath };
}

function switchDeploymentLink(targetId: string, artifactPath: string): string {
  const directory = deploymentDirectory(targetId); fs.mkdirSync(directory, { recursive: true });
  const current = path.join(directory, "current"); const temporary = path.join(directory, `.current.${process.pid}.${Date.now()}`);
  fs.symlinkSync(artifactPath, temporary, "dir");
  try { fs.renameSync(temporary, current); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } throw error; }
  return current;
}

async function activateDeployment(targetId: string, model: RegisteredModel, input: { actor: string; notes: string; action: "deploy" | "rollback"; rollbackOf?: string | null; releaseGate?: ReleaseGateResult | null; overrideReason?: string }): Promise<DeploymentRevision> {
  if (targetId !== "local-robot") throw new Error("未知部署目标");
  const { artifactPath } = await verifyDeploymentArtifact(model);
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === targetId);
  if (!target) throw new Error("找不到部署目标");
  const now = new Date().toISOString();
  for (const revision of target.revisions) if (revision.status === "active") revision.status = "superseded";
  const revision: DeploymentRevision = {
    id: `deploy-${Date.now().toString(36)}`, targetId, modelId: model.id, modelName: model.name, modelVersion: model.version,
    artifactPath, sha256: model.sha256, action: input.action, rollbackOf: input.rollbackOf || null, status: "active",
    deployedAt: now, deployedBy: input.actor || "本地用户", notes: input.notes,
    releaseGate: input.releaseGate || null, overrideReason: input.overrideReason || "",
  };
  switchDeploymentLink(targetId, artifactPath);
  target.revisions.unshift(revision); target.currentRevisionId = revision.id; target.updatedAt = now; writeDeploymentStore(store);

  const models = readRegisteredModels();
  for (const item of models) if (item.name === model.name && item.stage === "production") { item.stage = "candidate"; item.updatedAt = now; }
  const deployed = models.find((item) => item.id === model.id); if (deployed) { deployed.stage = "production"; deployed.updatedAt = now; }
  writeRegisteredModels(models);
  return revision;
}

function deploymentRuntimeView(runtime: DeploymentRuntime): DeploymentRuntime {
  const stale = !runtime.lastHeartbeat || Date.now() - Date.parse(runtime.lastHeartbeat) > 30_000;
  return { ...runtime, status: stale ? "offline" : runtime.status, recentLatencies: runtime.recentLatencies.slice(-100) };
}

function enrichDeploymentTarget(target: DeploymentTarget, incidents: InferenceIncident[]): DeploymentTarget & { current: DeploymentRevision | null; linkPath: string; healthy: boolean; openIncidents: number } {
  const current = target.revisions.find((item) => item.id === target.currentRevisionId) || null; const linkPath = path.join(deploymentDirectory(target.id), "current");
  let healthy = false;
  if (current) { try { healthy = fs.realpathSync(linkPath) === fs.realpathSync(current.artifactPath); } catch { healthy = false; } }
  return { ...target, runtime: deploymentRuntimeView(target.runtime), current, linkPath, healthy, openIncidents: incidents.filter((item) => item.targetId === target.id && item.status === "open").length };
}

function enrichTrainingJob(job: TrainingJob): TrainingJob & { metrics: TrainingMetric[]; progress: number; checkpoints: ReturnType<typeof trainingCheckpoints> } {
  const metrics = trainingMetrics(job);
  const checkpoints = trainingCheckpoints(job);
  const latestStep = metrics[metrics.length - 1]?.step || checkpoints[0]?.step || 0;
  return { ...job, metrics, progress: Math.min(100, Math.round(latestStep / Math.max(1, job.steps) * 1000) / 10), checkpoints };
}

function readNumberFile(file: string): number | null {
  try { const value = Number(fs.readFileSync(file, "utf-8").trim()); return Number.isFinite(value) ? value : null; }
  catch { return null; }
}

function resourceSample(): Record<string, unknown> {
  const disk = fs.statfsSync(DATASET_ROOT);
  const gpuLoadRaw = readNumberFile("/sys/devices/platform/bus@0/17000000.gpu/load") ?? readNumberFile("/sys/devices/gpu.0/load");
  const thermalRoot = "/sys/class/thermal";
  let temperatureC: number | null = null;
  try {
    for (const entry of fs.readdirSync(thermalRoot).filter((name) => name.startsWith("thermal_zone"))) {
      const type = fs.readFileSync(path.join(thermalRoot, entry, "type"), "utf-8").trim().toLowerCase();
      if (type.includes("gpu") || type.includes("cpu")) {
        const raw = readNumberFile(path.join(thermalRoot, entry, "temp"));
        if (raw !== null) temperatureC = Math.max(temperatureC || 0, raw > 1000 ? raw / 1000 : raw);
      }
    }
  } catch { /* thermal data unavailable */ }
  return {
    sampledAt: new Date().toISOString(),
    cpuLoadPercent: Math.min(100, Math.round(os.loadavg()[0] / Math.max(1, os.cpus().length) * 1000) / 10),
    memoryUsedGb: +((os.totalmem() - os.freemem()) / 1024 ** 3).toFixed(1),
    memoryPercent: Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 1000) / 10,
    diskFreeGb: +(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1),
    gpuLoadPercent: gpuLoadRaw === null ? null : Math.round((gpuLoadRaw > 100 ? gpuLoadRaw / 10 : gpuLoadRaw) * 10) / 10,
    temperatureC,
  };
}

function startTrainingJob(job: TrainingJob): void {
  if (trainingProcesses.size > 0 || evaluationProcesses.size > 0) throw new Error("已有训练或评估任务正在运行");
  fs.mkdirSync(path.dirname(job.outputDir), { recursive: true });
  job.state = "running";
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.error = null;
  job.attempts = (job.attempts || 0) + 1;
  writeTrainingJobs(readTrainingJobs().map((item) => item.id === job.id ? job : item));
  const child = spawn(PYTHON_PATH, job.command, { cwd: path.join(__dirname, "../.."), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  trainingProcesses.set(job.id, child);
  let logBuffer = "";
  const consume = (chunk: Buffer) => {
    logBuffer += chunk.toString("utf-8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
    const lines = logBuffer.split(/\r?\n/);
    logBuffer = lines.pop() || "";
    if (!lines.length) return;
    updateTrainingJob(job.id, (current) => { current.logs.push(...lines.map((line) => line.trimEnd()).filter((line) => line && !line.includes("%|") && !line.includes("it/s]"))); current.logs = current.logs.slice(-500); });
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  child.on("error", (error) => {
    trainingProcesses.delete(job.id);
    updateTrainingJob(job.id, (current) => { current.state = "failed"; current.error = error.message; current.finishedAt = new Date().toISOString(); });
  });
  child.on("exit", (code, signal) => {
    trainingProcesses.delete(job.id);
    updateTrainingJob(job.id, (current) => {
      if (logBuffer.trim()) current.logs.push(logBuffer.trim());
      current.exitCode = code;
      current.finishedAt = new Date().toISOString();
      const wasStopping = current.state === "stopping";
      current.state = code === 0 ? "completed" : wasStopping ? "cancelled" : "failed";
      if (code !== 0 && !wasStopping && !current.error) current.error = signal ? `训练进程被 ${signal} 终止` : `训练进程退出码 ${code}`;
    });
  });
}

function buildEvaluationCommand(job: EvaluationJob, model: RegisteredModel): string[] {
  const cameras = {
    wrist: { type: "opencv", index_or_path: job.cameraIndices[0], width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS },
    front: { type: "opencv", index_or_path: job.cameraIndices[1], width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS },
  };
  const command = [
    "-m", "lerobot.scripts.lerobot_record",
    "--robot.type=so101_follower", `--robot.port=${job.followerPort}`, `--robot.id=${job.followerId}`,
    "--robot.disable_torque_on_disconnect=true", `--robot.cameras=${JSON.stringify(cameras)}`,
    "--teleop.type=so101_leader", `--teleop.port=${job.leaderPort}`, `--teleop.id=${job.leaderId}`,
    "--display_data=false", `--dataset.single_task=${job.task}`,
    `--policy.path=${path.dirname(model.modelPath)}`, `--policy.device=${job.device}`,
    `--dataset.repo_id=local/${job.evalDataset}`, `--dataset.root=${job.outputDatasetPath}`,
    "--dataset.push_to_hub=false", `--dataset.num_episodes=${job.numEpisodes}`,
    `--dataset.episode_time_s=${job.episodeTime}`, `--dataset.reset_time_s=${job.resetTime}`,
  ];
  if (job.attempts > 0) command.push("--resume=true");
  return command;
}

async function evaluationPreflight(job: EvaluationJob): Promise<{ ready: boolean; checks: PreflightCheck[]; checkedAt: string }> {
  const checks: PreflightCheck[] = [];
  const model = readRegisteredModels().find((item) => item.id === job.modelId);
  const modelReady = Boolean(model && fs.existsSync(model.modelPath) && fs.existsSync(path.join(path.dirname(model.modelPath), "config.json")));
  checks.push({ id: "model", label: "模型产物", status: modelReady ? "pass" : "fail", detail: modelReady ? `${model!.name} v${model!.version} · ${model!.stage}` : "模型文件或 config.json 不存在" });

  const trainingDatasetConflict = model?.dataset === job.evalDataset;
  const datasetExists = fs.existsSync(path.join(job.outputDatasetPath, "meta", "info.json"));
  const datasetAllowed = !trainingDatasetConflict && (!datasetExists || job.attempts > 0);
  checks.push({ id: "dataset", label: "评估数据集", status: datasetAllowed ? "pass" : "fail", detail: trainingDatasetConflict ? "评估 Dataset 不能与训练 Dataset 同名" : datasetExists && job.attempts === 0 ? "Dataset 已存在，请使用新名称" : `${job.evalDataset} 与训练数据隔离` });

  const portsReady = job.followerPort !== job.leaderPort && fs.existsSync(job.followerPort) && fs.existsSync(job.leaderPort);
  checks.push({ id: "serial", label: "机械臂串口", status: portsReady ? "pass" : "fail", detail: portsReady ? `${job.followerPort} / ${job.leaderPort}` : "Follower、Leader 串口必须存在且不能相同" });

  const now = Date.now();
  const cameraStreamsReady = job.cameraIndices[0] !== job.cameraIndices[1]
    && job.cameraIndices[0] === activeCameraIndex && job.cameraIndices[1] === activeCameraIndex2
    && now - cameraLastFrameAt < 2000 && now - camera2LastFrameAt < 2000;
  let cameraDetail = "两路摄像头必须映射正确并持续产生实时帧";
  let camerasReady = cameraStreamsReady;
  if (cameraStreamsReady && latestCameraFrame && latestCamera2Frame) {
    const [first, second] = await Promise.all([analyzeJpegFrame(latestCameraFrame), analyzeJpegFrame(latestCamera2Frame)]);
    camerasReady = Boolean(first && second && first.mean >= 5 && second.mean >= 5 && first.blackRatio < .98 && second.blackRatio < .98);
    cameraDetail = first && second
      ? `/dev/video${job.cameraIndices[0]} 亮度 ${first.mean} / /dev/video${job.cameraIndices[1]} 亮度 ${second.mean}${camerasReady ? ` · MJPG ${CAMERA_WIDTH}x${CAMERA_HEIGHT}@${CAMERA_FPS}` : " · 检测到黑屏"}`
      : "无法解析摄像头画面";
  }
  checks.push({ id: "cameras", label: "双摄像头画面", status: camerasReady ? "pass" : "fail", detail: cameraDetail });

  const runtime = await runPythonCheck("import lerobot,torch; print(torch.__version__)");
  checks.push({ id: "runtime", label: "推理环境", status: runtime.ok ? "pass" : "fail", detail: runtime.ok ? `PyTorch ${runtime.output}` : runtime.output || "无法导入 lerobot/torch" });
  if (job.device === "cuda") {
    const cuda = await runPythonCheck("import torch; print(torch.cuda.is_available())");
    const available = cuda.ok && cuda.output.split(/\s+/).pop() === "True";
    checks.push({ id: "device", label: "推理设备", status: available ? "pass" : "fail", detail: available ? "CUDA 可用" : "任务要求 CUDA，但当前 PyTorch 无 CUDA" });
  } else {
    checks.push({ id: "device", label: "推理设备", status: "warning", detail: "使用 CPU 推理，动作频率可能不足" });
  }

  const idle = evaluationProcesses.size === 0 && trainingProcesses.size === 0 && !bridge?.isRunning() && !recordingIsActive();
  checks.push({ id: "exclusive", label: "设备独占", status: idle ? "pass" : "fail", detail: idle ? "遥操作、录制和训练均已停止" : "请先停止遥操作、录制、训练或其他评估任务" });
  const resources = resourceSample() as { diskFreeGb: number };
  checks.push({ id: "disk", label: "磁盘空间", status: resources.diskFreeGb >= 2 ? "pass" : "fail", detail: `可用 ${resources.diskFreeGb} GB` });
  return { ready: !checks.some((check) => check.status === "fail"), checks, checkedAt: new Date().toISOString() };
}

function restoreCameraStreams(indices: [number, number]): void {
  setTimeout(() => {
    if (evaluationProcesses.size > 0 || !ENABLE_CAMERA) return;
    startCamera(indices[0]); startCamera2(indices[1]);
  }, 1000).unref();
}

async function startEvaluationJob(job: EvaluationJob): Promise<void> {
  if (evaluationProcesses.size > 0 || trainingProcesses.size > 0) throw new Error("已有训练或评估任务正在运行");
  const model = readRegisteredModels().find((item) => item.id === job.modelId);
  if (!model) throw new Error("已登记模型不存在");
  job.command = buildEvaluationCommand(job, model);
  job.state = "running"; job.startedAt = new Date().toISOString(); job.finishedAt = null; job.error = null; job.attempts += 1;
  writeEvaluationJobs(readEvaluationJobs().map((item) => item.id === job.id ? job : item));

  cameraBridge?.stop(); cameraBridge2?.stop();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const child = spawn(PYTHON_PATH, job.command, { cwd: path.join(__dirname, "../.."), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  evaluationProcesses.set(job.id, child);
  let logBuffer = "";
  const consume = (chunk: Buffer) => {
    logBuffer += chunk.toString("utf-8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
    const lines = logBuffer.split(/\r?\n/); logBuffer = lines.pop() || "";
    if (lines.length) updateEvaluationJob(job.id, (current) => { current.logs.push(...lines.map((line) => line.trimEnd()).filter(Boolean)); current.logs = current.logs.slice(-500); });
  };
  child.stdout?.on("data", consume); child.stderr?.on("data", consume);
  child.on("error", (error) => {
    evaluationProcesses.delete(job.id); restoreCameraStreams(job.cameraIndices);
    updateEvaluationJob(job.id, (current) => { current.state = "failed"; current.error = error.message; current.finishedAt = new Date().toISOString(); });
  });
  child.on("exit", (code, signal) => {
    evaluationProcesses.delete(job.id); restoreCameraStreams(job.cameraIndices);
    updateEvaluationJob(job.id, (current) => {
      if (logBuffer.trim()) current.logs.push(logBuffer.trim());
      current.exitCode = code; current.finishedAt = new Date().toISOString();
      const wasStopping = current.state === "stopping";
      current.state = code === 0 ? "completed" : wasStopping ? "cancelled" : "failed";
      if (code !== 0 && !wasStopping && !current.error) current.error = signal ? `评估进程被 ${signal} 终止` : `评估进程退出码 ${code}`;
    });
  });
}

function hostProfile(): Promise<Record<string, unknown>> {
  const disk = fs.statfsSync(DATASET_ROOT);
  const base = {
    cpu: { model: os.cpus()[0]?.model || "Unknown", cores: os.cpus().length, load: os.loadavg()[0] },
    memory: { totalGb: +(os.totalmem() / 1024 ** 3).toFixed(1), freeGb: +(os.freemem() / 1024 ** 3).toFixed(1) },
    disk: { totalGb: +(disk.blocks * disk.bsize / 1024 ** 3).toFixed(1), freeGb: +(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1) },
    platform: `${os.platform()} ${os.arch()}`,
  };
  const script = "import json,torch; c=torch.cuda.is_available(); p=torch.cuda.get_device_properties(0) if c else None; print(json.dumps({'available':c,'name':torch.cuda.get_device_name(0) if c else None,'memoryGb':round(p.total_memory/1024**3,1) if p else None,'torch':torch.__version__}))";
  return new Promise((resolve) => execFile(PYTHON_PATH, ["-c", script], { timeout: 15000 }, (error, stdout) => {
    let gpu: Record<string, unknown> = { available: false, name: null, memoryGb: null };
    if (!error) { try { gpu = JSON.parse(stdout); } catch { /* keep fallback */ } }
    if (!gpu.name) {
      try {
        const name = execSync("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null", { encoding: "utf-8" }).trim().split("\n")[0];
        if (name) gpu = { ...gpu, name, hardwareDetected: true, unifiedMemory: name.toLowerCase().includes("nvgpu") };
      } catch { /* no NVIDIA hardware */ }
    } else {
      gpu.hardwareDetected = true;
    }
    const gpuMemory = Number(gpu.memoryGb || 0);
    const recommendation = gpu.available
      ? { device: "cuda", cameraResolution: gpuMemory >= 12 ? "1280x720" : "640x360", actBatchSize: gpuMemory >= 12 ? 64 : gpuMemory >= 8 ? 28 : 8 }
      : { device: "cpu", cameraResolution: "640x360", actBatchSize: 4 };
    resolve({ ...base, gpu, recommendation, checkedAt: new Date().toISOString() });
  }));
}

function cleanShortText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  const result: string[] = [];
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (cleaned && cleaned.length <= maxLength && !result.includes(cleaned)) result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function datasetEpisodeNumbers(root: string): number[] {
  const infoPath = path.join(root, "meta", "info.json");
  if (fs.existsSync(infoPath)) {
    const info = JSON.parse(fs.readFileSync(infoPath, "utf-8")) as { total_episodes?: number };
    const total = Math.max(0, Number(info.total_episodes || 0));
    return Array.from({ length: total }, (_, episode) => episode);
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^episode_\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice("episode_".length)))
    .filter((episode) => Number.isInteger(episode) && episode >= 0)
    .sort((a, b) => a - b);
}

function datasetSourceModifiedAt(root: string): string {
  const infoPath = path.join(root, "meta", "info.json");
  return fs.statSync(fs.existsSync(infoPath) ? infoPath : root).mtime.toISOString();
}

function ensureEpisodeExists(root: string, episode: number): void {
  if (!datasetEpisodeNumbers(root).includes(episode)) throw new Error(`找不到 Episode ${episode}`);
}

function buildReview(body: Record<string, unknown>, previous?: EpisodeReview): EpisodeReview {
  const status = body.status;
  if (!["unreviewed", "approved", "rejected"].includes(String(status))) throw new Error("审核状态无效");
  const now = new Date().toISOString();
  return {
    status: status as EpisodeReview["status"],
    notes: cleanShortText(body.notes, 2000),
    tags: cleanStringList(body.tags, 20, 40),
    assignee: cleanShortText(body.assignee, 80),
    reviewer: cleanShortText(body.reviewer, 80),
    qualityFlags: cleanStringList(body.qualityFlags, 20, 60),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

function isCompleteJointPayload(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== RECORDER_JOINT_NAMES.length) return false;
  return RECORDER_JOINT_NAMES.every(
    (name) => typeof payload[name] === "number" && Number.isFinite(payload[name]),
  );
}

function hasCompleteCaptureJoints(message: BridgeMessage): boolean {
  return isCompleteJointPayload(message.leader) && isCompleteJointPayload(message.follower);
}

app.get("/api/recording/status", (req, res) => {
  res.json({ ok: true, ...recordingStatus, root: DATASET_ROOT });
});

app.get("/api/playback/status", (_req, res) => res.json({ ok: true, ...playbackStatus }));

app.post("/api/playback/start", async (req, res) => {
  if (!bridge?.isRunning() || activeControlSource !== "web" || stopping) return res.status(409).json({ ok: false, error: "当前不是网页控制模式" });
  if (recordingIsActive() || playbackIsActive() || evaluationProcesses.size > 0) return res.status(409).json({ ok: false, error: "当前机械臂正被其他任务占用" });
  const dataset = cleanDatasetName(req.body?.dataset);
  const episode = Number(req.body?.episode);
  const speed = Number(req.body?.speed ?? 1);
  if (!dataset || !Number.isInteger(episode) || episode < 0 || !Number.isFinite(speed) || speed < 0.25 || speed > 2) return res.status(400).json({ ok: false, error: "数据集、片段或播放速度无效" });
  const root = datasetPath(dataset);
  const episodeDir = path.join(root, `episode_${String(episode).padStart(4, "0")}`);
  const rosbag = fs.existsSync(episodeDir) && fs.readdirSync(episodeDir).some((name) => name.endsWith(".mcap"));
  if (!rosbag && !fs.existsSync(path.join(root, "meta", "info.json"))) return res.status(404).json({ ok: false, error: "找不到数据集" });
  let fps = 0;
  if (!rosbag) { try { fps = Number(JSON.parse(fs.readFileSync(path.join(root, "meta", "info.json"), "utf8")).fps); } catch { /* child reports the detailed error */ } if (!Number.isFinite(fps) || fps <= 0) return res.status(400).json({ ok: false, error: "数据集 FPS 无效" }); }
  const started = rosbag
    ? new RobotBridge(ROSBAG_PLAYBACK_SCRIPT, ["--bag-dir", episodeDir, "--speed", String(speed)], ROS_PYTHON_PATH)
    : new RobotBridge(PLAYBACK_SCRIPT, ["--dataset-root", root, "--episode", String(episode), "--fps", String(fps), "--speed", String(speed)], PYTHON_PATH);
  playback = started;
  playbackStatus = { state: "preparing", dataset, episode, frame: 0, frames: 0, fps, speed, error: null };
  started.on("message", (msg) => {
    if (playback !== started) return;
    if (msg.type === "playback_ready") playbackStatus = { ...playbackStatus, state: "playing", frames: Number(msg.frames) || 0 };
    if (msg.type === "playback_action" && msg.joints && isCompleteJointPayload(msg.joints)) {
      bridge?.send({ type: "action", joints: msg.joints, seq: Date.now() });
      playbackStatus = { ...playbackStatus, frame: Number(msg.frame) || 0, frames: Number(msg.frames) || playbackStatus.frames };
    }
    if (msg.type === "playback_done") { playbackStatus = { ...playbackStatus, state: "idle", frame: playbackStatus.frames }; publishPlaybackStatus(); }
    if (msg.type === "playback_error") { playbackStatus = { ...playbackStatus, state: "error", error: String(msg.error || "回放失败") }; publishPlaybackStatus(); }
    if (msg.type !== "playback_action") publishPlaybackStatus();
  });
  started.on("exit", (code, errorLine) => {
    if (playback !== started) return;
    playback = null;
    if (playbackStatus.state === "stopping") playbackStatus = { ...playbackStatus, state: "idle", error: null };
    else if (playbackStatus.state === "preparing" || playbackStatus.state === "playing") playbackStatus = { ...playbackStatus, state: code === 0 ? "idle" : "error", error: code === 0 ? null : errorLine || "回放进程异常退出" };
    publishPlaybackStatus();
  });
  started.on("error", (error) => { playbackStatus = { ...playbackStatus, state: "error", error: error.message }; publishPlaybackStatus(); });
  started.start();
  publishPlaybackStatus();
  res.json({ ok: true, ...playbackStatus });
});

app.post("/api/playback/stop", (_req, res) => {
  if (!stopPlayback()) return res.json({ ok: true, ...playbackStatus });
  res.json({ ok: true, ...playbackStatus });
});

app.post("/api/logs/latency", (req, res) => {
  const fields = ["controlLatencyMs", "cameraLatencyMs", "camera2LatencyMs", "controlFps", "cameraFps", "camera2Fps"] as const;
  const metrics: Record<string, number | null> = {};
  for (const field of fields) {
    const value = req.body?.[field];
    if (value === null || value === undefined) {
      metrics[field] = null;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 600000) {
      metrics[field] = Math.round(value * 10) / 10;
    } else {
      res.status(400).json({ ok: false, error: `${field} 必须是有效的非负数或 null` });
      return;
    }
  }
  persistControlLatency(metrics);
  res.status(202).json({ ok: true });
});

app.get("/api/logs", (_req, res) => {
  try {
    fs.mkdirSync(RUNTIME_LOG_ROOT, { recursive: true });
    const files = fs.readdirSync(RUNTIME_LOG_ROOT)
      .filter((name) => /^\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2}_\d+)?\.jsonl$/.test(name))
      .map((name) => {
        const file = path.join(RUNTIME_LOG_ROOT, name);
        const content = fs.readFileSync(file, "utf-8");
        const id = name.slice(0, -".jsonl".length);
        const firstEntry = content.split("\n").find(Boolean);
        let startedAt = fs.statSync(file).birthtime.toISOString();
        try {
          const parsed = firstEntry ? JSON.parse(firstEntry) : null;
          if (typeof parsed?.timestamp === "string") startedAt = parsed.timestamp;
        } catch { /* retain filesystem timestamp for legacy files */ }
        return {
          id,
          date: name.slice(0, 10),
          startedAt,
          current: id === RUNTIME_LOG_SESSION_ID,
          legacy: /^\d{4}-\d{2}-\d{2}$/.test(id),
          lines: content.split("\n").filter(Boolean).length,
          bytes: fs.statSync(file).size,
        };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    res.json({ ok: true, root: RUNTIME_LOG_ROOT, currentSession: RUNTIME_LOG_SESSION_ID, files });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/logs/:session", (req, res) => {
  const session = String(req.params.session || "");
  if (!/^\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2}_\d+)?$/.test(session)) {
    res.status(400).json({ ok: false, error: "日志会话无效" });
    return;
  }
  const file = path.join(RUNTIME_LOG_ROOT, `${session}.jsonl`);
  if (!fs.existsSync(file)) {
    res.status(404).json({ ok: false, error: "该日期没有日志" });
    return;
  }
  try {
    const entries = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).reverse();
    res.json({ ok: true, session, entries });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets", async (req, res) => {
  try {
    res.json({ ok: true, ...await runDatasetCatalog("list", undefined, req.query.refresh === "1") });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/datasets/:dataset", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const confirmation = cleanShortText(req.body?.confirmation, 120);
  if (!dataset || confirmation !== dataset) {
    res.status(400).json({ ok: false, error: "请输入完整数据集名称确认删除" });
    return;
  }
  if (recordingStatus.dataset === dataset && recordingStatus.state !== "idle" && recordingStatus.state !== "error") {
    res.status(409).json({ ok: false, error: "该数据集正在录制，请先停止录制" });
    return;
  }
  try {
    const source = fs.realpathSync(datasetPath(dataset));
    if (path.dirname(source) !== fs.realpathSync(DATASET_ROOT)) throw new Error("数据集路径无效");
    fs.mkdirSync(DATASET_TRASH_ROOT, { recursive: true });
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(DATASET_TRASH_ROOT, `${dataset}-${suffix}`);
    fs.renameSync(source, destination);
    clearDatasetCatalogCache(dataset);
    persistRuntimeLog("system", "warn", `数据集 ${dataset} 已移入回收目录: ${destination}`);
    res.json({ ok: true, dataset, recoverable: true, trashPath: destination });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes("ENOENT") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.delete("/api/datasets/:dataset/episodes/:episode", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episode = Number(req.params.episode);
  if (!dataset || !Number.isInteger(episode) || episode < 0) { res.status(400).json({ ok: false, error: "数据集或片段无效" }); return; }
  if (recordingIsActive() || playbackIsActive()) return res.status(409).json({ ok: false, error: "录制或回放正在运行，请先停止" });
  const root = datasetPath(dataset);
  const episodeName = `episode_${String(episode).padStart(4, "0")}`;
  try {
    const source = fs.realpathSync(path.join(root, episodeName));
    if (path.dirname(source) !== fs.realpathSync(root)) throw new Error("片段路径无效");
    fs.mkdirSync(DATASET_TRASH_ROOT, { recursive: true });
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(DATASET_TRASH_ROOT, `${dataset}-${episodeName}-${suffix}`);
    fs.renameSync(source, destination);
    const sidecar = path.join(root, `${episodeName}.json`);
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${destination}.json`);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "episode.delete", actor: cleanShortText(req.body?.actor, 80) || "本地用户", dataset, episodes: [episode] });
    res.json({ ok: true, dataset, episode, recoverable: true, trashPath: destination });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes("ENOENT") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.get("/api/datasets/:dataset", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) {
    res.status(400).json({ ok: false, error: "无效的数据集名称" });
    return;
  }
  try {
    let detail = await runDatasetCatalog("detail", dataset, req.query.refresh === "1");
    if (await ensureRosbagVideos(dataset, detail)) {
      clearDatasetCatalogCache(dataset);
      detail = await runDatasetCatalog("detail", dataset, true);
    }
    const episodes = Array.isArray(detail.episodes) ? detail.episodes.map((episode) => {
      const item = episode as Record<string, unknown>;
      const ranges = item.videoRanges && typeof item.videoRanges === "object" ? item.videoRanges as Record<string, { start?: number; end?: number }> : {};
      const videos = item.videos && typeof item.videos === "object" ? Object.fromEntries(
        Object.entries(item.videos as Record<string, string>).map(([key, relative]) => [
          key,
          `/api/datasets/${encodeURIComponent(dataset)}/video?file=${Buffer.from(relative).toString("base64url")}${Number.isFinite(ranges[key]?.start) && Number.isFinite(ranges[key]?.end) ? `#t=${Number(ranges[key].start)},${Number(ranges[key].end)}` : ""}`,
        ]),
      ) : {};
      return { ...item, videos };
    }) : [];
    res.json({ ok: true, ...detail, episodes });
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets/:dataset/quality", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  try { res.json({ ok: true, ...(await runDatasetCatalog("quality", dataset)) }); }
  catch (error) { res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/datasets/:dataset/video", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const token = typeof req.query.file === "string" ? req.query.file : "";
  if (!dataset || !token) {
    res.status(400).json({ ok: false, error: "视频参数无效" });
    return;
  }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const relative = Buffer.from(token, "base64url").toString("utf-8");
    const requested = fs.realpathSync(path.resolve(root, relative));
    if (!requested.startsWith(root + path.sep) || path.extname(requested).toLowerCase() !== ".mp4") {
      throw new Error("视频路径无效");
    }
    // Explicitly preserve browser video seeking semantics. This is important
    // for local review: browsers issue byte-range requests before rendering
    // the first frame and may request the same range repeatedly while scrubbing.
    sendVideoFile(requested, req, res);
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : "找不到视频" });
  }
});

function sendVideoFile(file: string, req: express.Request, res: express.Response): void {
  const stat = fs.statSync(file);
  const size = stat.size;
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.type("video/mp4");
  if (!range) {
    res.setHeader("Content-Length", size);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.status(416).setHeader("Content-Range", `bytes */${size}`).end(); return; }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
    return;
  }
  const boundedEnd = Math.min(end, size - 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${boundedEnd}/${size}`);
  res.setHeader("Content-Length", boundedEnd - start + 1);
  fs.createReadStream(file, { start, end: boundedEnd }).pipe(res);
}

app.post("/api/datasets/:dataset/episodes/:episode/clip", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episode = Number(req.params.episode);
  const start = Number(req.body?.start);
  const end = Number(req.body?.end);
  if (!dataset || !Number.isInteger(episode) || episode < 0 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    res.status(400).json({ ok: false, error: "数据集、片段或裁剪区间无效" });
    return;
  }
  const source = path.join(datasetPath(dataset), `episode_${String(episode).padStart(4, "0")}`);
  if (!fs.existsSync(source)) { res.status(404).json({ ok: false, error: "找不到录制片段" }); return; }
  const clipId = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clipRoot = path.join(datasetPath(dataset), ".clips", clipId);
  const bagRoot = path.join(clipRoot, "bag");
  const videoRoot = path.join(clipRoot, "videos");
  try {
    await new Promise<void>((resolve, reject) => execFile(ROS_PYTHON_PATH, [ROSBAG_CLIP_SCRIPT, source, bagRoot, "--start", String(start), "--end", String(end)], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve()));
    const bagFile = fs.readdirSync(bagRoot).find((name) => name.endsWith(".mcap"));
    if (!bagFile) throw new Error("裁剪后没有生成 MCAP 文件");
    await new Promise<void>((resolve, reject) => execFile(ROS_PYTHON_PATH, [ROSBAG_VIDEO_CONVERTER_SCRIPT, bagRoot, "--output", videoRoot], { timeout: 600_000, maxBuffer: 2 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve()));
    const videos = fs.existsSync(videoRoot) ? fs.readdirSync(videoRoot).filter((name) => name.endsWith(".mp4")).map((name) => ({ name, url: `/api/datasets/${encodeURIComponent(dataset)}/clips/${encodeURIComponent(clipId)}/video/${encodeURIComponent(name)}` })) : [];
    res.json({ ok: true, clipId, bagUrl: `/api/datasets/${encodeURIComponent(dataset)}/clips/${encodeURIComponent(clipId)}/bag`, videos });
  } catch (error) {
    try { fs.rmSync(clipRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets/:dataset/episodes/:episode/joints", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episode = Number(req.params.episode);
  if (!dataset || !Number.isInteger(episode) || episode < 0) { res.status(400).json({ ok: false, error: "数据集或 episode 无效" }); return; }
  const source = path.join(datasetPath(dataset), `episode_${String(episode).padStart(4, "0")}`);
  if (!fs.existsSync(source)) { res.status(404).json({ ok: false, error: "找不到录制片段" }); return; }
  execFile(ROS_PYTHON_PATH, [ROSBAG_JOINT_STATE_SCRIPT, source], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { res.status(500).json({ ok: false, error: stderr.trim() || error.message }); return; }
    try { res.json({ ok: true, samples: JSON.parse(stdout) }); }
    catch { res.status(500).json({ ok: false, error: "关节状态数据格式无效" }); }
  });
});

app.get("/api/datasets/:dataset/clips/:clip/bag", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const clip = /^[A-Za-z0-9_-]+$/.test(req.params.clip) ? req.params.clip : "";
  if (!dataset || !clip) { res.status(400).json({ ok: false, error: "裁剪参数无效" }); return; }
  try {
    const root = fs.realpathSync(path.join(datasetPath(dataset), ".clips", clip, "bag"));
    const file = fs.readdirSync(root).find((name) => name.endsWith(".mcap"));
    if (!file) throw new Error("找不到裁剪后的 bag");
    const target = path.join(root, file);
    const stat = fs.statSync(target);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
    fs.createReadStream(target).pipe(res);
  } catch (error) { res.status(404).json({ ok: false, error: error instanceof Error ? error.message : "找不到裁剪后的 bag" }); }
});

app.get("/api/datasets/:dataset/clips/:clip/video/:file", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const clip = /^[A-Za-z0-9_-]+$/.test(req.params.clip) ? req.params.clip : "";
  const file = /^camera[12]\.mp4$/.test(req.params.file) ? req.params.file : "";
  if (!dataset || !clip || !file) { res.status(400).json({ ok: false, error: "视频参数无效" }); return; }
  try { sendVideoFile(fs.realpathSync(path.join(datasetPath(dataset), ".clips", clip, "videos", file)), req, res); }
  catch (error) { res.status(404).json({ ok: false, error: error instanceof Error ? error.message : "找不到裁剪视频" }); }
});


app.patch("/api/datasets/:dataset/episodes/:episode/review", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episode = Number(req.params.episode);
  if (!dataset || !Number.isInteger(episode) || episode < 0) {
    res.status(400).json({ ok: false, error: "数据集或 episode 无效" });
    return;
  }
  const root = datasetPath(dataset);
  try {
    ensureEpisodeExists(root, episode);
    const reviews = readReviews(root);
    const review = buildReview(req.body, reviews.episodes[String(episode)]);
    reviews.episodes[String(episode)] = review;
    writeReviews(root, reviews);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "review.update", actor: review.reviewer || "本地用户", dataset, episodes: [episode], status: review.status, tags: review.tags });
    res.json({ ok: true, review });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("找不到") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.patch("/api/datasets/:dataset/reviews/batch", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episodeIds = Array.isArray(req.body.episodes)
    ? [...new Set((req.body.episodes as unknown[]).filter((value): value is number => Number.isInteger(value) && Number(value) >= 0).map(Number))]
    : [];
  if (!dataset || episodeIds.length === 0 || episodeIds.length > 500) {
    res.status(400).json({ ok: false, error: "请选择 1-500 个有效 Episode" });
    return;
  }
  const root = datasetPath(dataset);
  try {
    episodeIds.forEach((episode) => ensureEpisodeExists(root, episode));
    const reviews = readReviews(root);
    const saved: Record<string, EpisodeReview> = {};
    for (const episode of episodeIds) {
      const previous = reviews.episodes[String(episode)];
      const merged = {
        status: req.body.status,
        notes: req.body.keepExisting ? previous?.notes || "" : req.body.notes,
        tags: req.body.appendTags ? [...(previous?.tags || []), ...cleanStringList(req.body.tags, 20, 40)] : req.body.tags,
        assignee: req.body.assignee ?? previous?.assignee,
        reviewer: req.body.reviewer,
        qualityFlags: previous?.qualityFlags || [],
      };
      saved[String(episode)] = buildReview(merged, previous);
      reviews.episodes[String(episode)] = saved[String(episode)];
    }
    writeReviews(root, reviews);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "review.batch", actor: cleanShortText(req.body.reviewer, 80) || "本地用户", dataset, episodes: episodeIds, status: req.body.status, tags: cleanStringList(req.body.tags, 20, 40) });
    res.json({ ok: true, count: episodeIds.length, reviews: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("找不到") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.get("/api/datasets/:dataset/collections", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    let collections = readCollections(root);
    if (!collections.length) {
      const episodes = datasetEpisodeNumbers(root);
      if (episodes.length > 0) {
        const generated: TrainingCollection = { schemaVersion: 1, id: "v001", name: "全量数据（自动生成）", dataset, createdAt: new Date().toISOString(), sourceModifiedAt: datasetSourceModifiedAt(root), episodes: episodes.map((episode) => ({ episode, tags: [], reviewUpdatedAt: new Date().toISOString() })) };
        fs.mkdirSync(collectionsDirectory(root), { recursive: true });
        fs.writeFileSync(path.join(collectionsDirectory(root), "v001.json"), JSON.stringify(generated, null, 2) + "\n", "utf-8");
        collections = [generated];
      }
    }
    res.json({ ok: true, collections });
  } catch {
    res.status(404).json({ ok: false, error: `找不到数据集: ${dataset}` });
  }
});

app.delete("/api/datasets/:dataset/collections/:collection", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const collection = cleanShortText(req.params.collection, 80);
  if (!dataset || !/^[A-Za-z0-9_-]+$/.test(collection)) {
    res.status(400).json({ ok: false, error: "数据集或训练选集无效" });
    return;
  }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const directory = collectionsDirectory(root);
    const file = fs.realpathSync(path.join(directory, `${collection}.json`));
    if (path.dirname(file) !== fs.realpathSync(directory)) throw new Error("训练选集路径无效");
    fs.unlinkSync(file);
    appendAudit(root, { action: "collection.delete", actor: cleanShortText(req.body?.actor, 80) || "本地用户", dataset, collection });
    res.json({ ok: true, deleted: collection });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes("ENOENT") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.post("/api/datasets/:dataset/collections", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const name = cleanShortText(req.body.name, 80);
  const requested = Array.isArray(req.body.episodes)
    ? [...new Set((req.body.episodes as unknown[]).filter((value): value is number => Number.isInteger(value) && Number(value) >= 0).map(Number))]
    : [];
  if (!dataset || !name) { res.status(400).json({ ok: false, error: "数据集与训练选集名称不能为空" }); return; }
  const root = datasetPath(dataset);
  try {
    const reviews = readReviews(root);
    const approved = Object.entries(reviews.episodes)
      .filter(([, review]) => review.status === "approved")
      .map(([episode]) => Number(episode));
    const episodeIds = (requested.length ? requested : approved).sort((a, b) => a - b);
    if (!episodeIds.length) throw new Error("没有已通过审核的 Episode");
    const notApproved = episodeIds.filter((episode) => reviews.episodes[String(episode)]?.status !== "approved");
    if (notApproved.length) throw new Error(`包含未通过审核的 Episode: ${notApproved.join(", ")}`);
    episodeIds.forEach((episode) => ensureEpisodeExists(root, episode));
    const existing = readCollections(root);
    const id = `v${String(existing.length + 1).padStart(3, "0")}`;
    const collection: TrainingCollection = {
      schemaVersion: 1,
      id,
      name,
      dataset,
      createdAt: new Date().toISOString(),
      sourceModifiedAt: datasetSourceModifiedAt(root),
      episodes: episodeIds.map((episode) => {
        const review = reviews.episodes[String(episode)];
        return { episode, tags: review.tags || [], reviewUpdatedAt: review.updatedAt || "" };
      }),
    };
    const directory = collectionsDirectory(root);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(collection, null, 2) + "\n", "utf-8");
    fs.renameSync(temporary, target);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "collection.publish", actor: cleanShortText(req.body.actor, 80) || "本地用户", dataset, collection: id, episodes: episodeIds });
    res.status(201).json({ ok: true, collection, path: path.relative(root, target) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("没有") || message.startsWith("包含") ? 409 : 400).json({ ok: false, error: message });
  }
});

// 把指定 Episode（默认全部审核通过）导出为一个新的 LeRobot v3 数据集副本。
app.post("/api/datasets/:dataset/export-reviewed", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const target = cleanDatasetName(req.body?.target);
  const requested = Array.isArray(req.body?.episodes)
    ? [...new Set((req.body.episodes as unknown[]).filter((value): value is number => Number.isInteger(value) && Number(value) >= 0).map(Number))]
    : [];
  if (!dataset || !target) { res.status(400).json({ ok: false, error: "数据集名称无效（仅支持字母、数字、点、下划线和中划线）" }); return; }
  if (target === dataset) { res.status(400).json({ ok: false, error: "目标数据集不能与源数据集同名" }); return; }
  let sourceRoot: string;
  let existingTargetBackup: string | null = null;
  try {
    sourceRoot = fs.realpathSync(datasetPath(dataset));
    if (fs.existsSync(datasetPath(target))) {
      if (req.body?.refreshExisting !== true) throw new Error(`目标数据集已存在: ${target}`);
      existingTargetBackup = path.join(DATASET_ROOT, `.${target}.previous-${process.pid}-${Date.now()}`);
      fs.renameSync(datasetPath(target), existingTargetBackup);
    }
  } catch (error) {
    res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const restoreExistingTarget = () => {
    if (existingTargetBackup && !fs.existsSync(datasetPath(target)) && fs.existsSync(existingTargetBackup)) {
      fs.renameSync(existingTargetBackup, datasetPath(target));
    }
  };

  let episodes = requested;
  if (!episodes.length) {
    const reviews = readReviews(sourceRoot);
    episodes = Object.entries(reviews.episodes)
      .filter(([, review]) => review.status === "approved")
      .map(([episode]) => Number(episode))
      .filter((episode) => Number.isInteger(episode) && episode >= 0)
      .sort((a, b) => a - b);
  }
  if (!episodes.length) { restoreExistingTarget(); res.status(409).json({ ok: false, error: "没有可导出的 Episode（请先通过审核）" }); return; }

  const args = [DATASET_EXPORT_SCRIPT, "--root", DATASET_ROOT, "--source", dataset, "--target", target, "--episodes", ...episodes.map(String)];
  execFile(PYTHON_PATH, args, { timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      restoreExistingTarget();
      const detail = stderr.trim().split("\n").filter(Boolean).pop();
      let message = detail || error.message;
      try { message = (JSON.parse(detail || "{}") as { error?: string }).error || message; } catch { /* 非 JSON 错误输出 */ }
      res.status(message.startsWith("缺少") || message.startsWith("没有") ? 409 : 500).json({ ok: false, error: message });
      return;
    }
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(stdout) as Record<string, unknown>; }
    catch { restoreExistingTarget(); res.status(500).json({ ok: false, error: "导出脚本返回了无效结果" }); return; }
    clearDatasetCatalogCache();
    if (existingTargetBackup && fs.existsSync(existingTargetBackup)) fs.rmSync(existingTargetBackup, { recursive: true, force: true });
    appendAudit(sourceRoot, { action: "dataset.export", actor: cleanShortText(req.body?.actor, 80) || "本地用户", dataset, target, episodes });
    res.status(201).json({ ok: true, dataset: result });
  });
});

app.get("/api/datasets/:dataset/collections/:collection/manifest", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const collection = /^v\d{3}$/.test(req.params.collection) ? req.params.collection : null;
  if (!dataset || !collection) { res.status(400).json({ ok: false, error: "训练选集参数无效" }); return; }
  try {
    const file = fs.realpathSync(path.join(collectionsDirectory(fs.realpathSync(datasetPath(dataset))), `${collection}.json`));
    res.setHeader("Content-Disposition", `attachment; filename="${dataset}-${collection}.json"`);
    res.sendFile(file, { dotfiles: "allow" });
  } catch {
    res.status(404).json({ ok: false, error: "找不到训练选集" });
  }
});

app.get("/api/datasets/:dataset/collections/:collection/snapshot", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const collectionId = /^v\d{3}$/.test(req.params.collection) ? req.params.collection : null;
  if (!dataset || !collectionId) { res.status(400).json({ ok: false, error: "训练快照参数无效" }); return; }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const collection = readCollections(root).find((item) => item.id === collectionId);
    if (!collection) { res.status(404).json({ ok: false, error: "找不到训练选集" }); return; }
    const sourceFiles = await Promise.all(listDatasetFiles(root).sort().map(async (relativePath) => {
      const absolute = path.join(root, relativePath); const stat = fs.statSync(absolute);
      return { relativePath, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: await fileSha256(absolute) };
    }));
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ dataset, collection, sourceFiles })).digest("hex");
    const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), dataset, collection, sourceFiles, fingerprint };
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets/:dataset/audit", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    res.json({ ok: true, entries: readAudit(root) });
  } catch {
    res.status(404).json({ ok: false, error: `找不到数据集: ${dataset}` });
  }
});

// ---------------------------------------------------------------------------
// 数据交付：把本地数据集（rosbag 采集目录）用 rsync 推送到训练主机。
// rosbag → LeRobot 转换与训练都在独立的训练主机平台完成；这里只保证
// 数据集以 <remoteRoot>/<dataset>/ 布局完整落到远端，并做 dry-run 复核。
// ---------------------------------------------------------------------------

const SIDECAR_ROOT = path.join(DATASET_ROOT, ".lerobot-web");
const UPLOAD_SETTINGS_FILE = path.join(SIDECAR_ROOT, "upload-settings.json");
const UPLOAD_TASKS_FILE = path.join(SIDECAR_ROOT, "upload-tasks.json");

interface UploadSettings {
  enabled: boolean;
  /** ssh: rsync over SSH（密钥免密）；rsyncd: rsync 守护进程（局域网免认证）。 */
  method: "ssh" | "rsyncd";
  host: string;
  port: number;
  user: string;
  remoteRoot: string;
  /** rsyncd 模式的模块名，对应训练主机 /etc/rsyncd.conf 里的 [module]。 */
  module: string;
  retries: number;
  updatedAt: string | null;
}

type UploadTaskState = "queued" | "running" | "success" | "failed";

interface UploadTask {
  id: string;
  dataset: string;
  state: UploadTaskState;
  progress: number;
  transferredBytes: number;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  verifiedAt: string | null;
}

const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  enabled: false, method: "ssh", host: "", port: 22, user: "", remoteRoot: "/data/lerobot", module: "lerobot", retries: 3, updatedAt: null,
};

function readUploadSettings(): UploadSettings {
  try {
    const value = JSON.parse(fs.readFileSync(UPLOAD_SETTINGS_FILE, "utf-8")) as Partial<UploadSettings>;
    return {
      enabled: Boolean(value.enabled),
      method: value.method === "rsyncd" ? "rsyncd" : "ssh",
      host: typeof value.host === "string" ? value.host : "",
      port: Number.isInteger(value.port) ? Number(value.port) : DEFAULT_UPLOAD_SETTINGS.port,
      user: typeof value.user === "string" ? value.user : "",
      remoteRoot: typeof value.remoteRoot === "string" ? value.remoteRoot : DEFAULT_UPLOAD_SETTINGS.remoteRoot,
      module: typeof value.module === "string" && value.module ? value.module : DEFAULT_UPLOAD_SETTINGS.module,
      retries: Number.isInteger(value.retries) ? Number(value.retries) : 3,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_UPLOAD_SETTINGS };
  }
}

function writeUploadSettings(settings: UploadSettings): void {
  fs.mkdirSync(SIDECAR_ROOT, { recursive: true });
  const temporary = `${UPLOAD_SETTINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, UPLOAD_SETTINGS_FILE);
}

function readUploadTasks(): UploadTask[] {
  try {
    const value = JSON.parse(fs.readFileSync(UPLOAD_TASKS_FILE, "utf-8"));
    return Array.isArray(value.tasks) ? value.tasks : [];
  } catch {
    return [];
  }
}

function writeUploadTasks(tasks: UploadTask[]): void {
  fs.mkdirSync(SIDECAR_ROOT, { recursive: true });
  const temporary = `${UPLOAD_TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ tasks: tasks.slice(-100) }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, UPLOAD_TASKS_FILE);
}

function updateUploadTask(id: string, mutate: (task: UploadTask) => void): UploadTask | null {
  const tasks = readUploadTasks();
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  mutate(task);
  writeUploadTasks(tasks);
  return task;
}

function failUploadTask(id: string, message: string): void {
  updateUploadTask(id, (task) => {
    task.state = "failed";
    task.error = message.slice(0, 400);
    task.finishedAt = new Date().toISOString();
    task.logs = [...task.logs, `错误: ${message}`].slice(-300);
  });
}

function validateUploadSettings(body: Record<string, unknown>): { settings?: UploadSettings; error?: string } {
  const enabled = Boolean(body.enabled);
  const method = body.method === "rsyncd" ? "rsyncd" : "ssh";
  const host = String(body.host || "").trim();
  const port = body.port === undefined || body.port === null || body.port === ""
    ? (method === "rsyncd" ? 873 : 22) : Number(body.port);
  const user = String(body.user || "").trim();
  const remoteRoot = String(body.remoteRoot || "").trim();
  const module = String(body.module || "lerobot").trim();
  const retries = body.retries === undefined || body.retries === null || body.retries === "" ? 3 : Number(body.retries);
  if (host && !/^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|(?:\d{1,3}\.){3}\d{1,3})$/.test(host)) return { error: "训练主机地址无效" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "端口无效" };
  if (user && !/^[A-Za-z0-9._-]{1,64}$/.test(user)) return { error: "SSH 用户名无效" };
  if (method === "ssh" && (!/^\/[A-Za-z0-9._/-]{0,126}$/.test(remoteRoot) || remoteRoot.includes(".."))) {
    return { error: "远端根目录必须是无空格的绝对路径，例如 /data/lerobot" };
  }
  if (method === "rsyncd" && !/^[A-Za-z0-9._-]{1,64}$/.test(module)) return { error: "rsync 模块名无效" };
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) return { error: "重试次数需为 0-5" };
  if (enabled && !host) return { error: "启用自动上传前请填写训练主机地址" };
  if (enabled && method === "ssh" && !user) return { error: "SSH 方式启用自动上传前请填写用户名" };
  return { settings: { enabled, method, host, port, user, remoteRoot, module, retries, updatedAt: new Date().toISOString() } };
}

function uploadDestination(settings: UploadSettings, dataset: string): string {
  return settings.method === "rsyncd"
    ? `rsync://${settings.host}:${settings.port}/${settings.module}/${dataset}/`
    : `${settings.user}@${settings.host}:${settings.remoteRoot}/${dataset}/`;
}

function rsyncTransportArgs(settings: UploadSettings): string[] {
  if (settings.method === "rsyncd") return [];
  return ["-e", settings.port === 22 ? "ssh" : `ssh -p ${settings.port}`];
}

function describeSshFailure(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("permission denied") || lower.includes("publickey")) {
    return "SSH 公钥未授权：请把本机公钥加入训练主机的 ~/.ssh/authorized_keys 后重试";
  }
  if (lower.includes("timed out") || lower.includes("no route to host") || lower.includes("connection refused")) {
    return "无法连接训练主机：请检查 IP、端口和局域网连通性";
  }
  return message.split("\n").filter(Boolean).pop() || "连接训练主机失败";
}

// ---------------------------------------------------------------------------
// 上传/转换任务队列（顺序执行，一次一个，避免占满局域网带宽和磁盘 IO）
// ---------------------------------------------------------------------------

interface UploadRuntime {
  lines: string[];
  progress: number;
  transferredBytes: number;
  timer: NodeJS.Timeout | null;
}

const uploadRuntime = new Map<string, UploadRuntime>();
const uploadProcesses = new Map<string, ChildProcess>();

function getUploadRuntime(taskId: string): UploadRuntime {
  let runtime = uploadRuntime.get(taskId);
  if (!runtime) {
    runtime = { lines: [], progress: 0, transferredBytes: 0, timer: null };
    uploadRuntime.set(taskId, runtime);
  }
  return runtime;
}

function flushUploadRuntime(taskId: string): void {
  const runtime = uploadRuntime.get(taskId);
  if (!runtime) return;
  const lines = runtime.lines.splice(0, runtime.lines.length);
  if (!lines.length && runtime.progress === 0) return;
  updateUploadTask(taskId, (task) => {
    if (lines.length) task.logs = [...task.logs, ...lines].slice(-300);
    if (runtime.progress > task.progress) task.progress = runtime.progress;
    if (runtime.transferredBytes > task.transferredBytes) task.transferredBytes = runtime.transferredBytes;
  });
}

// onLine 返回 true 表示该行已被消费（如 rsync 进度行），不再写入任务日志。
function runLoggedProcess(processKey: string, taskId: string, command: string, args: string[], onLine?: (line: string) => boolean | void): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const runtime = getUploadRuntime(taskId);
    runtime.lines.push(`$ ${command} ${args.join(" ")}`.slice(0, 500));
    const child = spawn(command, args, { env: { ...process.env, PYTHONUNBUFFERED: "1", LC_ALL: "C" } });
    uploadProcesses.set(processKey, child);
    const timer = setInterval(() => flushUploadRuntime(taskId), 500);
    runtime.timer = timer;
    let buffer = "";
    const consume = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines.map((value) => value.trimEnd())) {
        if (!line || line.includes("%|") || line.includes("it/s]")) continue;
        if (onLine?.(line) !== true) runtime.lines.push(line);
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) => {
      uploadProcesses.delete(processKey);
      clearInterval(timer);
      flushUploadRuntime(taskId);
      uploadRuntime.delete(taskId);
      failUploadTask(taskId, `进程启动失败: ${error.message}`);
      resolve({ code: -1, signal: null });
    });
    child.on("exit", (code, signal) => {
      uploadProcesses.delete(processKey);
      clearInterval(timer);
      if (buffer.trim() && onLine?.(buffer.trim()) !== true) runtime.lines.push(buffer.trim());
      flushUploadRuntime(taskId);
      uploadRuntime.delete(taskId);
      resolve({ code, signal });
    });
  });
}

function parseRsyncBytes(value: string): number {
  const match = value.trim().match(/^([\d.,]+)\s*([KMGT])?i?B$/i);
  if (!match) return 0;
  const scale: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(Number(match[1].replace(/,/g, "")) * (scale[(match[2] || "").toUpperCase()] || 1));
}

function enqueueUploadTask(task: UploadTask): void {
  const tasks = readUploadTasks();
  tasks.push(task);
  writeUploadTasks(tasks);
  void pumpUploadQueue();
}

function newUploadTask(dataset: string): UploadTask {
  return {
    id: `upl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    dataset, state: "queued", progress: 0, transferredBytes: 0, attempts: 1,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    exitCode: null, error: null, logs: [], verifiedAt: null,
  };
}

let uploadQueueActive = false;

async function pumpUploadQueue(): Promise<void> {
  if (uploadQueueActive) return;
  uploadQueueActive = true;
  try {
    for (;;) {
      const next = readUploadTasks().find((task) => task.state === "queued");
      if (!next) break;
      await runUploadTask(next);
    }
  } finally {
    uploadQueueActive = false;
  }
}

async function runUploadTask(task: UploadTask): Promise<void> {
  updateUploadTask(task.id, (current) => {
    current.state = "running";
    current.startedAt = new Date().toISOString();
    current.error = null;
  });
  await runRsyncUploadTask(task.id);
  // 失败自动重试：直接重新入队，attempts 累计，由 pump 循环继续消化。
  const after = readUploadTasks().find((item) => item.id === task.id);
  const settings = readUploadSettings();
  if (after && after.state === "failed" && after.attempts <= settings.retries) {
    updateUploadTask(task.id, (current) => {
      current.state = "queued";
      current.attempts += 1;
      current.logs = [...current.logs, `准备第 ${current.attempts} 次尝试…`].slice(-300);
    });
  }
}

async function runRsyncUploadTask(id: string): Promise<void> {
  const task = readUploadTasks().find((item) => item.id === id);
  if (!task) return;
  const settings = readUploadSettings();
  if (!settings.host || (settings.method === "ssh" && !settings.user)) {
    failUploadTask(id, "尚未配置训练主机，请先在上传设置中填写");
    return;
  }
  let root: string;
  try {
    root = fs.realpathSync(datasetPath(task.dataset));
  } catch {
    failUploadTask(id, `找不到数据集 ${task.dataset}`);
    return;
  }
  const destination = uploadDestination(settings, task.dataset);
  const progressPattern = /(\d+(?:\.\d+)?)%\s+([\d.,]+\s*[KMGT]?i?B)/;
  const { code, signal } = await runLoggedProcess(id, id, "rsync", [
    "-a", "--partial", "--exclude", ".lerobot-web", ...rsyncTransportArgs(settings), "--info=progress2", `${root}/`, destination,
  ], (line) => {
    const runtime = getUploadRuntime(id);
    const match = line.match(progressPattern);
    if (!match) return false;
    runtime.progress = Math.max(runtime.progress, Math.min(99, Math.floor(Number(match[1]))));
    runtime.transferredBytes = Math.max(runtime.transferredBytes, parseRsyncBytes(match[2]));
    return true;
  });
  if (code !== 0) {
    updateUploadTask(id, (current) => { current.exitCode = code; });
    failUploadTask(id, signal ? `上传进程被 ${signal} 终止` : `rsync 退出码 ${code}`);
    return;
  }
  // 复核：dry-run 后增量必须为 0，才认为远端数据完整。
  let verifyResidual = -1;
  const verify = await runLoggedProcess(`${id}:verify`, id, "rsync", [
    "-a", "-n", "--stats", "--exclude", ".lerobot-web", ...rsyncTransportArgs(settings), `${root}/`, destination,
  ], (line) => {
    const match = line.match(/Number of files transferred:\s*(\d+)/i);
    if (match) verifyResidual = Number(match[1]);
  });
  if (verifyResidual > 0) {
    failUploadTask(id, `上传后复核发现 ${verifyResidual} 个文件仍不一致`);
    return;
  }
  if (verify.code !== 0) {
    failUploadTask(id, `上传完成但复核失败（rsync 退出码 ${verify.code}），请检查训练主机连接后重试`);
    return;
  }
  updateUploadTask(id, (current) => {
    current.state = "success";
    current.progress = 100;
    current.exitCode = 0;
    current.finishedAt = new Date().toISOString();
    current.verifiedAt = verifyResidual === 0 ? new Date().toISOString() : null;
    current.logs = [...current.logs, verifyResidual === 0
      ? `上传完成并通过复核 → ${destination}`
      : `上传完成（复核未能解析增量统计，请人工确认）→ ${destination}`].slice(-300);
  });
  persistRuntimeLog("system", "info", `数据集 ${task.dataset} 已上传到训练主机 ${destination}`);
}

function activeUploadTaskFor(dataset: string): UploadTask | undefined {
  return readUploadTasks().find((task) =>
    (task.state === "queued" || task.state === "running") && task.dataset === dataset);
}

function queueDatasetUpload(dataset: string, actor: string): UploadTask {
  const task = newUploadTask(dataset);
  enqueueUploadTask(task);
  const root = datasetPath(dataset);
  if (fs.existsSync(root)) appendAudit(root, { action: "dataset.upload.enqueue", actor, dataset });
  return task;
}

function publicUploadKey(): string | null {
  // 只有存在配对私钥时公钥才有意义，否则提示用户先生成密钥。
  for (const base of ["id_ed25519", "id_rsa"]) {
    try {
      if (!fs.existsSync(path.join(os.homedir(), ".ssh", base))) continue;
      return fs.readFileSync(path.join(os.homedir(), ".ssh", `${base}.pub`), "utf-8").trim();
    } catch { /* try next */ }
  }
  return null;
}

app.get("/api/upload/settings", (_req, res) => {
  res.json({
    ok: true,
    settings: readUploadSettings(),
    publicKey: publicUploadKey(),
    taskCount: readUploadTasks().length,
  });
});

app.put("/api/upload/settings", (req, res) => {
  const result = validateUploadSettings((req.body || {}) as Record<string, unknown>);
  if (result.error || !result.settings) {
    res.status(400).json({ ok: false, error: result.error || "上传设置无效" });
    return;
  }
  writeUploadSettings(result.settings);
  res.json({ ok: true, settings: result.settings });
});

app.post("/api/upload/check", (_req, res) => {
  const settings = readUploadSettings();
  if (settings.method === "rsyncd") {
    if (!settings.host) { res.status(400).json({ ok: false, error: "请先配置训练主机地址" }); return; }
    execFile("rsync", ["--list-only", "--timeout=8", `rsync://${settings.host}:${settings.port}/`], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        res.status(502).json({ ok: false, error: `无法连接 rsync 守护进程：${describeSshFailure(stderr || error.message)}` });
        return;
      }
      const modules = stdout.split(/\s+/).filter(Boolean);
      const found = modules.includes(settings.module);
      res.json({
        ok: found,
        error: found ? null : `守护进程已连通，但训练主机 rsyncd 配置里没有模块 ${settings.module}`,
        rsyncInstalled: true,
        writable: found,
        modules,
        detail: stdout.trim(),
      });
    });
    return;
  }
  if (!settings.host || !settings.user) {
    res.status(400).json({ ok: false, error: "请先配置训练主机地址和用户名" });
    return;
  }
  const remoteCommand = `command -v rsync >/dev/null || echo NO-RSYNC; mkdir -p ${settings.remoteRoot} && test -w ${settings.remoteRoot} && echo WRITABLE; df -Pm ${settings.remoteRoot} 2>/dev/null | tail -1`;
  execFile("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-p", String(settings.port), `${settings.user}@${settings.host}`, remoteCommand,
  ], { timeout: 20000 }, (error, stdout, stderr) => {
    if (error) {
      res.status(502).json({ ok: false, error: describeSshFailure(stderr || error.message) });
      return;
    }
    const output = stdout.trim();
    const freeMb = Number((output.match(/\s(\d+)\s+\d+%/) || [])[1] || 0);
    res.json({
      ok: !output.includes("NO-RSYNC") && output.includes("WRITABLE"),
      error: output.includes("NO-RSYNC") ? "训练主机缺少 rsync，请先安装" : output.includes("WRITABLE") ? null : "远端目录不可写",
      rsyncInstalled: !output.includes("NO-RSYNC"),
      writable: output.includes("WRITABLE"),
      freeDiskMb: freeMb || null,
      detail: output,
    });
  });
});

app.get("/api/upload/tasks", (_req, res) => {
  let changed = false;
  const tasks = readUploadTasks().map((task) => {
    if (task.state === "running" && !uploadProcesses.has(task.id) && !uploadRuntime.has(task.id)) {
      changed = true;
      return { ...task, state: "failed" as UploadTaskState, error: "服务重启导致任务中断", finishedAt: new Date().toISOString() };
    }
    return task;
  });
  if (changed) writeUploadTasks(tasks);
  res.json({ ok: true, tasks: tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post("/api/datasets/:dataset/upload", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  const settings = readUploadSettings();
  if (!settings.host || (settings.method === "ssh" && !settings.user)) {
    res.status(400).json({ ok: false, error: "尚未配置训练主机，请先在上传设置中填写并保存" });
    return;
  }
  const root = datasetPath(dataset);
  if (!fs.existsSync(root)) { res.status(404).json({ ok: false, error: `找不到数据集 ${dataset}` }); return; }
  if (recordingStatus.dataset === dataset && recordingStatus.state !== "idle" && recordingStatus.state !== "error") {
    res.status(409).json({ ok: false, error: "该数据集正在录制，请先停止录制再上传" });
    return;
  }
  if (activeUploadTaskFor(dataset)) {
    res.status(409).json({ ok: false, error: `${dataset} 已有排队或进行中的任务` });
    return;
  }
  const actor = cleanShortText((req as express.Request & { authUser?: AuthUser }).authUser?.name, 80) || "本地用户";
  const task = queueDatasetUpload(dataset, actor);
  res.status(202).json({ ok: true, task });
});

app.post("/api/upload/tasks/:id/retry", (req, res) => {
  const task = readUploadTasks().find((item) => item.id === req.params.id);
  if (!task) { res.status(404).json({ ok: false, error: "找不到任务" }); return; }
  if (task.state !== "failed") { res.status(409).json({ ok: false, error: "只有失败的任务可以重试" }); return; }
  updateUploadTask(task.id, (current) => {
    current.state = "queued";
    current.attempts += 1;
    current.error = null;
    current.logs = [...current.logs, "手动重试：重新入队"].slice(-300);
  });
  void pumpUploadQueue();
  res.status(202).json({ ok: true, task: readUploadTasks().find((item) => item.id === task.id) });
});

// 服务重启后继续消化队列里未完成的任务。
setTimeout(() => { void pumpUploadQueue(); }, 3000).unref();

// Training and model deployment were removed from this data-collection platform.
// Keep the legacy implementation below unreachable so old clients fail clearly
// instead of starting a training or evaluation process.
app.use("/api/training", (_req, res) => {
  res.status(404).json({ ok: false, error: "训练与模型评估功能已移除" });
});

app.get("/api/training/host", async (req, res) => {
  try { res.json({ ok: true, ...await hostProfile() }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/training/resources", (req, res) => {
  try { res.json({ ok: true, ...resourceSample() }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/resources/estimate", async (req, res) => {
  const policies = ["act", "diffusion", "tdmpc", "vqbet", "smolvla", "pi0", "pi0-fast", "sac", "reward_classifier"];
  const policy = typeof req.body?.policy === "string" && policies.includes(req.body.policy) ? req.body.policy : null;
  const device = req.body?.device === "cpu" ? "cpu" : req.body?.device === "cuda" ? "cuda" : null;
  const batchSize = Number(req.body?.batchSize); const numWorkers = Number(req.body?.numWorkers ?? 4);
  if (!policy || !device || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024 || !Number.isInteger(numWorkers) || numWorkers < 0 || numWorkers > 64) {
    res.status(400).json({ ok: false, error: "资源估算参数无效" }); return;
  }
  const job = { policy, device, batchSize, numWorkers } as TrainingJob;
  const estimate = estimateTrainingResources(job); const profile = await hostProfile(); const gpu = profile.gpu as { available?: boolean; memoryGb?: number | null }; const capacity = Number(gpu.memoryGb || 0);
  const ready = device === "cpu" ? Number(profile.memory && (profile.memory as Record<string, unknown>).freeGb || 0) >= estimate.systemMemoryGb * .75 : Boolean(gpu.available) && estimate.gpuMemoryGb <= capacity;
  res.json({ ok: true, ready, estimate, host: { gpuAvailable: Boolean(gpu.available), gpuMemoryGb: capacity || null, memoryFreeGb: (profile.memory as Record<string, unknown>).freeGb || null } });
});

app.get("/api/training/jobs", (req, res) => {
  const jobs = readTrainingJobs();
  let changed = false;
  for (const job of jobs) {
    if ((job.state === "running" || job.state === "stopping") && !trainingProcesses.has(job.id)) {
      job.state = "failed"; job.finishedAt = new Date().toISOString(); job.error = "服务重启，训练进程状态已丢失"; changed = true;
    }
  }
  if (changed) writeTrainingJobs(jobs);
  const includeArchived = req.query.archived === "true";
  res.json({ ok: true, jobs: jobs.filter((job) => includeArchived || !job.archivedAt).map(enrichTrainingJob) });
});

app.post("/api/training/hosts/check", async (req, res) => {
  const address = typeof req.body.address === "string" ? req.body.address.trim() : "";
  const port = Number(req.body.port);
  if (!/^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|(?:\d{1,3}\.){3}\d{1,3})$/.test(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
    res.status(400).json({ ok: false, error: "训练主机地址或端口无效" }); return;
  }
  try {
    const response = await fetch(`http://${address}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const health = await response.json() as Record<string, unknown>;
    if (!response.ok || health.ok !== true) throw new Error(`Agent 返回 HTTP ${response.status}`);
    res.json({ ok: true, health });
  } catch (cause) {
    res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "无法连接训练 Agent" });
  }
});
app.post("/api/training/hosts/resources", async (req, res) => {
  const address = typeof req.body.address === "string" ? req.body.address.trim() : "";
  const port = Number(req.body.port);
  if (!/^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|(?:\d{1,3}\.){3}\d{1,3})$/.test(address) || !Number.isInteger(port)) return res.status(400).json({ ok: false, error: "训练主机地址无效" });
  try { const response = await fetch(`http://${address}:${port}/resources`, { headers: process.env.TRAINING_AGENT_TOKEN ? { Authorization: `Bearer ${process.env.TRAINING_AGENT_TOKEN}` } : {}, signal: AbortSignal.timeout(4000) }); const data = await response.json() as { detail?: string }; if (!response.ok) throw new Error(data.detail || `Agent 返回 HTTP ${response.status}`); res.json({ ok: true, resources: data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "无法读取训练主机资源" }); }
});
async function agentRequest(address: string, port: number, endpoint: string, init: RequestInit = {}) {
  if (!/^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|(?:\d{1,3}\.){3}\d{1,3})$/.test(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("训练主机地址或端口无效");
  const headers = new Headers(init.headers);
  if (process.env.TRAINING_AGENT_TOKEN) headers.set("Authorization", `Bearer ${process.env.TRAINING_AGENT_TOKEN}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`http://${address}:${port}${endpoint}`, { ...init, headers, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error((data as { detail?: string; error?: string }).detail || (data as { error?: string }).error || `Agent 返回 HTTP ${response.status}`);
  return data;
}
app.post("/api/training/hosts/agent/jobs", async (req, res) => {
  const { address, port, job } = req.body || {};
  try { const data = await agentRequest(String(address || ""), Number(port), "/jobs", { method: "POST", body: JSON.stringify(job || {}) }); res.json({ ok: true, data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "Agent 任务提交失败" }); }
});
app.post("/api/training/hosts/agent/datasets/prepare", async (req, res) => {
  const { address, port, snapshot } = req.body || {};
  try { const data = await agentRequest(String(address || ""), Number(port), "/datasets/prepare", { method: "POST", body: JSON.stringify(snapshot || {}) }); res.json({ ok: true, data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "Agent 数据准备失败" }); }
});
app.get("/api/training/hosts/agent/jobs/:id", async (req, res) => {
  const { address, port } = req.query;
  try { const data = await agentRequest(String(address || ""), Number(port), `/jobs/${encodeURIComponent(req.params.id)}`); res.json({ ok: true, data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "Agent 任务查询失败" }); }
});
app.get("/api/training/hosts/agent/jobs/:id/logs", async (req, res) => {
  const { address, port, cursor = "0" } = req.query;
  try { const data = await agentRequest(String(address || ""), Number(port), `/jobs/${encodeURIComponent(req.params.id)}/logs?cursor=${encodeURIComponent(String(cursor))}`); res.json({ ok: true, data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "Agent 日志读取失败" }); }
});
app.post("/api/training/hosts/agent/jobs/:id/stop", async (req, res) => {
  const { address, port } = req.body || {};
  try { const data = await agentRequest(String(address || ""), Number(port), `/jobs/${encodeURIComponent(req.params.id)}/stop`, { method: "POST", body: "{}" }); res.json({ ok: true, data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "Agent 停止任务失败" }); }
});
app.get("/api/training/hosts/agent/jobs/:id/artifacts", async (req, res) => {
  const { address, port } = req.query;
  try { const data = await agentRequest(String(address || ""), Number(port), `/jobs/${encodeURIComponent(req.params.id)}/artifacts`); res.json({ ok: true, data }); } catch (cause) { res.status(502).json({ ok: false, error: cause instanceof Error ? cause.message : "Agent 产物读取失败" }); }
});

app.get("/api/training/models", (req, res) => {
  const store = readDeploymentStore();
  const models = readRegisteredModels().map((model) => ({ ...model, evaluation: aggregateModelEvaluation(model.id), deploymentGate: evaluateReleaseGate(model.id, store) }));
  res.json({ ok: true, models });
});

app.get("/api/training/deployments", (req, res) => {
  const store = readDeploymentStore();
  res.json({ ok: true, targets: store.targets.map((target) => enrichDeploymentTarget(target, store.incidents)), incidents: store.incidents, releaseGate: store.releaseGate });
});

app.post("/api/training/deployments/:target/heartbeat", async (req, res) => {
  const targetId = req.params.target;
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === targetId);
  const latencyMs = req.body?.latencyMs; const success = req.body?.success; const error = cleanShortText(req.body?.error, 500);
  if (!target || !target.currentRevisionId) { res.status(409).json({ ok: false, error: "部署目标当前没有活动修订" }); return; }
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 600000 || typeof success !== "boolean") {
    res.status(400).json({ ok: false, error: "心跳必须包含有效 latencyMs 和 success" }); return;
  }
  try {
    const runtime = await enqueueDeploymentRuntime(targetId, () => {
      const latestStore = readDeploymentStore(); const latestTarget = latestStore.targets.find((item) => item.id === targetId);
      if (!latestTarget || !latestTarget.currentRevisionId) throw new Error("部署目标当前没有活动修订");
      const next = { ...defaultDeploymentRuntime(), ...(latestTarget.runtime || {}) }; const now = new Date().toISOString();
      next.lastHeartbeat = now; next.updatedAt = now; next.startedAt = next.startedAt || now; next.processId = cleanShortText(req.body?.processId, 120) || next.processId;
      next.inferenceCount += 1; if (success) next.successCount += 1; else { next.errorCount += 1; if (error) next.lastError = error; }
      next.recentLatencies = [...next.recentLatencies, latencyMs].slice(-100);
      const sorted = [...next.recentLatencies].sort((a, b) => a - b); const p95Index = Math.max(0, Math.ceil(sorted.length * .95) - 1);
      next.avgLatencyMs = Math.round(next.recentLatencies.reduce((sum, value) => sum + value, 0) / next.recentLatencies.length * 10) / 10;
      next.p95LatencyMs = Math.round(sorted[p95Index] * 10) / 10;
      const errorRate = next.inferenceCount ? next.errorCount / next.inferenceCount : 0;
      next.status = !success || errorRate >= .1 || (next.p95LatencyMs || 0) > 1000 ? "degraded" : "healthy";
      latestTarget.runtime = next; writeDeploymentStore(latestStore); return deploymentRuntimeView(next);
    });
    res.status(200).json({ ok: true, runtime });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.patch("/api/training/deployment-gate", (req, res) => {
  const minEvaluatedEpisodes = req.body?.minEvaluatedEpisodes;
  const minSuccessRate = req.body?.minSuccessRate;
  const minConfidenceLow = req.body?.minConfidenceLow;
  const blockOpenSeverity = req.body?.blockOpenSeverity;
  const validRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!Number.isInteger(minEvaluatedEpisodes) || minEvaluatedEpisodes < 0 || minEvaluatedEpisodes > 10000 || !validRate(minSuccessRate) || !validRate(minConfidenceLow) || !["none", "critical", "error"].includes(blockOpenSeverity)) {
    res.status(400).json({ ok: false, error: "发布门禁参数无效" }); return;
  }
  const store = readDeploymentStore();
  store.releaseGate = {
    minEvaluatedEpisodes, minSuccessRate, minConfidenceLow, blockOpenSeverity,
    updatedAt: new Date().toISOString(), updatedBy: cleanShortText(req.body?.actor, 80) || "本地用户",
  };
  writeDeploymentStore(store); res.json({ ok: true, releaseGate: store.releaseGate });
});

app.post("/api/training/deployments/:target/deploy", async (req, res) => {
  const model = readRegisteredModels().find((item) => item.id === req.body?.modelId);
  if (!model) { res.status(404).json({ ok: false, error: "找不到已登记模型" }); return; }
  if (model.stage !== "production") { res.status(409).json({ ok: false, error: "只有 production 模型可以部署" }); return; }
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === req.params.target);
  if (!target) { res.status(404).json({ ok: false, error: "找不到部署目标" }); return; }
  const current = target.revisions.find((item) => item.id === target.currentRevisionId);
  if (current?.modelId === model.id) { res.status(409).json({ ok: false, error: "该模型已经是当前部署版本" }); return; }
  const releaseGate = evaluateReleaseGate(model.id, store); const overrideReason = cleanShortText(req.body?.overrideReason, 500);
  if (!releaseGate.ready && overrideReason.length < 10) {
    res.status(412).json({ ok: false, error: "模型未通过发布门禁，受控放行必须填写至少 10 个字符的理由", releaseGate }); return;
  }
  try {
    const revision = await activateDeployment(target.id, model, { actor: cleanShortText(req.body?.actor, 80), notes: cleanShortText(req.body?.notes, 500), action: "deploy", releaseGate, overrideReason });
    res.status(201).json({ ok: true, revision });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/deployments/:target/rollback", async (req, res) => {
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === req.params.target);
  const source = target?.revisions.find((item) => item.id === req.body?.revisionId);
  if (!target || !source) { res.status(404).json({ ok: false, error: "找不到部署目标或历史修订" }); return; }
  if (source.id === target.currentRevisionId) { res.status(409).json({ ok: false, error: "所选修订已经是当前版本" }); return; }
  const model = readRegisteredModels().find((item) => item.id === source.modelId);
  if (!model) { res.status(409).json({ ok: false, error: "历史修订关联的模型已不存在" }); return; }
  try {
    const revision = await activateDeployment(target.id, model, { actor: cleanShortText(req.body?.actor, 80), notes: cleanShortText(req.body?.notes, 500), action: "rollback", rollbackOf: target.currentRevisionId });
    res.status(201).json({ ok: true, revision });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/deployments/:target/incidents", (req, res) => {
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === req.params.target);
  const severities: InferenceIncident["severity"][] = ["warning", "error", "critical"];
  const categories = ["jitter", "action_offset", "collision", "camera", "latency", "hardware", "other"];
  const severity = typeof req.body?.severity === "string" && severities.includes(req.body.severity) ? req.body.severity as InferenceIncident["severity"] : null;
  const category = typeof req.body?.category === "string" && categories.includes(req.body.category) ? req.body.category : null;
  const description = cleanShortText(req.body?.description, 1000);
  const current = target?.revisions.find((item) => item.id === target.currentRevisionId) || null;
  if (!target || !current || !severity || !category || !description) { res.status(400).json({ ok: false, error: "部署目标、严重程度、异常类型或描述无效" }); return; }
  const incident: InferenceIncident = {
    id: `incident-${Date.now().toString(36)}`, targetId: target.id, revisionId: current.id, modelId: current.modelId,
    severity, category, description, status: "open", reportedAt: new Date().toISOString(), reportedBy: cleanShortText(req.body?.actor, 80) || "本地用户", resolvedAt: null, resolution: "",
  };
  store.incidents.unshift(incident); writeDeploymentStore(store); res.status(201).json({ ok: true, incident });
});

app.patch("/api/training/incidents/:incident/resolve", (req, res) => {
  const store = readDeploymentStore(); const incident = store.incidents.find((item) => item.id === req.params.incident);
  const resolution = cleanShortText(req.body?.resolution, 1000);
  if (!incident) { res.status(404).json({ ok: false, error: "找不到推理异常" }); return; }
  if (incident.status === "resolved") { res.status(409).json({ ok: false, error: "异常已经关闭" }); return; }
  if (!resolution) { res.status(400).json({ ok: false, error: "关闭异常时必须填写处理结论" }); return; }
  incident.status = "resolved"; incident.resolvedAt = new Date().toISOString(); incident.resolution = resolution; writeDeploymentStore(store);
  res.json({ ok: true, incident });
});

app.get("/api/training/evaluations", (req, res) => {
  const jobs = readEvaluationJobs();
  let changed = false;
  for (const job of jobs) {
    if ((job.state === "running" || job.state === "stopping") && !evaluationProcesses.has(job.id)) {
      job.state = "failed"; job.finishedAt = new Date().toISOString(); job.error = "服务重启，评估进程状态已丢失"; changed = true;
    } else if (job.state === "draft" && evaluationEpisodeCount(job) >= job.numEpisodes) {
      job.state = "completed"; job.attempts = Math.max(1, job.attempts); job.startedAt ||= job.createdAt;
      try { job.finishedAt = fs.statSync(path.join(job.outputDatasetPath, "meta", "info.json")).mtime.toISOString(); } catch { job.finishedAt = new Date().toISOString(); }
      job.error = null; changed = true;
    }
  }
  if (changed) writeEvaluationJobs(jobs);
  res.json({ ok: true, jobs: jobs.map((job) => ({ ...job, summary: summarizeEvaluation(job) })) });
});

app.post("/api/training/evaluations", (req, res) => {
  const model = readRegisteredModels().find((item) => item.id === req.body?.modelId);
  const name = cleanShortText(req.body?.name, 80);
  const evalDataset = cleanDatasetName(req.body?.evalDataset);
  const task = cleanShortText(req.body?.task, 200);
  const followerPort = typeof req.body?.followerPort === "string" && /^\/dev\/[A-Za-z0-9._-]+$/.test(req.body.followerPort) ? req.body.followerPort : null;
  const leaderPort = typeof req.body?.leaderPort === "string" && /^\/dev\/[A-Za-z0-9._-]+$/.test(req.body.leaderPort) ? req.body.leaderPort : null;
  const followerId = typeof req.body?.followerId === "string" && /^[A-Za-z0-9_-]+$/.test(req.body.followerId) ? req.body.followerId : null;
  const leaderId = typeof req.body?.leaderId === "string" && /^[A-Za-z0-9_-]+$/.test(req.body.leaderId) ? req.body.leaderId : null;
  const firstCamera = Number(req.body?.cameraIndices?.[0]); const secondCamera = Number(req.body?.cameraIndices?.[1]);
  const device = req.body?.device === "cuda" ? "cuda" : "cpu";
  const numEpisodes = Number(req.body?.numEpisodes); const episodeTime = Number(req.body?.episodeTime); const resetTime = Number(req.body?.resetTime);
  if (!model || !name || !evalDataset || !task || !followerPort || !leaderPort || !followerId || !leaderId
      || followerPort === leaderPort || model.dataset === evalDataset
      || !Number.isInteger(firstCamera) || !Number.isInteger(secondCamera) || firstCamera < 0 || secondCamera < 0 || firstCamera === secondCamera
      || !Number.isInteger(numEpisodes) || numEpisodes < 1 || numEpisodes > 1000
      || !Number.isInteger(episodeTime) || episodeTime < 1 || episodeTime > 3600
      || !Number.isInteger(resetTime) || resetTime < 0 || resetTime > 3600) {
    res.status(400).json({ ok: false, error: "评估任务参数无效，评估 Dataset 必须与训练 Dataset 不同" }); return;
  }
  const outputDatasetPath = datasetPath(evalDataset);
  if (readEvaluationJobs().some((job) => job.evalDataset === evalDataset)) { res.status(409).json({ ok: false, error: "评估 Dataset 已被其他任务使用，请使用新的名称" }); return; }
  if (fs.existsSync(path.join(outputDatasetPath, "meta", "info.json"))) { res.status(409).json({ ok: false, error: "评估 Dataset 已存在，请使用新的名称" }); return; }
  const id = `eval-${Date.now().toString(36)}`;
  const job: EvaluationJob = {
    id, name, modelId: model.id, modelName: model.name, modelVersion: model.version, evalDataset, task,
    followerPort, followerId, leaderPort, leaderId, cameraIndices: [firstCamera, secondCamera], device,
    numEpisodes, episodeTime, resetTime, state: "draft", attempts: 0, createdAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, outputDatasetPath, command: [], exitCode: null, error: null, logs: [],
  };
  job.command = buildEvaluationCommand(job, model);
  const jobs = readEvaluationJobs(); jobs.unshift(job); writeEvaluationJobs(jobs);
  res.status(201).json({ ok: true, job });
});

app.get("/api/training/evaluations/:job/preflight", async (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  try { res.json({ ok: true, ...await evaluationPreflight(job) }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/evaluations/:job/start", async (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  if (!["draft", "failed", "cancelled"].includes(job.state)) { res.status(409).json({ ok: false, error: "只有草稿、失败或已停止任务可以启动" }); return; }
  try {
    const preflight = await evaluationPreflight(job);
    if (!preflight.ready) { res.status(409).json({ ok: false, error: "评估启动前检查未通过", preflight }); return; }
    await startEvaluationJob(job); res.json({ ok: true, job, preflight });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/evaluations/:job/stop", (req, res) => {
  const child = evaluationProcesses.get(req.params.job);
  if (!child) { res.status(409).json({ ok: false, error: "评估任务未运行" }); return; }
  const job = updateEvaluationJob(req.params.job, (current) => { current.state = "stopping"; });
  child.kill("SIGTERM"); res.json({ ok: true, job });
});

app.delete("/api/training/evaluations/:job", (req, res) => {
  const jobs = readEvaluationJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  if (job.state !== "draft" || job.attempts > 0 || fs.existsSync(job.outputDatasetPath)) { res.status(409).json({ ok: false, error: "只能删除从未启动且没有输出数据的草稿" }); return; }
  writeEvaluationJobs(jobs.filter((item) => item.id !== job.id));
  res.json({ ok: true, deleted: job.id });
});

app.get("/api/training/evaluations/:job/results", async (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  if (!fs.existsSync(path.join(job.outputDatasetPath, "meta", "info.json"))) { res.json({ ok: true, available: false, summary: summarizeEvaluation(job), episodes: [] }); return; }
  try {
    const detail = await runDatasetCatalog("detail", job.evalDataset);
    const results = readEvaluationResults(job); const reviews = readReviews(job.outputDatasetPath);
    const episodes = Array.isArray(detail.episodes) ? detail.episodes.map((episode) => {
      const item = episode as Record<string, unknown>; const index = Number(item.episode);
      const videos = item.videos && typeof item.videos === "object" ? Object.fromEntries(
        Object.entries(item.videos as Record<string, string>).map(([key, relative]) => [key, `/api/datasets/${encodeURIComponent(job.evalDataset)}/video?file=${Buffer.from(relative).toString("base64url")}`]),
      ) : {};
      return { ...item, videos, dataReview: reviews.episodes[String(index)] || { status: "unreviewed" }, outcome: results.episodes[String(index)] || { status: "unreviewed", failureReason: "", notes: "", reviewer: "" } };
    }) : [];
    res.json({ ok: true, available: true, summary: summarizeEvaluation(job), episodes });
  } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.patch("/api/training/evaluations/:job/results/:episode", (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job); const episode = Number(req.params.episode);
  if (!job || !Number.isInteger(episode) || episode < 0) { res.status(404).json({ ok: false, error: "找不到评估任务或 Episode" }); return; }
  const statuses: EvaluationOutcomeStatus[] = ["unreviewed", "success", "failure", "invalid"];
  const status = typeof req.body?.status === "string" && statuses.includes(req.body.status) ? req.body.status as EvaluationOutcomeStatus : null;
  const failureReasons = ["", "object_missed", "grasp_failed", "placement_failed", "collision", "timeout", "unstable", "camera_occlusion", "action_offset", "other"];
  const failureReason = typeof req.body?.failureReason === "string" && failureReasons.includes(req.body.failureReason) ? req.body.failureReason : null;
  if (!status || failureReason === null || (status === "failure" && !failureReason)) { res.status(400).json({ ok: false, error: "评估结果无效；失败结果必须选择失败原因" }); return; }
  try {
    ensureEpisodeExists(job.outputDatasetPath, episode);
    const results = readEvaluationResults(job); const previous = results.episodes[String(episode)]; const now = new Date().toISOString();
    const outcome: EvaluationOutcome = { status, failureReason: status === "failure" || status === "invalid" ? failureReason : "", notes: cleanShortText(req.body?.notes, 2000), reviewer: cleanShortText(req.body?.reviewer, 80), createdAt: previous?.createdAt || now, updatedAt: now };
    results.episodes[String(episode)] = outcome; writeEvaluationResults(job, results);
    appendAudit(job.outputDatasetPath, { action: "evaluation.outcome", actor: outcome.reviewer || "本地用户", dataset: job.evalDataset, episodes: [episode], evaluationJob: job.id, model: job.modelId, outcome: status, failureReason: outcome.failureReason });
    res.json({ ok: true, outcome, summary: summarizeEvaluation(job) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); res.status(message.startsWith("找不到") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.post("/api/training/jobs", (req, res) => {
  const dataset = cleanDatasetName(req.body.dataset);
  const collectionId = typeof req.body.collection === "string" && /^v\d{3}$/.test(req.body.collection) ? req.body.collection : null;
  const policies = ["act", "diffusion", "tdmpc", "vqbet", "smolvla", "pi0", "pi0-fast", "sac", "reward_classifier"];
  const policy = typeof req.body.policy === "string" && policies.includes(req.body.policy) ? req.body.policy : null;
  const device = req.body.device === "cpu" ? "cpu" : "cuda";
  const batchSize = Number(req.body.batchSize);
  const steps = Number(req.body.steps);
  const logFreq = Number(req.body.logFreq ?? 200);
  const saveFreq = Number(req.body.saveFreq ?? Math.min(20000, steps));
  const numWorkers = Number(req.body.numWorkers ?? 4);
  const seed = Number(req.body.seed ?? 1000);
  const hostId = typeof req.body.hostId === "string" && (req.body.hostId === "local" || /^host-[a-z0-9-]+$/.test(req.body.hostId)) ? req.body.hostId : "local";
  const name = cleanShortText(req.body.name, 80);
  if (!dataset || !collectionId || !policy || !name || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024 || !Number.isInteger(steps) || steps < 1 || steps > 10_000_000 || !Number.isInteger(logFreq) || logFreq < 1 || logFreq > steps || !Number.isInteger(saveFreq) || saveFreq < 1 || saveFreq > steps || !Number.isInteger(numWorkers) || numWorkers < 0 || numWorkers > 64 || !Number.isInteger(seed) || seed < 0) {
    res.status(400).json({ ok: false, error: "训练任务参数无效" }); return;
  }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const collection = JSON.parse(fs.readFileSync(path.join(collectionsDirectory(root), `${collectionId}.json`), "utf-8")) as TrainingCollection;
    const episodes = collection.episodes.map((item) => item.episode);
    if (!episodes.length) throw new Error("训练选集没有 Episode");
    const id = `train-${Date.now().toString(36)}`;
    const outputDir = path.join(TRAINING_ROOT, "outputs", id);
    const command = [
      "-m", "lerobot.scripts.lerobot_train",
      `--dataset.repo_id=local/${dataset}`,
      `--dataset.root=${root}`,
      `--dataset.episodes=[${episodes.join(",")}]`,
      `--policy.type=${policy}`,
      `--output_dir=${outputDir}`,
      `--job_name=${name}`,
      `--policy.device=${device}`,
      "--policy.push_to_hub=false",
      "--wandb.enable=false",
      `--batch_size=${batchSize}`,
      `--steps=${steps}`,
      `--log_freq=${logFreq}`,
      `--save_freq=${saveFreq}`,
      `--num_workers=${numWorkers}`,
      `--seed=${seed}`,
    ];
    const job: TrainingJob = {
      id, name, dataset, collection: collectionId, episodes, policy, device, batchSize, steps, logFreq, saveFreq, numWorkers, seed, attempts: 0,
      hostId, state: "draft", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      outputDir, command, exitCode: null, error: null, logs: [],
    };
    const jobs = readTrainingJobs(); jobs.unshift(job); writeTrainingJobs(jobs);
    res.status(201).json({ ok: true, job });
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/training/jobs/:job/start", (req, res) => {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (job.state !== "draft" && job.state !== "failed") { res.status(409).json({ ok: false, error: "只有草稿或失败任务可以启动" }); return; }
  if (job.state === "failed" && fs.existsSync(job.outputDir)) { res.status(409).json({ ok: false, error: "失败任务已有输出，请新建任务或使用 Checkpoint 续训" }); return; }
  void trainingPreflight(job).then((preflight) => {
    if (!preflight.ready) { res.status(409).json({ ok: false, error: "启动前检查未通过", preflight }); return; }
    try { startTrainingJob(job); res.json({ ok: true, job, preflight }); }
    catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error), preflight }); }
  }).catch((error) => res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});

app.get("/api/training/jobs/:job/preflight", async (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  try { res.json({ ok: true, ...await trainingPreflight(job) }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/training/jobs/:job/cloud-spec", (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  const remoteRoot = `/data/lerobot/${job.dataset}`;
  const remoteOutput = `outputs/${job.id}`;
  const remoteCommand = job.command.map((argument) => argument.replace(`--dataset.root=${datasetPath(job.dataset)}`, `--dataset.root=${remoteRoot}`).replace(`--output_dir=${job.outputDir}`, `--output_dir=${remoteOutput}`));
  const spec = {
    schemaVersion: 1,
    provider: "generic-ssh",
    generatedAt: new Date().toISOString(),
    job: { id: job.id, name: job.name, policy: job.policy, device: job.device, batchSize: job.batchSize, steps: job.steps, numWorkers: job.numWorkers ?? 4, seed: job.seed ?? 1000 },
    dataset: { name: job.dataset, collection: job.collection, episodes: job.episodes, localRoot: datasetPath(job.dataset), remoteRoot, manifestUrl: `/api/datasets/${encodeURIComponent(job.dataset)}/collections/${encodeURIComponent(job.collection)}/snapshot` },
    resourceEstimate: estimateTrainingResources(job),
    sync: { exclude: [".lerobot-web"], command: ["rsync", "-a", "--exclude=.lerobot-web", `${datasetPath(job.dataset)}/`, `user@cloud-host:${remoteRoot}/`] },
    remote: { workingDirectory: remoteOutput, trainCommand: ["python3", ...remoteCommand], installHint: "在云主机安装与本地一致的 lerobot 版本及策略依赖；默认不上传 Hugging Face/WandB。" },
    notes: ["这是可审计的命令方案，不会连接云主机或上传数据。", "上传前请在云端校验 snapshot manifest fingerprint。"],
  };
  res.json({ ok: true, spec });
});

app.post("/api/training/jobs/:job/clone", (req, res) => {
  const source = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!source) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  const id = `train-${Date.now().toString(36)}`;
  const outputDir = path.join(TRAINING_ROOT, "outputs", id);
  const command = [
    "-m", "lerobot.scripts.lerobot_train",
    `--dataset.repo_id=local/${source.dataset}`,
    `--dataset.root=${datasetPath(source.dataset)}`,
    `--dataset.episodes=[${source.episodes.join(",")}]`,
    `--policy.type=${source.policy}`,
    `--output_dir=${outputDir}`,
    `--job_name=${source.name} copy`,
    `--policy.device=${source.device}`,
    "--policy.push_to_hub=false", "--wandb.enable=false",
    `--batch_size=${source.batchSize}`, `--steps=${source.steps}`,
    `--log_freq=${source.logFreq ?? 200}`, `--save_freq=${source.saveFreq ?? Math.min(20000, source.steps)}`,
    `--num_workers=${source.numWorkers ?? 4}`, `--seed=${source.seed ?? 1000}`,
  ];
  const cloned: TrainingJob = { ...source, id, name: `${source.name} copy`, state: "draft", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, outputDir, command, exitCode: null, error: null, logs: [], attempts: 0, archivedAt: null, bestAt: null };
  const jobs = readTrainingJobs(); jobs.unshift(cloned); writeTrainingJobs(jobs);
  res.status(201).json({ ok: true, job: enrichTrainingJob(cloned) });
});

app.post("/api/training/jobs/:job/archive", (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (["running", "stopping"].includes(job.state)) { res.status(409).json({ ok: false, error: "运行中的任务不能归档" }); return; }
  const archived = req.body?.archived !== false;
  const updated = updateTrainingJob(job.id, (current) => { current.archivedAt = archived ? new Date().toISOString() : null; });
  res.json({ ok: true, job: updated ? enrichTrainingJob(updated) : null });
});

app.post("/api/training/jobs/:job/best", (req, res) => {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (job.state !== "completed") { res.status(409).json({ ok: false, error: "只有已完成任务可以标记为最佳 Run" }); return; }
  const best = req.body?.best !== false;
  const now = new Date().toISOString();
  for (const item of jobs) {
    if (best && item.dataset === job.dataset && item.collection === job.collection && item.policy === job.policy) item.bestAt = null;
  }
  job.bestAt = best ? now : null;
  writeTrainingJobs(jobs);
  res.json({ ok: true, job: enrichTrainingJob(job) });
});

app.get("/api/training/jobs/:job/checkpoints/:checkpoint/integrity", async (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  const checkpoint = job && trainingCheckpoints(job).find((item) => item.name === req.params.checkpoint);
  if (!job || !checkpoint) { res.status(404).json({ ok: false, error: "找不到 Checkpoint" }); return; }
  if (!checkpoint.modelPath) { res.status(404).json({ ok: false, error: "Checkpoint 中没有 model.safetensors" }); return; }
  try { res.json({ ok: true, algorithm: "sha256", hash: await fileSha256(checkpoint.modelPath), file: path.basename(checkpoint.modelPath), sizeBytes: fs.statSync(checkpoint.modelPath).size }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/jobs/:job/checkpoints/:checkpoint/register", async (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  const checkpoint = job && trainingCheckpoints(job).find((item) => item.name === req.params.checkpoint);
  if (!job || !checkpoint) { res.status(404).json({ ok: false, error: "找不到 Checkpoint" }); return; }
  if (!checkpoint.modelPath) { res.status(409).json({ ok: false, error: "Checkpoint 中没有可登记的 model.safetensors" }); return; }
  const models = readRegisteredModels();
  const existing = models.find((model) => model.jobId === job.id && model.checkpoint === checkpoint.name);
  if (existing) { res.status(409).json({ ok: false, error: `该 Checkpoint 已登记为 ${existing.name} v${existing.version}` }); return; }
  const name = cleanShortText(req.body?.name, 80) || job.name;
  const notes = cleanShortText(req.body?.notes, 500);
  const version = Math.max(0, ...models.filter((model) => model.name === name).map((model) => model.version)) + 1;
  try {
    const now = new Date().toISOString();
    const model: RegisteredModel = {
      id: `model-${Date.now().toString(36)}`, name, version, jobId: job.id, checkpoint: checkpoint.name,
      step: checkpoint.step, policy: job.policy, dataset: job.dataset, collection: job.collection,
      modelPath: checkpoint.modelPath, sizeBytes: fs.statSync(checkpoint.modelPath).size,
      sha256: await fileSha256(checkpoint.modelPath), stage: "candidate", notes, createdAt: now, updatedAt: now,
    };
    models.unshift(model); writeRegisteredModels(models);
    res.status(201).json({ ok: true, model });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/training/models/:model", (req, res) => {
  const models = readRegisteredModels();
  const model = models.find((item) => item.id === req.params.model);
  if (!model) { res.status(404).json({ ok: false, error: "找不到已登记模型" }); return; }
  const stages: ModelStage[] = ["candidate", "production", "archived"];
  const stage = typeof req.body?.stage === "string" && stages.includes(req.body.stage) ? req.body.stage as ModelStage : null;
  if (!stage) { res.status(400).json({ ok: false, error: "模型阶段无效" }); return; }
  if (stage === "production") {
    for (const item of models) if (item.name === model.name && item.stage === "production") { item.stage = "candidate"; item.updatedAt = new Date().toISOString(); }
  }
  model.stage = stage; model.updatedAt = new Date().toISOString();
  writeRegisteredModels(models);
  res.json({ ok: true, model });
});

app.post("/api/training/jobs/:job/stop", (req, res) => {
  const child = trainingProcesses.get(req.params.job);
  if (!child) { res.status(409).json({ ok: false, error: "训练任务未运行" }); return; }
  const job = updateTrainingJob(req.params.job, (current) => { current.state = "stopping"; });
  child.kill("SIGTERM");
  res.json({ ok: true, job });
});

app.post("/api/training/jobs/:job/resume", (req, res) => {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (!["failed", "cancelled"].includes(job.state)) { res.status(409).json({ ok: false, error: "只有失败或已停止的任务可以续训" }); return; }
  const checkpoint = trainingCheckpoints(job)[0];
  if (!checkpoint) { res.status(409).json({ ok: false, error: "没有可用 Checkpoint，无法续训" }); return; }
  void trainingPreflight(job).then((preflight) => {
    if (!preflight.ready) { res.status(409).json({ ok: false, error: "启动前检查未通过", preflight }); return; }
    try {
      job.command = ["-m", "lerobot.scripts.lerobot_train", `--config_path=${checkpoint.configPath}`, "--resume=true"];
      startTrainingJob(job);
      res.json({ ok: true, job: enrichTrainingJob(job), preflight });
    } catch (error) {
      res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error), preflight });
    }
  }).catch((error) => res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});

app.post("/api/recording/start", (req, res) => {
  if (evaluationProcesses.size > 0) {
    res.status(409).json({ ok: false, error: "模型评估正在占用机械臂和摄像头" });
    return;
  }
  if (!bridge?.isRunning() || stopping) {
    res.status(409).json({ ok: false, error: "请先启动遥操作" });
    return;
  }
  if (recordingIsActive() || recorder?.isRunning()) {
    res.status(409).json({ ok: false, error: "录制任务已在运行" });
    return;
  }
  const dataset = cleanDatasetName(req.body.dataset);
  const task = typeof req.body.task === "string" ? req.body.task.trim() : "";
  const plannedEpisodes = Number(req.body.plannedEpisodes ?? 1);
  const episodeTime = Number(req.body.episodeTime ?? 20);
  const resetTime = Number(req.body.resetTime ?? 0);
  const resume = true;
  if (!dataset) {
    res.status(400).json({ ok: false, error: "数据集名称仅支持字母、数字、点、下划线和连字符（最多 64 字符）" });
    return;
  }
  if (!task || task.length > 200) {
    res.status(400).json({ ok: false, error: "任务描述不能为空且不能超过 200 字符" });
    return;
  }
  if (!Number.isInteger(plannedEpisodes) || plannedEpisodes < 1 || plannedEpisodes > 10000 || !Number.isInteger(episodeTime) || episodeTime < 1 || episodeTime > 3600 || !Number.isInteger(resetTime) || resetTime < 0 || resetTime > 3600) {
    res.status(400).json({ ok: false, error: "计划组数、单轮时长或复位时间无效" });
    return;
  }
  const now = Date.now();
  if (
    !latestObservation
    || !hasCompleteCaptureJoints(latestObservation)
    || now - latestObservationAt > RECORDING_MAX_SENSOR_AGE_MS
  ) {
    res.status(409).json({ ok: false, error: "没有收到实时关节状态和动作，无法开始录制" });
    return;
  }
  if (
    !latestCameraFrame
    || !latestCamera2Frame
    || now - cameraLastFrameAt > RECORDING_MAX_SENSOR_AGE_MS
    || now - camera2LastFrameAt > RECORDING_MAX_SENSOR_AGE_MS
    || Math.abs(cameraLastFrameAt - camera2LastFrameAt) > RECORDING_MAX_CAMERA_SKEW_MS
  ) {
    res.status(409).json({ ok: false, error: "录制需要两路实时摄像头画面" });
    return;
  }

  const datasetDir = path.join(DATASET_ROOT, dataset);
  let existingEpisodes: string[] = [];
  try {
    existingEpisodes = fs.readdirSync(datasetDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^episode_\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    existingEpisodes = [];
  }
  const nextIndex = existingEpisodes.reduce((max, name) => {
    const match = /^episode_(\d+)$/.exec(name);
    return match ? Math.max(max, parseInt(match[1], 10) + 1) : max;
  }, 0);
  const episodeDir = path.join(datasetDir, `episode_${String(nextIndex).padStart(4, "0")}`);
  const sidecarPath = `${episodeDir}.json`;
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.writeFileSync(sidecarPath, JSON.stringify({
    dataset, task, robotType: "so101_follower", episode: nextIndex, startedAt: now, endedAt: null,
  }, null, 2));

  const startedRecorder = new BagRecorderProcess(episodeDir, BAG_RECORD_TOPICS);
  startedRecorder.on("log", ({ level, message }: { level: "info" | "warn" | "error"; message: string }) => {
    persistRuntimeLog("recorder", level, message);
    broadcastControl({ type: "bridge_log", source: "recorder", level, message });
  });
  recorder = startedRecorder;
  recordingEpisodeDir = episodeDir;
  recordingSidecarPath = sidecarPath;
  recordingStopInFlight = false;
  recordingStatus = {
    state: "preparing", dataset, task, startedAt: null,
    episode: nextIndex, path: episodeDir, error: null, plannedEpisodes, episodeTime, resetTime, resume,
    lastResult: null,
  };

  startedRecorder.on("ready", () => {
    if (recorder !== startedRecorder) return;
    recordingStatus = { ...recordingStatus, state: "recording", startedAt: Date.now() };
    publishRecordingStatus();
    clearRecordingAutoStopTimer();
    recordingAutoStopTimer = setTimeout(() => requestRecordingSave(), episodeTime * 1000).unref();
  });
  startedRecorder.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (recorder !== startedRecorder || recordingStopInFlight) return;
    recorder = null;
    clearRecordingAutoStopTimer();
    if (recordingIsActive()) {
      recordingStatus = {
        ...recordingStatus,
        state: "error",
        error: recordingStatus.error || `录制进程意外退出 (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      };
      publishRecordingStatus();
    }
  });
  startedRecorder.on("error", (error: Error) => {
    if (recorder !== startedRecorder) return;
    clearRecordingAutoStopTimer();
    recordingStatus = { ...recordingStatus, state: "error", error: error.message };
    publishRecordingStatus();
  });
  startedRecorder.start();
  publishRecordingStatus();
  res.json({ ok: true, ...recordingStatus });
});

app.post("/api/recording/stop", (req, res) => {
  if (!requestRecordingSave()) {
    res.status(409).json({ ok: false, error: "当前没有可停止的录制任务" });
    return;
  }
  res.json({ ok: true, ...recordingStatus });
});

app.post("/api/recording/cancel", (req, res) => {
  if (!requestRecordingCancel()) {
    res.status(409).json({ ok: false, error: "当前没有可取消的录制任务" });
    return;
  }
  res.json({ ok: true, ...recordingStatus });
});

// ===================== API =====================

// 串口检测
app.get("/api/ports", (req, res) => {
  try {
    // 分别检测 ACM 和 USB，避免某个 glob 无匹配导致 ls 返回非零
    const ports: string[] = [];
    try {
      const acm = execSync("ls -1 /dev/ttyACM* 2>/dev/null", { encoding: "utf-8" }).trim();
      if (acm) ports.push(...acm.split("\n").filter((p) => p.trim() !== ""));
    } catch { /* no ACM */ }
    try {
      const usb = execSync("ls -1 /dev/ttyUSB* 2>/dev/null", { encoding: "utf-8" }).trim();
      if (usb) ports.push(...usb.split("\n").filter((p) => p.trim() !== ""));
    } catch { /* no USB */ }
    ports.sort();
    res.json({ ports });
  } catch {
    res.json({ ports: [] });
  }
});

app.get("/api/cameras", (req, res) => {
  try {
    const detected = [...new Set([
      ...detectUsbCameraIndices(),
      activeCameraIndex,
      activeCameraIndex2,
    ].filter((index): index is number => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b);
    const cameras = fs.readdirSync("/dev").filter((name) => /^video\d+$/.test(name)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((name) => ({ index: Number(name.slice(5)), path: `/dev/${name}` }));
    res.json({
      cameras,
      active: {
        camera: activeCameraIndex,
        camera2: activeCameraIndex2,
        camera3: -1,
        camera4: -1,
      },
      detected,
      source: USE_ROS_CAMERA ? "ros" : "usb",
      switchable: !USE_ROS_CAMERA,
      capture: USE_ROS_CAMERA ? {
        topics: ["/camera1/image_raw/compressed", "/camera2/image_raw/compressed"],
        previewTopics: ["/camera1/image_raw/compressed", "/camera2/image_raw/compressed"],
        recordingTopics: ["/camera1/image_raw", "/camera2/image_raw"],
      } : null,
      stream: { width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS, codec: "MJPG" },
    });
  } catch {
    res.json({
      cameras: [],
      active: { camera: -1, camera2: -1, camera3: -1, camera4: -1 },
      detected: [],
      switchable: false,
    });
  }
});

app.get("/api/self-check", (req, res) => {
  const followerId = typeof req.query.follower_id === "string" ? req.query.follower_id : "R12253102";
  const now = Date.now();
  const detected = [...new Set([
    ...detectUsbCameraIndices(),
    activeCameraIndex,
    activeCameraIndex2,
  ].filter((index): index is number => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b);
  let serialPorts: string[] = [];
  try {
    serialPorts = fs.readdirSync("/dev")
      .filter((name) => /^tty(?:ACM|USB)\d+$/.test(name))
      .sort()
      .map((name) => `/dev/${name}`);
  } catch { /* /dev unavailable */ }
  const legacyCalibrationPath = /^[A-Za-z0-9_-]+$/.test(followerId)
    ? path.join(process.env.HOME || "/root", ".lerobot", "calibration", "so101_follower", `${followerId}.json`)
    : "";
  const calibrationPath = fs.existsSync(FOLLOWER_CALIBRATION_FILE)
    ? FOLLOWER_CALIBRATION_FILE
    : legacyCalibrationPath;

  let calibrationValid = false;
  if (calibrationPath) {
    try {
      const calibration = JSON.parse(fs.readFileSync(calibrationPath, "utf-8"));
      const names = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
      calibrationValid = names.every((name, index) => {
        const entry = calibration[name] || calibration[String(index + 1)];
        return Number.isInteger(entry?.id) && Number.isFinite(entry?.homing_offset)
          && Number.isFinite(entry?.range_min) && Number.isFinite(entry?.range_max);
      });
    } catch { /* invalid or missing calibration */ }
  }

  const cameraStatus = (
    index: number,
    child: { isRunning(): boolean } | null,
    lastFrameAt: number,
    error: string | null,
    metrics: Record<string, unknown>,
  ) => ({
    index,
    detected: index >= 0 && detected.includes(index),
    processRunning: USE_ROS_CAMERA ? index >= 0 : Boolean(child?.isRunning()),
    frameFresh: lastFrameAt > 0 && now - lastFrameAt < 2000,
    lastFrameAgeMs: lastFrameAt > 0 ? now - lastFrameAt : null,
    error,
    metrics,
  });

  res.json({
    checkedAt: new Date(now).toISOString(),
    server: { ok: true, running: bridge ? bridge.isRunning() && !stopping : false, dataOnly: DATA_ONLY },
    capture: {
      storage: "lerobot-dataset",
    },
    follower: {
      ports: serialPorts,
      portPresent: serialPorts.length > 0,
      id: followerId,
      calibrationValid,
    },
    camerasDetected: detected,
    cameras: [
      cameraStatus(activeCameraIndex, cameraBridge, cameraLastFrameAt, cameraError, cameraMetrics),
      cameraStatus(activeCameraIndex2, cameraBridge2, camera2LastFrameAt, camera2Error, camera2Metrics),
    ],
  });
});

// 仅向已打开控制台的浏览器提供指定 Leader 的公开标定数据；ID 限制防止路径穿越。
app.get("/api/calibration/leader/:id", (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    res.status(400).json({ ok: false, error: "无效的 Leader ID" });
    return;
  }
  const home = process.env.HOME || "/root";
  const files = [
    path.join(ROBOT_DRIVER_CALIBRATION_ROOT, "leader", `${id}.json`),
    path.join(home, ".cache", "huggingface", "lerobot", "calibration", "teleoperators", "so101_leader", `${id}.json`),
    path.join(home, ".lerobot", "calibration", "so101_leader", `${id}.json`),
  ];
  const file = files.find((candidate) => fs.existsSync(candidate));
  try {
    if (!file) throw new Error("calibration not found");
    res.json({ ok: true, calibration: JSON.parse(fs.readFileSync(file, "utf-8")) });
  } catch {
    res.status(404).json({ ok: false, error: `找不到 Leader 标定文件: ${id}` });
  }
});

app.get("/api/calibration/follower", (_req, res) => {
  try {
    const calibration = JSON.parse(fs.readFileSync(FOLLOWER_CALIBRATION_FILE, "utf-8"));
    res.json({ ok: true, calibration });
  } catch {
    res.status(404).json({ ok: false, error: "找不到 Follower 标定文件" });
  }
});

// 启动遥操作
app.post("/api/start", async (req, res) => {
  if (DATA_ONLY) {
    res.status(409).json({ ok: false, error: "当前为仅数据平台模式（DATA_ONLY=1），未连接机械臂；遥操作与实机录制不可用" });
    return;
  }
  if (evaluationProcesses.size > 0) {
    res.status(409).json({ ok: false, error: "模型评估正在占用机械臂和摄像头" });
    return;
  }
  if (bridge && bridge.isRunning()) {
    res.status(400).json({ ok: false, error: stopping ? "正在停止，请稍候" : "已在运行中" });
    return;
  }

  const {
    follower_port = "/dev/ttyACM0",
    follower_id = "",
    leader_port = "/dev/ttyACM1",
    leader_id = "",
    // 控制链路默认 60 FPS；状态观测仍由 CONTROL_OBSERVATION_FPS 独立限频。
    fps = 60,
    remote_leader = false,
    camera_index = -1,
    camera_fps = 15,
  } = req.body;
  if (remote_leader !== true) {
    res.status(400).json({ ok: false, error: "当前仅支持网页串口控制，请先在浏览器连接 Leader" });
    return;
  }
  const commandSource = "web";
  const requiresFollowerSerial = true;
  const requiresLeaderSerial = false;

  if (requiresFollowerSerial && (typeof follower_port !== "string" || !follower_port.startsWith("/dev/tty"))) {
    res.status(400).json({ ok: false, error: "Follower 串口无效" });
    return;
  }
  if (requiresFollowerSerial && (typeof follower_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(follower_id))) {
    res.status(400).json({ ok: false, error: "Follower ID 无效" });
    return;
  }
  if (requiresLeaderSerial && (typeof leader_port !== "string" || !leader_port.startsWith("/dev/tty"))) {
    res.status(400).json({ ok: false, error: "Leader 串口无效" });
    return;
  }
  if (requiresLeaderSerial && (typeof leader_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(leader_id))) {
    res.status(400).json({ ok: false, error: "Leader ID 无效" });
    return;
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    res.status(400).json({ ok: false, error: "FPS 必须是 1-60 之间的整数" });
    return;
  }

  if (hardwareReleased) {
    try {
      if (hardwareNeedsActivation) await setHardwareComponentState("active");
      await setManualControllersActive();
      hardwareReleased = false;
      hardwareNeedsActivation = false;
    } catch (error) {
      res.status(503).json({ ok: false, error: `无法恢复电机扭矩: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
  }

  if (ENABLE_CAMERA && Number.isInteger(camera_index) && camera_index >= 0 && camera_index !== activeCameraIndex) {
    startCamera(camera_index);
  }

  const manualSlewScale = WEB_MANUAL_SLEW_SCALE;
  const controlBridgeArgs = [
    ...ROS_BRIDGE_ARGS,
    "--ros-args", "-p", `manual_slew_scale:=${manualSlewScale.toFixed(1)}`,
  ];
  console.log(`[Server] 启动 ROS2 控制桥 (${commandSource}, slew=${manualSlewScale}x): ${ROS_BRIDGE_COMMAND} ${controlBridgeArgs.join(" ")}`);

  if (telemetryBridge?.isRunning()) telemetryBridge.stop();
  telemetryBridge = null;

  const startedBridge = new RobotBridge(ROS_BRIDGE_COMMAND, controlBridgeArgs, CONTROL_PYTHON_PATH, true);
  startedBridge.on("log", ({ level, message }) => {
    const normalizedLevel: RuntimeLogLevel = level === "error" || level === "stderr" ? "error" : level === "warn" ? "warn" : "info";
    persistRuntimeLog("teleop", normalizedLevel, message);
    broadcastControl({ type: "bridge_log", source: "teleop", level: normalizedLevel, message });
  });
  bridge = startedBridge;
  stopping = false;
  remoteLeaderActive = commandSource === "web";
  activeControlSource = "web";
  latestObservation = null;
  latestObservationAt = 0;

  startedBridge.on("message", (msg: BridgeMessage) => {
    if (handleRosCameraFrame(msg)) return;
    switch (msg.type) {
      case "teleop_observation":
        latestObservation = msg;
        latestObservationAt = Date.now();
        broadcastControl(msg);
        break;

      case "capture_sample":
        break;

      default:
        console.log(`[Server] 未知消息类型: ${msg.type}`);
    }
  });

  startedBridge.on("exit", (code, errorLine) => {
    console.log(`[Server] 遥操作进程退出 (code=${code})`);
    // 旧进程的退出不能影响之后启动的新进程。
    if (bridge === startedBridge) {
      const wasRequested = stopping;
      if (!wasRequested) requestRecordingSave();
      bridge = null;
      stopping = false;
      remoteLeaderActive = false;
      activeControlSource = null;
      // 非用户主动停止且带非零退出码，说明 Python 侧崩溃；把报错原因推给前端弹窗提示。
      const crashError = !wasRequested && code !== 0 ? errorLine || `进程异常退出 (code=${code})` : null;
      broadcastControl({ type: "stopped", error: crashError });
      setTimeout(startTelemetryBridge, 500).unref();
    }
  });

  startedBridge.on("error", (err) => {
    console.error(`[Server] 桥接错误:`, err);
  });

  startedBridge.start();
  broadcastControl({ type: "status", running: true });
  res.json({ ok: true, msg: "遥操作已启动" });
});

// Motor workspace fallback: send one complete pose over HTTP when a browser
// cannot keep its control WebSocket open. The real-time path remains the C++
// ROS2 bridge managed by RobotBridge.
app.post("/api/action", (req, res) => {
  if (!bridge?.isRunning() || activeControlSource !== "web" || stopping) {
    res.status(409).json({ ok: false, error: "手动控制链路未启用" });
    return;
  }
  const joints = req.body?.joints;
  const names = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
  if (!joints || typeof joints !== "object" || names.some((name) => typeof joints[name] !== "number" || !Number.isFinite(joints[name]))) {
    res.status(400).json({ ok: false, error: "需要六个有效的关节目标值" });
    return;
  }
  bridge.send({ type: "action", joints, seq: Date.now() });
  const user = (req as express.Request & { authUser?: AuthUser }).authUser!;
  const audit: MotionAudit = {
    active: false, startedAt: 0, lastActionAt: 0, timer: null,
    channel: "HTTP", user: auditUserLabel(user), ip: requestClientIp(req),
  };
  recordMotion(audit);
  res.json({ ok: true });
});

// 停止遥操作
app.post("/api/stop", (req, res) => {
  if (!stopTeleop()) {
    res.json({ ok: true, alreadyStopped: true });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/emergency-release", async (_req, res) => {
  stopTeleop();
  let directError: Error | null = null;
  try {
    // The direct command is the emergency action. Do it before asking ROS to
    // transition lifecycle state, because ROS discovery may be unavailable.
    disableFollowerTorqueDirectly();
    hardwareReleased = true;
    hardwareNeedsActivation = true;
    broadcastControl({ type: "status", running: false });
    res.json({ ok: true, released: true, method: "direct_serial" });
  } catch (error) {
    directError = error instanceof Error ? error : new Error(String(error));
  }
  if (directError) {
    try {
      await setHardwareComponentState("inactive");
      hardwareReleased = true;
      hardwareNeedsActivation = true;
      broadcastControl({ type: "status", running: false });
      res.json({ ok: true, released: true, method: "ros_fallback" });
    } catch (rosError) {
      res.status(503).json({ ok: false, error: `直接串口释力失败: ${directError.message}; ROS 兜底也失败: ${rosError instanceof Error ? rosError.message : String(rosError)}` });
    }
    return;
  }

  // Release has already been sent. Keep ROS cleanup asynchronous so service
  // discovery delays can never delay the emergency-stop response.
  void setHardwareComponentState("inactive").catch((error) => {
    console.warn(`[Emergency] ROS lifecycle cleanup failed after direct release: ${error instanceof Error ? error.message : String(error)}`);
  });
});

// 状态查询
app.get("/api/status", (req, res) => {
  res.json({
    running: bridge ? bridge.isRunning() && !stopping : false,
    clients: clients.size,
    controlBackend: "ros2",
    commandSource: activeControlSource === "web" ? "web" : "com",
    rtc: { enabled: rtcGateway.isEnabled(), peers: rtcGateway.peerCount() },
  });
});

app.get("/api/rtc/config", (_req, res) => {
  res.json({
    enabled: rtcGateway.isEnabled(),
    videoEnabled: rtcGateway.isVideoEnabled(),
    iceServers: RTC_ICE_SERVERS,
    channels: {
      control: "robot-control-v1",
      state: "robot-state-v1",
      video: "robot-video-v1",
      safety: "robot-safety-v1",
    },
  });
});

app.post("/api/rtc/offer", async (req, res) => {
  try {
    const user = (req as express.Request & { authUser?: AuthUser }).authUser!;
    rtcMotionAudit = {
      active: false, startedAt: 0, lastActionAt: 0, timer: null,
      channel: "WebRTC", user: auditUserLabel(user), ip: requestClientIp(req),
    };
    const answer = await rtcGateway.acceptOffer(req.body);
    res.json(answer);
  } catch (error) {
    res.status(rtcGateway.isEnabled() ? 400 : 503).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// 切换摄像头
app.post("/api/camera/switch", (req, res) => {
  if (evaluationProcesses.size > 0) {
    res.status(409).json({ ok: false, error: "模型评估期间不能切换摄像头" });
    return;
  }
  if (recordingIsActive()) {
    res.status(409).json({ ok: false, error: "录制期间不能切换摄像头" });
    return;
  }
  if (USE_ROS_CAMERA) {
    res.status(409).json({ ok: false, error: "ROS 相机模式下设备映射由启动参数决定，请修改 ROS_CAMERA1_DEVICE/ROS_CAMERA2_DEVICE 后重启" });
    return;
  }
  const { view, index } = req.body;
  if (view !== "camera" && view !== "camera2") {
    res.status(400).json({ ok: false, error: "view 必须是 camera 或 camera2" });
    return;
  }
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ ok: false, error: "index 必须是正整数" });
    return;
  }
  if (view === "camera") {
    startCamera(index);
  } else {
    startCamera2(index);
  }
  res.json({ ok: true, view, index, active: view === "camera" ? activeCameraIndex : activeCameraIndex2 });
});

// MJPEG 流端点
app.get("/video/camera", (req, res) => {
  streamManager.handleStream("camera", req, res);
});

app.get("/video/camera2", (req, res) => {
  streamManager.handleStream("camera2", req, res);
});

app.get("/video/camera3", (req, res) => {
  streamManager.handleStream("camera3", req, res);
});

app.get("/video/camera4", (req, res) => {
  streamManager.handleStream("camera4", req, res);
});

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bridge_running: bridge ? bridge.isRunning() && !stopping : false,
    clients_connected: clients.size,
    has_observation: latestObservation !== null,
  });
});

// 未知 API 必须返回 JSON 404，不能落入 SPA fallback 后返回 index.html。
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: `API 不存在: ${req.method} ${req.originalUrl}` });
});

// serve 前端静态文件 (生产模式)。index.html 禁止缓存，避免浏览器一直加载旧的 bundle；
// 带内容哈希的 assets 才能长期缓存。
app.use(express.static(FRONTEND_DIST, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
    } else if (/assets[\\/].+-\w{8,}\.(?:js|css)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
}));

// SPA fallback (前端未构建时返回提示，不报 404)
app.use((req, res) => {
  const indexFile = path.join(FRONTEND_DIST, "index.html");
  if (require("fs").existsSync(indexFile)) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(indexFile);
  } else {
    res.json({
      status: "ok",
      message: "前端未构建，开发模式请访问 http://localhost:5173",
      api: ["/api/ports", "/api/start", "/api/stop", "/api/status", "/health", "/ws/control", "/ws/stream"],
    });
  }
});

// ===================== WebSocket =====================

controlWss.on("connection", async (ws, request) => {
  const session = await authSession(request);
  if (!session) {
    ws.close(1008, "Unauthorized");
    return;
  }
  const user = auditUserLabel(session.user);
  const ip = requestClientIp(request);
  const connectedAt = Date.now();
  const motionAudit: MotionAudit = {
    active: false, startedAt: 0, lastActionAt: 0, timer: null,
    channel: "WebSocket", user, ip,
  };
  // One account owns one control console. Revoking the previous browser's
  // session prevents its automatic WebSocket reconnect from taking control
  // back after a second LAN computer signs in.
  const revokedSessions = robotAuth?.revokeOtherSessions(session.user.id, session.session.id) || 0;
  for (const [existing, userId] of controlClientUsers) {
    if (userId === session.user.id) existing.close(1008, "该账号已在另一台设备登录");
  }
  if (revokedSessions > 0) rtcGateway.disconnectAllPeers();
  console.log("[Server] 新控制客户端连接");
  persistAuditLog(`用户连接控制台；用户=${user}；角色=${session.user.role || "viewer"}；IP=${ip}；已撤销会话=${revokedSessions}`);
  clients.add(ws);
  controlClientUsers.set(ws, session.user.id);
  if (controlDisconnectTimer) {
    clearTimeout(controlDisconnectTimer);
    controlDisconnectTimer = null;
  }

  // 发送当前状态
  ws.send(JSON.stringify({ type: "status", running: bridge ? bridge.isRunning() && !stopping : false }));
  ws.send(JSON.stringify({ type: "recording_status", ...recordingStatus }));

  // 发送最新 observation
  if (latestObservation) {
    ws.send(JSON.stringify(latestObservation));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "action" && bridge?.isRunning() && activeControlSource === "web" && !stopping) {
        bridge.send(msg);
        recordMotion(motionAudit);
      } else if (msg.type === "ping") {
        // 用于前端估算浏览器与本机时钟偏差，从而修正跨进程时间戳算出的延迟显示。
        ws.send(JSON.stringify({ type: "pong", clientTs: msg.ts, serverTs: Date.now() }));
      }
    } catch (err) {
      console.error("[Server] 解析客户端消息失败:", err);
    }
  });

  ws.on("close", () => {
    console.log("[Server] 控制客户端断开");
    finishMotionAudit(motionAudit);
    persistAuditLog(`用户断开控制台；用户=${user}；IP=${ip}；在线=${Math.max(0, Math.round((Date.now() - connectedAt) / 1000))}秒`);
    clients.delete(ws);
    controlClientUsers.delete(ws);
    if (activeControlSource === "web" && clients.size === 0 && rtcGateway.peerCount() === 0 && !controlDisconnectTimer) {
      // 页面刷新和 Wi-Fi 瞬断会很快重连；给短暂宽限期，持续断开才安全停机。
      controlDisconnectTimer = setTimeout(() => {
        controlDisconnectTimer = null;
        if (activeControlSource === "web" && clients.size === 0 && rtcGateway.peerCount() === 0 && stopTeleop()) {
          console.warn("[Server] 远程 Leader 控制连接持续断开，已自动停止遥操作");
        }
      }, CONTROL_DISCONNECT_GRACE_MS);
      controlDisconnectTimer.unref();
    }
  });
});

streamWss.on("connection", (ws) => {
  console.log("[Server] 新推流客户端连接");
  const state: StreamClientState = { ws, pending: new Map() };
  streamClients.set(ws, state);
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as { type?: string; camera?: number };
      if (message.type === "frame_ack" && Number.isInteger(message.camera)) {
        const pending = state.pending.get(message.camera as number);
        if (!pending) return;
        if (pending.count <= 1) state.pending.delete(message.camera as number);
        else pending.count -= 1;
      }
    } catch {
      // Ignore non-control messages on the binary video socket.
    }
  });
  ws.on("close", () => streamClients.delete(ws));
});

function broadcastControl(msg: BridgeMessage | object): void {
  const data = JSON.stringify(msg);
  rtcGateway.broadcastControl(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// 二进制推流帧格式: [1 字节类型][8 字节 timestamp(float64, 秒)][JPEG 字节]。
// 避免 base64 + JSON 包装：既减少 ~33% 体积，也省去客户端 JSON.parse/base64 解码开销。
const STREAM_TYPE_CAMERA = 1;
const STREAM_TYPE_CAMERA2 = 2;

function broadcastBinaryFrame(streamType: number, ts: number, jpeg: Buffer): void {
  const header = Buffer.alloc(9);
  header.writeUInt8(streamType, 0);
  header.writeDoubleLE(ts, 1);
  const frame = Buffer.concat([header, jpeg]);
  rtcGateway.broadcastFrame(frame);
  const now = Date.now();
  for (const state of streamClients.values()) {
    const client = state.ws;
    if (client.readyState === WebSocket.OPEN) {
      // 每路最多保留一个未确认帧。慢客户端降低帧率，但不会播放旧画面。
      const pending = state.pending.get(streamType);
      if (pending && now - pending.lastSentAt >= 2000) state.pending.delete(streamType);
      else if (pending && pending.count >= 1) continue;
      if (client.bufferedAmount > 32 * 1024) continue;
      if (pending) {
        pending.count += 1;
        pending.lastSentAt = now;
      } else {
        state.pending.set(streamType, { count: 1, lastSentAt: now });
      }
      try {
        client.send(frame, { binary: true, compress: false });
      } catch {
        const failed = state.pending.get(streamType);
        if (failed && failed.count <= 1) state.pending.delete(streamType);
        else if (failed) failed.count -= 1;
      }
    }
  }
}

// ===================== 启动 =====================

void initializeRobotAuth(DATASET_ROOT, PORT).then((auth) => {
  robotAuth = auth;
  server.listen(PORT, "0.0.0.0", () => {
    const scheme = USE_HTTPS ? "https" : "http";
    const websocketScheme = USE_HTTPS ? "wss" : "ws";
    console.log(`[Robot Server] 监听在 ${scheme}://0.0.0.0:${PORT}`);
    console.log(`[Robot Server] 控制 WebSocket: ${websocketScheme}://0.0.0.0:${PORT}/ws/control`);
    console.log(`[Robot Server] 推流 WebSocket: ${websocketScheme}://0.0.0.0:${PORT}/ws/stream`);
    console.log(`[Robot Server] 摄像头1: ${scheme}://0.0.0.0:${PORT}/video/camera`);
    console.log(`[Robot Server] 摄像头2: ${scheme}://0.0.0.0:${PORT}/video/camera2`);
    console.log(`[Robot Server] API: /api/ports /api/start /api/stop /api/status`);
    startTelemetryBridge();
  });
}).catch((error) => {
  console.error("[Auth] 初始化失败，服务未启动:", error);
  process.exitCode = 1;
});

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[Robot Server] 退出中...");
  if (bridge) bridge.stop();
  if (telemetryBridge) telemetryBridge.stop();
  void rtcGateway.close();
  if (cameraBridge) cameraBridge.stop();
  if (cameraBridge2) cameraBridge2.stop();
  if (recorder) recorder.stop();
  for (const child of trainingProcesses.values()) child.kill("SIGTERM");
  for (const child of evaluationProcesses.values()) child.kill("SIGTERM");
  for (const child of uploadProcesses.values()) child.kill("SIGTERM");
  if (controlDisconnectTimer) clearTimeout(controlDisconnectTimer);
  for (const client of clients) client.close();
  controlClientUsers.clear();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
