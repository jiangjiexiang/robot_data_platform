<template>
  <main v-if="!authReady" class="auth-loading">正在验证登录状态</main>
  <AuthGate v-else-if="!authenticated" @authenticated="handleAuthenticated" />
  <div v-else class="app-shell">
    <div v-if="selfCheckVisible && workspace === 'control'" class="self-check-overlay" role="dialog" aria-modal="true" aria-labelledby="self-check-title">
      <div class="self-check-modal">
        <div class="self-check-heading">
          <div><h2 id="self-check-title">启动自检</h2></div>
          <span :class="['self-check-state', selfCheckRunning ? 'checking' : selfCheckPassed ? 'ok' : 'warn']">{{ selfCheckRunning ? "检查中" : selfCheckPassed ? "全部正常" : "需要检查" }}</span>
        </div>
        <div v-if="selfCheckRunning" class="self-check-loading">
          <span class="spinner"></span>
          <div><strong>正在执行启动自检</strong><small>检查服务器、从臂串口、标定文件和摄像头画面</small></div>
          <span class="loading-dots"><i></i><i></i><i></i></span>
        </div>
        <div v-else-if="selfCheck?.server?.ok" class="self-check-results">
          <p :class="selfCheck?.server?.ok ? 'ok' : 'bad'">{{ selfCheck?.server?.ok ? '✓ 机器人服务正常' : '✕ 机器人服务无响应' }}</p>
          <p :class="selfCheck?.follower?.portPresent ? 'ok' : 'bad'">{{ selfCheck?.follower?.portPresent ? `✓ 检测到机械臂串口 (${selfCheck.follower.ports.join(', ')})` : '✕ 未检测到 ttyACM / ttyUSB 串口' }}</p>
          <p :class="selfCheck?.follower?.calibrationValid ? 'ok' : 'warn'">{{ selfCheck?.follower?.calibrationValid ? `✓ 从臂标定有效 (${selfCheck.follower.id})` : `! 从臂标定缺失或无效 (${selfCheck?.follower?.id || '-'})` }}</p>
          <p v-for="(camera, index) in selfCheck?.cameras || []" :key="index" :class="camera.frameFresh ? 'ok' : 'bad'">{{ camera.frameFresh ? `✓ 摄像头 ${index + 1} 正常 (/dev/video${camera.index})` : `✕ 摄像头 ${index + 1} 无画面${camera.index >= 0 ? ` (/dev/video${camera.index})` : ''}` }}</p>
        </div>
        <div v-else class="self-check-results"><p class="bad">✕ 机器人服务自检接口无响应</p><p class="self-check-error">{{ selfCheck?.server?.error || '请重启服务后重试' }}</p></div>
        <p class="self-check-note">机械臂检查仅确认串口与标定，不会上扭矩或移动关节。</p>
        <div class="self-check-actions"><button class="secondary" :disabled="selfCheckRunning" @click="runSelfCheck()">重新检查</button><button class="primary" :disabled="selfCheckRunning" @click="selfCheckVisible = false">进入控制台</button></div>
      </div>
    </div>
    <div v-if="modalError" class="fatal-overlay" role="alertdialog" aria-modal="true" aria-labelledby="fatal-title">
      <div class="fatal-modal">
        <div class="fatal-heading"><span class="fatal-icon">✕</span><h2 id="fatal-title">出现异常</h2></div>
        <p class="fatal-message">{{ modalError }}</p>
        <p class="fatal-hint">请检查串口连接、电机供电或标定配置，修复后可重新启动遥操作。</p>
        <div class="fatal-actions"><button class="primary" @click="modalError = null">知道了</button></div>
      </div>
    </div>
    <div class="app-layout">
      <header class="topbar">
        <nav class="workspace-tabs" aria-label="工作区">
          <el-menu mode="horizontal" :default-active="workspace" :ellipsis="false" @select="selectWorkspace">
            <el-menu-item index="control"><el-icon><DataLine /></el-icon>概览</el-menu-item>
            <el-menu-item index="motors"><el-icon><Operation /></el-icon>机械臂</el-menu-item>
            <el-menu-item index="datasets"><el-icon><Files /></el-icon>数据</el-menu-item>
            <el-menu-item index="upload"><el-icon><Upload /></el-icon>上传训练主机</el-menu-item>
            <el-menu-item index="clip"><el-icon><Scissor /></el-icon>裁剪数据</el-menu-item>
          </el-menu>
        </nav>
        <div class="topbar-status"><StatusBar v-if="workspace === 'control'" :connected="connected" :running="running" :metrics="metrics" /></div>
        <div class="account-actions"><el-button class="emergency-header" :disabled="emergencyReleasePending || emergencyReleased" title="立即停止遥操作并释放机械臂电机扭矩" @click="handleEmergencyRelease"><el-icon><WarningFilled /></el-icon><span>{{ emergencyReleasePending ? "正在释放力..." : emergencyReleased ? "已释放力" : "紧急停止并释放力" }}</span></el-button><el-button class="account-avatar" circle text :title="`${authUser?.name || authUser?.email || '用户'}，点击退出`" aria-label="退出登录" @click="handleLogout"><el-icon><User /></el-icon></el-button></div>
      </header>

      <main v-if="workspace === 'control'" class="main">
        <section class="page-title" aria-label="页面标题">
          <p>实时控制中心</p>
          <h1>概览</h1>
        </section>
        <section class="live-workspace" aria-label="实时可视化">
          <div class="panel live-panel">
            <div class="workspace-heading"><div><p>实时可视化</p><h1>多相机采集视图</h1></div><div class="camera-summary"><span class="camera-count">2 路摄像头</span><el-tag size="small" effect="plain" type="info">平均延迟 {{ averageCameraLatency === null ? "--" : `${averageCameraLatency} 毫秒` }}</el-tag></div></div>
            <div class="camera-grid">
              <section class="camera-view" aria-label="RGB 摄像头 1 画面"><CameraView :stream="cameraViewsSwapped ? camera2Stream : cameraStream" :frame="cameraViewsSwapped ? camera2Frame : cameraFrame" :fallback-src="cameraViewsSwapped ? '/video/camera2' : '/video/camera'" :latency-ms="cameraViewsSwapped ? metrics.camera2Latency : metrics.cameraLatency" kicker="RGB CAM 1" title="实时画面" placeholder="等待摄像头 1 画面…" :hint="`/dev/video${cameraViewsSwapped ? activeCameras.camera2 : activeCameras.camera}`" liveText="实时" waitText="等待" /></section>
              <section class="camera-view" aria-label="RGB 摄像头 2 画面"><CameraView :stream="cameraViewsSwapped ? cameraStream : camera2Stream" :frame="cameraViewsSwapped ? cameraFrame : camera2Frame" :fallback-src="cameraViewsSwapped ? '/video/camera' : '/video/camera2'" :latency-ms="cameraViewsSwapped ? metrics.cameraLatency : metrics.camera2Latency" kicker="RGB CAM 2" title="实时画面" placeholder="等待摄像头 2 画面…" :hint="`/dev/video${cameraViewsSwapped ? activeCameras.camera : activeCameras.camera2}`" liveText="实时" waitText="等待" /></section>
            </div>
          </div>
          <section class="panel joint-state-card" aria-label="Joint State">
            <div class="joint-card-heading"><h2>Follower Joint State</h2><span>{{ followerEntries.length ? "实时" : "等待数据" }}</span></div>
            <div v-if="followerEntries.length" class="joint-bars"><div v-for="([name, value], index) in followerEntries" :key="name"><header><span>{{ name }}</span><strong>{{ Number(value).toFixed(2) }} / {{ followerPercent(name, Number(value)) }}%</strong></header><i><b :style="{ width: `${followerPercent(name, Number(value))}%`, backgroundColor: jointColors[index % jointColors.length] }"></b></i></div></div>
            <div v-else class="joint-empty">连接机械臂后显示实时关节状态</div>
          </section>
          <section v-if="serialConnected" class="panel joint-state-card" aria-label="Leader Joint State">
            <div class="joint-card-heading"><h2>Leader Joint State</h2><span>{{ leaderSerialEntries.length ? "实时" : "采样中" }}</span></div>
            <div v-if="leaderSerialEntries.length" class="joint-bars"><div v-for="([name, value], index) in leaderSerialEntries" :key="name"><header><span>{{ name }}</span><strong>{{ Number(value).toFixed(2) }} / {{ leaderPercent(name, Number(value)) }}%</strong></header><i><b :style="{ width: `${leaderPercent(name, Number(value))}%`, backgroundColor: jointColors[index % jointColors.length] }"></b></i></div></div>
            <div v-else class="joint-empty">正在读取 Leader 串口</div>
          </section>
        </section>
        <aside class="right-rail" aria-label="采集控制">
          <section class="panel recorder" aria-label="数据录制"><RecordingPanel :recording="recording" :running="running" :busy="recordingPending" @start="handleRecordingStart" @stop="handleRecordingStop" @cancel="handleRecordingCancel" /></section>
          <section class="panel ctrl" aria-label="机械臂连接"><ControlPanel :ports="ports" :detected-cameras="detectedCameras" :active-cameras="activeCameras" :camera-switchable="cameraSwitchable" :running="running" :busy="actionPending" :serial-connected="serialConnected" :serial-error="serialError" :control-latency="metrics.controlLatency" @refresh="fetchPorts" @start="handleStart" @stop="handleStop" @switch-camera="handleSwitchCamera" @swap-camera-views="handleSwapCameraViews" @connect-leader="handleConnectLeader" @disconnect-leader="disconnectLeader" /></section>
        </aside>
      </main>
      <div v-else-if="workspace === 'motors'" class="route-view">
      <MotorControlWorkspace
        :running="running"
        :busy="actionPending"
        :control-latency="metrics.controlLatency"
        :rtc-status="metrics.rtcStatus"
        :camera-latency="metrics.cameraLatency"
        :camera2-latency="metrics.camera2Latency"
        :camera3-latency="metrics.camera3Latency"
        :camera4-latency="metrics.camera4Latency"
        :camera-fps="metrics.cameraFps"
        :camera-dropped="metrics.cameraDropped"
        :camera2-fps="metrics.camera2Fps"
        :camera2-dropped="metrics.camera2Dropped"
        :releasing="emergencyReleasePending"
        :released="emergencyReleased"
        :control-enabled="running && !serialConnected"
        :follower="followerJoints"
        :send="sendMotorAction"
        :camera-stream="cameraStream"
        :camera2-stream="camera2Stream"
        :camera3-stream="camera3Stream"
        :camera4-stream="camera4Stream"
        :camera-frame="cameraFrame"
        :camera2-frame="camera2Frame"
        :camera3-frame="camera3Frame"
        :camera4-frame="camera4Frame"
        @start="handleMotorStart"
        @stop="handleStop"
        @release="handleEmergencyRelease"
      />
      </div>
      <div v-else-if="workspace === 'datasets'" class="route-view">
        <DatasetWorkspace />
      </div>
      <UploadWorkspace v-else-if="workspace === 'upload'" />
      <ClipWorkspace v-else-if="workspace === 'clip'" :joints="followerJoints" />
      <LogWorkspace v-else-if="workspace === 'logs'" :logs="logs" @clear="clearLogs" />
      <UserManagementWorkspace v-else :current-user="authUser" />
      <footer class="dcp-footer">数据采集平台</footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { useWebSocket } from "./composables/useWebSocket";
import StatusBar from "./components/StatusBar.vue";
import ControlPanel from "./components/ControlPanel.vue";
import CameraView from "./components/CameraView.vue";
import RecordingPanel from "./components/RecordingPanel.vue";
import DatasetWorkspace from "./components/DatasetWorkspace.vue";
import LogWorkspace from "./components/LogWorkspace.vue";
import MotorControlWorkspace from "./components/MotorControlWorkspace.vue";
import AuthGate from "./components/AuthGate.vue";
import UserManagementWorkspace from "./components/UserManagementWorkspace.vue";
import UploadWorkspace from "./components/UploadWorkspace.vue";
import ClipWorkspace from "./components/ClipWorkspace.vue";
import { useLeaderSerial } from "./composables/useLeaderSerial";
import { DataLine, Files, Operation, Scissor, Upload, User, WarningFilled } from "@element-plus/icons-vue";

const authReady = ref(false);
const authenticated = ref(false);
type AuthenticatedUser = { id?: string; name?: string; email?: string; role?: "viewer" | "operator" | "admin" };
const authUser = ref<AuthenticatedUser | null>(null);

const {
  connected,
  running,
  leaderJoints,
  followerJoints,
  cameraFrame,
  camera2Frame,
  camera3Frame,
  camera4Frame,
  cameraStream,
  camera2Stream,
  camera3Stream,
  camera4Stream,
  logs,
  fatalError,
  recording,
  metrics,
  log,
  clearLogs,
  send,
} = useWebSocket();
const averageCameraLatency = computed(() => metrics.value.averageCameraLatency);
const followerEntries = computed(() => Object.entries(followerJoints.value || {}).slice(0, 7));
const jointColors = ["#34c759", "#007aff", "#ff9500", "#5856d6", "#af52de", "#ff3b30", "#5ac8fa"];
type FollowerRange = { min: number; max: number };
const followerRanges = ref<Record<string, FollowerRange>>({
  shoulder_pan: { min: -112.17, max: 112.17 },
  shoulder_lift: { min: -103.82, max: 103.82 },
  elbow_flex: { min: -96.62, max: 96.62 },
  wrist_flex: { min: -102.46, max: 102.46 },
  wrist_roll: { min: -164.57, max: 164.57 },
  gripper: { min: 0, max: 100 },
});
function followerPercent(name: string, value: number): number {
  const range = followerRanges.value[name];
  if (!range || !Number.isFinite(value) || range.max <= range.min) return 0;
  return Math.round(Math.max(0, Math.min(100, (value - range.min) / (range.max - range.min) * 100)));
}
function leaderPercent(name: string, value: number): number {
  if (!Number.isFinite(value)) return 0;
  const percent = name === "gripper" ? value : (value + 100) / 2;
  return Math.round(Math.max(0, Math.min(100, percent)));
}
async function loadFollowerRanges(): Promise<void> {
  try {
    const response = await fetch("/api/calibration/follower");
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    const next = { ...followerRanges.value };
    for (const [name, range] of Object.entries(next)) {
      if (name === "gripper") continue;
      const calibration = data.calibration?.[name];
      if (!Number.isFinite(calibration?.range_min) || !Number.isFinite(calibration?.range_max)) continue;
      const halfRange = (calibration.range_max - calibration.range_min) * 180 / 4095;
      range.min = Math.max(range.min, -halfRange);
      range.max = Math.min(range.max, halfRange);
    }
    followerRanges.value = next;
  } catch { /* Fall back to the fixed mechanical ranges. */ }
}
const { connected: serialConnected, error: serialError, joints: leaderSerialJoints, connect: connectLeader, disconnect: disconnectLeader } = useLeaderSerial(send, log, stopAfterLeaderFailure);
const leaderSerialEntries = computed(() => Object.entries(leaderSerialJoints.value || {}).slice(0, 7));
const modalError = computed({
  get: () => fatalError.value || frontError.value,
  set: (value) => { fatalError.value = value; frontError.value = value; },
});
const frontError = ref<string | null>(null);
type Workspace = "control" | "motors" | "datasets" | "upload" | "clip" | "logs" | "users";
const initialWorkspace: Workspace = location.hash === "#datasets" || location.hash.startsWith("#datasets/")
  ? "datasets"
  : location.hash === "#motors"
    ? "motors"
  : location.hash === "#upload"
      ? "upload"
      : location.hash === "#clip"
        ? "clip"
    : location.hash === "#logs"
      ? "logs"
      : location.hash === "#users"
        ? "users"
      : "control";
const workspace = ref<Workspace>(initialWorkspace);
function selectWorkspace(value: string): void {
  if (["control", "motors", "datasets", "upload", "clip", "logs", "users"].includes(value)) workspace.value = value as Workspace;
}
const pageContext = computed(() => ({
  control: { title: "遥操作控制台" },
  motors: { title: "电机手动控制" },
  datasets: { title: "数据管理平台" },
  upload: { title: "上传训练主机" },
  clip: { title: "裁剪数据" },
  logs: { title: "日志管理" },
  users: { title: "账号管理" },
})[workspace.value]);

const ports = ref<string[]>([]);
const cameras = ref<{ index: number; path: string }[]>([]);
const detectedCameras = ref<number[]>([]);
const cameraSwitchable = ref(false);
const activeCameras = ref<{ camera: number; camera2: number; camera3: number; camera4: number }>({ camera: -1, camera2: -1, camera3: -1, camera4: -1 });
const actionPending = ref(false);
const emergencyReleasePending = ref(false);
const emergencyReleased = ref(false);
const recordingPending = ref(false);
const cameraViewsSwapped = ref(false);
const selfCheckRunning = ref(false);
const selfCheck = ref<Record<string, any> | null>(null);
const selfCheckVisible = ref(false);
const selfCheckPassed = computed(() => Boolean(selfCheck.value?.server?.ok
  && selfCheck.value?.follower?.portPresent
  && selfCheck.value?.follower?.calibrationValid
  && selfCheck.value?.cameras?.length >= 2
  && selfCheck.value.cameras.every((camera: Record<string, any>) => camera.frameFresh)));

async function refreshSession(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    const data = (await response.json().catch(() => ({}))) || {};
    authenticated.value = response.ok && Boolean(data.user);
    authUser.value = authenticated.value ? data.user : null;
    return authenticated.value;
  } catch {
    authenticated.value = false;
    authUser.value = null;
    return false;
  } finally {
    authReady.value = true;
  }
}

async function loadWorkspace() {
  await fetchPorts();
  await loadFollowerRanges();
  await runSelfCheck({ showModal: false });
}

async function handleAuthenticated() {
  if (await refreshSession()) await loadWorkspace();
}

async function handleLogout() {
  try {
    await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" });
  } finally {
    authenticated.value = false;
    authUser.value = null;
    selfCheckVisible.value = false;
  }
}

async function runSelfCheck(config?: { followerId?: string; showModal?: boolean }) {
  if (selfCheckRunning.value) return;
  if (config?.showModal !== false) selfCheckVisible.value = true;
  selfCheckRunning.value = true;
  const minimumAnimation = new Promise<void>((resolve) => window.setTimeout(resolve, 350));
  try {
    const params = new URLSearchParams({
      follower_id: config?.followerId || "R12253102",
    });
    const res = await fetch(`/api/self-check?${params}`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("自检接口返回了网页内容；请重启服务以加载新版机器人服务");
    }
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `请求失败，状态码 ${res.status}`);
    await minimumAnimation;
    selfCheck.value = result;
    log("启动自检完成");
  } catch (cause) {
    await minimumAnimation;
    selfCheck.value = { server: { ok: false, error: String(cause) } };
    selfCheckVisible.value = true;
    log(`启动自检失败: ${cause}`);
  } finally {
    selfCheckRunning.value = false;
  }
}

async function stopAfterLeaderFailure() {
  if (serialError.value) frontError.value = `主臂串口断开: ${serialError.value}`;
  if (!running.value) return;
  log("主臂已断开，正在安全停止后端遥操作...");
  try {
    const res = await fetch("/api/stop", { method: "POST" });
    const data = await res.json();
    if (data.ok || data.error === "未在运行") log("后端遥操作已安全停止");
    else log(`后端停止失败: ${data.error}`);
  } catch (cause) {
    log(`后端停止请求失败: ${cause}`);
  }
}

async function fetchPorts() {
  try {
    const res = await fetch("/api/ports");
    const data = await res.json();
    ports.value = data.ports || [];
    log(`检测到 ${ports.value.length} 个串口`);
    const cameraRes = await fetch("/api/cameras");
    const cd = await cameraRes.json();
    cameras.value = cd.cameras || [];
    detectedCameras.value = cd.detected || [];
    cameraSwitchable.value = cd.switchable !== false;
    if (cd.active) activeCameras.value = cd.active;
  } catch (e) {
    log("加载串口失败: " + e);
  }
}

async function handleSwitchCamera(config: { view: string; index: number }) {
  try {
    const backendView = cameraViewsSwapped.value
      ? (config.view === "camera" ? "camera2" : "camera")
      : config.view;
    const res = await fetch("/api/camera/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, view: backendView }),
    });
    const data = await res.json();
    if (data.ok) {
      const key = backendView === "camera" ? "camera" : "camera2";
      activeCameras.value[key] = config.index;
      log(`已切换 ${config.view === "camera" ? "摄像头 1" : "摄像头 2"} 到 /dev/video${config.index}`);
    } else {
      log(`切换摄像头失败: ${data.error}`);
    }
  } catch (e) {
    log(`切换摄像头请求失败: ${e}`);
  }
}

function handleSwapCameraViews() {
  cameraViewsSwapped.value = !cameraViewsSwapped.value;
  log("已交换左右摄像头画面");
}

async function recordingRequest(endpoint: "start" | "stop" | "cancel", body?: object) {
  if (recordingPending.value) return;
  recordingPending.value = true;
  try {
    const res = await fetch(`/api/recording/${endpoint}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `请求失败，状态码 ${res.status}`);
    log(endpoint === "start" ? "数据集录制已启动" : endpoint === "stop" ? "正在编码并保存当前数据" : "正在丢弃本次录制");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(`录制操作失败: ${message}`);
    frontError.value = `录制操作失败: ${message}`;
  } finally {
    recordingPending.value = false;
  }
}

function handleRecordingStart(config: { dataset: string; task: string; episodeTime: number }) { void recordingRequest("start", config); }
function handleRecordingStop() { void recordingRequest("stop"); }
function handleRecordingCancel() { void recordingRequest("cancel"); }

function handleMotorStart() {
  void handleStart({
    followerPort: "/dev/ttyACM0",
    followerId: "R12253102",
    remoteLeader: true,
    fps: 60,
    cameraIndex: activeCameras.value.camera,
  });
}

function sendMotorAction(message: object) {
  // Slider commands share the same action channel as Web Serial teleoperation.
  // Keep this mode separate from COM control: App disables the sliders while
  // the browser Leader serial connection is active.
  send({ ...message, type: "action" });
}

async function handleStart(config: Record<string, unknown>) {
  if (actionPending.value || running.value) return;
  // 前端 camelCase -> 后端 snake_case
  const payload = {
    follower_port: config.followerPort,
    follower_id: config.followerId,
    leader_port: config.leaderPort,
    leader_id: config.leaderId,
    fps: config.fps,
    remote_leader: config.remoteLeader,
    // 机器人本地 USB 摄像头：/dev/video0 对应 OpenCV 索引 0。
    // 摄像头由 robot-server 的独立 camera_stream 进程采集，避免和遥操作进程抢占设备。
    camera_index: config.cameraIndex,
  };
  actionPending.value = true;
  log("正在启动遥操作...");
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      log("遥操作已启动");
    } else {
      log("启动失败: " + data.error);
    }
  } catch (e) {
    log("请求失败: " + e);
  } finally {
    actionPending.value = false;
  }
}

async function handleConnectLeader(config: { leaderId: string; fps: number }) {
  try { await connectLeader(config.leaderId, config.fps); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("连接主臂失败: " + message);
    frontError.value = `连接主臂失败: ${message}`;
  }
}

async function handleStop() {
  if (actionPending.value || !running.value) return;
  actionPending.value = true;
  log("正在停止遥操作...");
  try {
    const res = await fetch("/api/stop", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      await disconnectLeader();
      log("已停止，并断开主臂串口");
    }
    else log("停止失败: " + data.error);
  } catch (e) {
    log("停止失败: " + e);
  } finally {
    actionPending.value = false;
  }
}

async function handleEmergencyRelease() {
  if (emergencyReleasePending.value) return;
  emergencyReleasePending.value = true;
  log("正在紧急停止并关闭电机扭矩...");
  try {
    const res = await fetch("/api/emergency-release", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `请求失败，状态码 ${res.status}`);
    await disconnectLeader();
    emergencyReleased.value = true;
    log("紧急停止完成：电机已释力");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(`电机释力失败: ${message}`);
    frontError.value = `紧急停止失败：${message}`;
  } finally {
    emergencyReleasePending.value = false;
  }
}

watch(running, async (isRunning, wasRunning) => {
  if (isRunning) emergencyReleased.value = false;
  if (wasRunning && !isRunning && serialConnected.value) {
    await disconnectLeader();
    log("后端遥操作已停止，主臂串口已自动断开");
  }
});

watch(workspace, (value) => {
  history.replaceState(null, "", value === "control" ? location.pathname + location.search : `#${value}`);
});

onMounted(async () => {
  if (await refreshSession()) await loadWorkspace();
});
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #050505;
  color: #f4f4f5;
  min-height: 100vh;
}
.app-shell {
  min-height: 100vh;
  background:
    radial-gradient(circle at 72% -10%, rgba(124, 92, 255, 0.10), transparent 32rem),
    radial-gradient(circle at 0% 100%, rgba(255, 255, 255, 0.035), transparent 32rem),
    #050505;
}
.auth-loading { min-height: 100vh; display: grid; place-items: center; background: #eef1f1; color: #555a5d; font-size: 14px; }
.self-check-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgba(2, 8, 16, .82); backdrop-filter: blur(8px); }
.self-check-modal { width: min(480px, 100%); padding: 24px; border: 1px solid rgba(119, 188, 225, .25); border-radius: 18px; background: #0d1c2e; box-shadow: 0 24px 80px rgba(0, 0, 0, .5); }
.self-check-heading { display: flex; align-items: center; justify-content: space-between; gap: 15px; margin-bottom: 20px; }
.self-check-heading h2 { margin-top: 3px; font-size: 22px; }
.self-check-state { padding: 5px 9px; border-radius: 99px; font: 10px ui-monospace, monospace; background: #172b40; }
.self-check-state.ok, .self-check-results .ok { color: #69d7a3; }
.self-check-state.warn, .self-check-results .warn { color: #f3c969; }
.self-check-state.checking { color: #76cdec; }
.self-check-results { display: grid; gap: 9px; padding: 15px; border-radius: 10px; background: rgba(4, 12, 22, .55); }
.self-check-results p { font-size: 13px; }
.self-check-results .bad { color: #ff9aaa; }
.self-check-results .self-check-error { color: #718da3; font: 10px/1.4 ui-monospace, monospace; word-break: break-word; }
.self-check-loading { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 13px; min-height: 150px; padding: 20px; color: #92aec4; font-size: 13px; }
.self-check-loading strong { display: block; color: #c7ddeb; font-size: 14px; }
.self-check-loading small { display: block; margin-top: 5px; color: #6f8da3; font-size: 10px; line-height: 1.4; }
.spinner { width: 28px; height: 28px; border: 3px solid #29465f; border-top-color: #72d2f2; border-radius: 50%; animation: self-check-spin .8s linear infinite; box-shadow: 0 0 14px rgba(114, 210, 242, .16); }
.loading-dots { display: flex; align-items: center; gap: 4px; }
.loading-dots i { width: 5px; height: 5px; border-radius: 50%; background: #72d2f2; animation: self-check-pulse 1s ease-in-out infinite; }
.loading-dots i:nth-child(2) { animation-delay: .15s; }
.loading-dots i:nth-child(3) { animation-delay: .3s; }
.self-check-note { margin-top: 13px; color: #718da3; font-size: 10px; }
.self-check-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 20px; }
.self-check-actions button { padding: 9px 14px; border: 0; border-radius: 8px; cursor: pointer; font-weight: 600; }
.self-check-actions button:disabled { opacity: .45; cursor: default; }
.self-check-actions .secondary { color: #91bad2; background: #142b40; }
.self-check-actions .primary { color: #06101a; background: #64d6f4; }
@keyframes self-check-spin { to { transform: rotate(360deg); } }
@keyframes self-check-pulse { 0%, 100% { opacity: .25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-3px); } }
.fatal-overlay { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center; padding: 20px; background: rgba(2, 8, 16, .82); backdrop-filter: blur(8px); }
.fatal-modal { width: min(480px, 100%); padding: 24px; border: 1px solid rgba(255, 122, 143, .35); border-radius: 18px; background: #1c0f14; box-shadow: 0 24px 80px rgba(0, 0, 0, .5); }
.fatal-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.fatal-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 122, 143, .18); color: #ff9aaa; font-weight: 800; }
.fatal-heading h2 { font-size: 20px; }
.fatal-message { padding: 12px 14px; border-radius: 10px; background: rgba(0, 0, 0, .3); color: #ffb8c4; font: 12px/1.5 ui-monospace, monospace; word-break: break-word; }
.fatal-hint { margin-top: 12px; color: #a48b90; font-size: 12px; }
.fatal-actions { display: flex; justify-content: flex-end; margin-top: 20px; }
.fatal-actions button { padding: 9px 16px; border: 0; border-radius: 8px; cursor: pointer; font-weight: 600; }
.fatal-actions .primary { color: #06101a; background: #64d6f4; }
/* Capture workspace: dense, light operational surface modelled around the live feed. */
body { background: #f7f8f8; color: #242629; }
.app-shell { background: #f7f8f8; }
.app-layout { display: block; min-height: 100vh; }
.topbar { height: 68px; display: flex; align-items: center; gap: 28px; padding: 0 34px; color: #e9e9e9; background: #0d0e10; border-bottom: 1px solid #242528; }
.workspace-tabs { display:flex; flex-direction:row; align-items:center; gap:2px; background:transparent; border:0; }
.workspace-tabs button { position:relative; display:inline-flex; align-items:center; gap:6px; width:auto; min-height:38px; padding:8px 11px; border:0; border-radius:0; color:#85878b; background:transparent; font-size:13px; font-weight:550; }
.workspace-tabs button span { color:#76797d; font-size:15px; line-height:1; }
.workspace-tabs button:hover { background:#151618; color:#cfd0d2; }.workspace-tabs button:hover span { color:#cfd0d2; }
.workspace-tabs button.active { background:#0d0e10 !important; box-shadow:none; color:#e4e5e6 !important; font-weight:650; }.workspace-tabs button.active span { color:#e4e5e6; }.workspace-tabs button.active::after { content:""; position:absolute; right:11px; bottom:5px; left:11px; height:1px; background:#b9bbbe; }
.topbar-status { min-width: 0; margin-left: auto; }
.account-actions { display: flex; align-items: center; gap: 8px; color: #a6a9ac; font-size: 12px; white-space: nowrap; }
.account-actions button { min-height: 30px; padding: 0 9px; border: 1px solid #44474a; border-radius: 4px; background: transparent; color: #e4e5e6; cursor: pointer; font-size: 12px; }
.account-actions button:hover { border-color: #74787b; background: #1b1d1f; }
.account-actions .emergency-header { min-height: 32px; border-color: #a83b3f; background: #3a1719; color: #ffb5b8; font-weight: 700; }
.account-actions .emergency-header:hover:not(:disabled) { border-color: #e94b50; background: #5a1d20; color: #fff; }
.account-actions .emergency-header:disabled { opacity: .55; cursor: not-allowed; }
.topbar-status .status-bar { gap: 9px; }
.topbar-status .metrics { display: none; }
.topbar-status .status-text { color: #c7c9cc; font-size: 12px; }
.workspace-tabs { flex: 0 0 auto; }.workspace-tabs .el-menu { --el-menu-bg-color: transparent; --el-menu-text-color: #85878b; --el-menu-hover-text-color: #f0f1f2; --el-menu-hover-bg-color: #17191b; --el-menu-active-color: #fff; --el-menu-border-color: transparent; height: 68px; border-bottom: 0; background: transparent; }.workspace-tabs .el-menu-item { height: 68px; gap: 6px; padding: 0 13px; border-bottom: 2px solid transparent; font-size: 13px; }.workspace-tabs .el-menu-item:hover { background:#17191b; }.workspace-tabs .el-menu-item.is-active { border-bottom-color:#fff; background:transparent; }.workspace-tabs .el-icon { margin-right: 2px; color: currentColor; font-size: 16px; }.account-actions .el-button { --el-button-text-color:#e4e5e6; --el-button-hover-text-color:#fff; --el-button-hover-bg-color:#1b1d1f; --el-button-hover-border-color:#74787b; }
.main { max-width: 1760px; margin: 0 auto; padding: 30px 40px; display: grid; grid-template-columns: minmax(0, 1fr) 410px; grid-template-areas: "live recorder"; gap: 20px; align-items: start; }
.live-workspace { grid-area: live; display: grid; gap: 18px; min-width: 0; container-type: inline-size; }
.right-rail { grid-area: recorder; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.panel { padding: 0; border: 1px solid #dedfe0; border-radius: 7px; background: #fff; box-shadow: 0 1px 3px rgba(22, 27, 29, .04); }
.live-panel { overflow: hidden; }
.workspace-heading { display: flex; align-items: center; justify-content: space-between; padding: 15px 18px; border-bottom: 1px solid #e6e7e8; }
.workspace-heading p { color: #303235; font-size: 14px; font-weight: 700; }
.workspace-heading h1 { margin-top: 3px; color: #929497; font-size: 11px; font-weight: 500; }
.camera-count { padding: 5px 9px; border: 1px solid #d5e4df; border-radius: 12px; color: #348369; background: #f8fcfa; font-size: 11px; }
.camera-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 14px; }
.camera-grid-four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.camera-view { min-width: 0; }
.ctrl, .joints { padding: 18px; }
.capture-details { display:grid; grid-template-columns:minmax(0, 1fr) minmax(230px, .55fr); gap:18px; align-items:start; }
.recorder { padding: 0; overflow: hidden; }
.self-check-overlay, .fatal-overlay { background: rgba(22, 25, 29, .52); }
.self-check-modal { border-color: #dedede; border-radius: 8px; background: #fff; box-shadow: 0 18px 55px rgba(0, 0, 0, .2); color: #282a2d; }
.self-check-results { background: #f7f8f8; }.self-check-note { color: #74777b; }.self-check-actions .secondary { color: #45494d; background: #e9eaeb; }.self-check-actions .primary { color: #fff; background: #e94b50; }
.spinner { border-color:#d8dadd; border-top-color:#5b83ca; box-shadow:none; }.loading-dots i { background:#5b83ca; }.self-check-state { background:#eef0f1; color:#62676b; }.self-check-state.checking { color:#3f73cb; }.self-check-state.ok,.self-check-results .ok { color:#35805d; }.self-check-state.warn,.self-check-results .warn { color:#956b1e; }.self-check-results .bad { color:#c23c43; }
.fatal-modal { border-radius: 8px; background: #fff; color: #282a2d; }.fatal-message { background: #fff3f4; color: #b63038; }.fatal-hint { color: #74777b; }.fatal-actions .primary { color: #fff; background: #e94b50; }
@media (max-width: 1180px) { .main { padding: 24px; grid-template-columns: minmax(0, 1fr) 350px; }.topbar { padding: 0 22px; gap: 15px; } }
@media (max-width: 880px) { .topbar { height: auto; min-height: 60px; flex-wrap: wrap; padding-block: 10px; }.topbar-status { display: none; }.main { grid-template-columns: 1fr; grid-template-areas: "live" "recorder"; }.right-rail { width: min(100%, 600px); } }
@media (max-width: 580px) { .topbar { gap: 9px; padding-inline: 12px; }.workspace-tabs { order: 3; width: 100%; overflow-x: auto; }.workspace-tabs button { padding: 7px 9px; font-size: 11px; }.main { padding: 12px; gap: 12px; }.camera-grid,.capture-details { grid-template-columns: 1fr; gap: 12px; padding: 12px; }.capture-details { padding:0; }.workspace-heading { padding: 13px; } }
/* Adaptive camera layout: keep cameras and recording panel visible at any resolution. */
.camera-view { display: flex; flex-direction: column; min-height: 0; }
.camera-view-root { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.camera-view .video-box { width: auto; max-width: 100%; min-height: 0; flex: 1; align-self: center; }
.camera-grid-four .camera-view { max-height: min(400px, calc((100vh - 330px) / 2)); }
.capture-details { grid-template-columns: minmax(0, 1fr) minmax(230px, 330px); }
@container (min-width: 1050px) { .camera-grid-four { grid-template-columns: repeat(4, minmax(0, 1fr)); } .camera-grid-four .camera-view { max-height: min(460px, calc(100vh - 380px)); } }
@container (max-width: 620px) { .camera-grid-four .camera-view { max-height: 320px; } }
@media (min-width: 881px) and (max-width: 1000px) { .main { display: flex; flex-direction: column; } .right-rail { width: 100%; } }
@media (max-height: 780px) and (min-width: 881px) { .main { padding-top: 18px; padding-bottom: 18px; gap: 14px; } .live-workspace { gap: 14px; } .camera-grid { gap: 10px; padding: 12px; } .camera-view .view-heading { margin-bottom: 6px; } .workspace-heading { padding: 13px 18px; } .ctrl, .joints { padding: 14px; } }

/* Main console: use available width for the live views without leaving an
   oversized gap beside the fixed operational controls. */
.main { max-width: 1920px; padding: 24px clamp(18px, 2.25vw, 40px) 32px; grid-template-columns: minmax(0, 1fr) minmax(344px, 390px); gap: 16px; }
.live-workspace { gap: 16px; }
.right-rail { position: sticky; top: 84px; }
.camera-grid { gap: 10px; padding: 12px; }
.capture-details { grid-template-columns: minmax(230px, 270px) minmax(0, 1fr); gap: 16px; }
.workspace-heading { min-height: 62px; padding: 13px 16px; }
.ctrl, .joints { padding: 16px; }

@media (min-width: 1400px) {
  .main { grid-template-columns: minmax(0, 1fr) 380px; }
  .camera-grid-four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .camera-grid-four .camera-view { max-height: min(430px, calc(100vh - 350px)); }
}

@media (min-width: 961px) and (max-width: 1180px) {
  .main { grid-template-columns: minmax(0, 1fr) 330px; padding-inline: 18px; gap: 14px; }
  .capture-details { grid-template-columns: 1fr; }
  .right-rail { top: 76px; }
}

@media (max-width: 960px) {
  .main { display: grid; grid-template-columns: 1fr; grid-template-areas: "live" "recorder"; padding: 16px; gap: 14px; }
  .right-rail { position: static; width: min(100%, 680px); }
  .capture-details { grid-template-columns: minmax(230px, .42fr) minmax(0, 1fr); }
}

@media (max-width: 680px) {
  .topbar { align-items: center; min-height: 56px; padding: 8px 12px; }
  .account-actions { margin-left: auto; font-size: 11px; }
  .account-actions > span { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
  .main { padding: 10px; gap: 10px; }
  .live-workspace { gap: 10px; }
  .workspace-heading { min-height: 54px; padding: 11px 12px; }
  .workspace-heading p { font-size: 13px; }
  .workspace-heading h1 { display: none; }
  .camera-count { padding: 4px 7px; font-size: 10px; }
  .camera-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 9px; }
  .camera-grid-four .camera-view { max-height: none; }
  .capture-details { grid-template-columns: 1fr; gap: 10px; }
  .right-rail { width: 100%; }
  .ctrl, .joints { padding: 14px; }
}

@media (max-width: 420px) {
  .workspace-tabs { gap: 0; }
  .workspace-tabs button { min-height: 34px; padding: 6px 8px; }
  .workspace-tabs button span { display: none; }
  .camera-grid { grid-template-columns: 1fr; }
  .camera-view .video-box { width: 100%; }
  .camera-count { display: none; }
}

/* Continuous camera wall: headings stay readable while video surfaces touch. */
.camera-grid-four { gap: 0; padding: 0; }
.camera-summary { display:flex; align-items:center; gap:6px; }
.camera-summary :deep(.el-tag) { border-radius:4px; font:10px ui-monospace,monospace; }
.camera-grid-four .camera-view { padding: 0; border-right: 1px solid #e5e7e8; }
.camera-grid-four .camera-view:last-child { border-right: 0; }
.camera-grid-four .view-heading { margin: 0; padding: 10px 12px 8px; }
.camera-grid-four .video-box { border: 0; border-radius: 0; }
@media (max-width: 960px) {
  .camera-grid-four .camera-view:nth-child(2n) { border-right: 0; }
  .camera-grid-four .camera-view:nth-child(-n+2) { border-bottom: 1px solid #e5e7e8; }
}
@media (max-width: 420px) {
  .camera-grid-four .camera-view { border-right: 0; border-bottom: 1px solid #e5e7e8; }
  .camera-grid-four .camera-view:last-child { border-bottom: 0; }
  .camera-summary :deep(.el-tag) { display:none; }
}

/* Reference platform shell: quiet Apple-like surfaces with a compact black chrome. */
.topbar { height: 52px; padding: 0 24px; background: #0a0a0a; border-bottom: 0; }
.workspace-tabs .el-menu, .workspace-tabs .el-menu-item { height: 52px; }
.workspace-tabs .el-menu-item { padding: 0 12px; border-bottom-width: 1px; font-size: 13px; }
.workspace-tabs .el-menu-item.is-active { border-bottom-color: #fff; }
.main { max-width: 1280px; padding: 32px 24px 40px; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); grid-template-areas: "title title" "live recorder"; gap: 24px; }
.page-title { grid-area: title; margin-bottom: 0; }
.page-title p { margin: 0 0 4px; color: #8e8e93; font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
.page-title h1 { margin: 0; color: #1d1d1f; font-size: 30px; line-height: 1.15; font-weight: 600; letter-spacing: 0; }
.live-workspace, .right-rail { gap: 24px; }
.panel { border-color: #e5e5ea; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.workspace-heading { padding: 16px 20px; border-bottom-color: #e5e5ea; }
.workspace-heading p { color: #1d1d1f; font-size: 18px; }
.workspace-heading h1 { color: #8e8e93; font-size: 11px; }
.camera-grid-four { gap: 12px; padding: 12px; }
.camera-grid-four .camera-view { border: 0; overflow: hidden; border-radius: 10px; background: #f2f2f7; }
.camera-grid-four .view-heading { padding: 10px 12px 8px; }
.camera-grid-four .video-box { border-radius: 0; }
.ctrl, .joints { padding: 20px; }
.joint-state-card { padding: 22px; }
.joint-card-heading { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
.joint-card-heading h2 { color:#1d1d1f; font-size:16px; }
.joint-card-heading span { padding:4px 8px; border-radius:999px; color:#258942; background:rgba(52,199,89,.12); font-size:10px; }
.joint-bars { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px 24px; }
.joint-bars header { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; color:#48484a; font-size:12px; }
.joint-bars strong { color:#1d1d1f; font-family:ui-monospace,monospace; font-size:11px; }
.joint-bars i { display:block; height:6px; overflow:hidden; border-radius:999px; background:#f2f2f7; }
.joint-bars b { display:block; height:100%; border-radius:inherit; }
.joint-empty { display:grid; place-items:center; min-height:180px; color:#8e8e93; font-size:13px; }

/* Overview follows pages/概览.html: two RGB feeds above one full-width depth feed. */
.camera-grid-three { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 12px; }
.camera-grid-three .camera-view { border: 0; overflow: hidden; border-radius: 10px; background: #f2f2f7; max-height: min(430px, calc(100vh - 350px)); }
.camera-grid-three .camera-view-depth { grid-column: 1 / -1; }
.camera-grid-three .view-heading { padding: 10px 12px 8px; }
.camera-grid-three .video-box { border-radius: 0; }
@media (max-width: 680px) {
  .camera-grid-three .camera-view { max-height: none; }
}
@media (max-width: 960px) { .main { grid-template-columns: 1fr; grid-template-areas: "title" "live" "recorder"; } }
@media (max-width: 680px) { .main { padding: 24px 14px 30px; gap: 16px; } .page-title h1 { font-size: 26px; } .topbar { padding-inline: 14px; } .joint-bars { grid-template-columns:1fr; } }
</style>
