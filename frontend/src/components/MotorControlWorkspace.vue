<template>
  <main class="arm-workspace" aria-label="机械臂控制">
      <section class="arm-card status-bar" aria-label="控制状态">
        <div class="status-items">
          <span :class="['connected-pill', { idle: !running }]"><i></i>{{ released ? "已释力" : running ? "已连接" : "未连接" }}</span>
          <label class="teleop-toggle"><input type="checkbox" :checked="running" :disabled="busy || releasing" @change="running ? emit('stop') : emit('start')" /><span></span>遥操作</label>
          <span><el-icon><VideoCamera /></el-icon>FPS: <b>{{ cameraFps }}</b></span>
          <span class="muted"><el-icon><WarningFilled /></el-icon>掉帧: <b>{{ droppedFrames }}</b></span>
        </div>
        <button v-if="released" class="restore-control" :disabled="busy || releasing" title="重新启用电机扭矩和位置控制器" @click="emit('start')"><el-icon><VideoPlay /></el-icon>{{ busy ? "正在恢复..." : "恢复控制" }}</button>
        <button v-else class="stop-control" :disabled="!running || busy" title="停止遥操作但保持电机扭矩" @click="emit('stop')"><el-icon><CircleCloseFilled /></el-icon>停止遥操作</button>
      </section>

      <section class="overview-grid" aria-label="实时画面和关节状态">
        <section class="arm-card camera-card">
          <header class="card-heading"><h2>实时画面</h2><span class="live-pill"><i></i>LIVE</span></header>
          <div class="camera-grid">
            <CameraView :stream="cameraStream" :frame="cameraFrame" :latency-ms="cameraLatency" fallback-src="/video/camera" kicker="OVERHEAD" title="俯视相机" placeholder="等待摄像头 1 画面..." hint="cam_0" live-text="实时" wait-text="等待" />
            <CameraView :stream="camera2Stream" :frame="camera2Frame" :latency-ms="camera2Latency" fallback-src="/video/camera2" kicker="GRIPPER" title="末端相机" placeholder="等待摄像头 2 画面..." hint="cam_1" live-text="实时" wait-text="等待" />
          </div>
        </section>

        <section class="arm-card joint-card" aria-label="Follower 关节状态">
          <header class="card-heading"><h2>关节状态</h2><span class="dof-pill"><el-icon><Cpu /></el-icon>6 DOF</span></header>
          <div class="joint-list">
            <article v-for="motor in motors" :key="motor.key" class="joint-row">
              <strong>{{ motor.shortLabel }}</strong>
              <div class="joint-reading"><div><span>joint_{{ motor.id }}</span><output>{{ current[motor.key] === undefined ? "--" : format(current[motor.key], motor.unit) }}{{ motor.unit }}</output></div><i><b :style="barStyle(motor)"></b></i></div>
              <small>{{ current[motor.key] === undefined ? "等待" : `${statePercent(motor)}%` }}</small>
            </article>
          </div>
        </section>
      </section>

      <section class="arm-card control-card" aria-label="控制面板">
        <header class="control-heading"><h2>关节目标</h2><div class="control-heading-actions"><button :disabled="!controlEnabled || !running || !hasCurrent" title="将实时关节位置复制为目标值" @click="copyCurrent"><el-icon><Finished /></el-icon>复制当前位置</button><button :disabled="!controlEnabled || !running || !hasOrigin" title="回到首次连接时记录的原始位置" @click="setCenter"><el-icon><RefreshLeft /></el-icon>回归原始位置</button></div></header>
        <div class="slider-grid">
          <label v-for="motor in motors" :key="motor.key" class="joint-control">
            <span><b>joint_{{ motor.id }}</b><em>{{ motor.shortLabel }}</em><output>{{ format(targets[motor.key], motor.unit) }}{{ motor.unit }}</output></span>
            <input class="arm-slider" type="range" :min="motor.min" :max="motor.max" :step="motor.step" :value="targets[motor.key]" :disabled="!controlEnabled || !running" :style="sliderStyle(motor)" :aria-label="`${motor.shortLabel}目标位置`" @input="onSliderInput(motor.key, $event)" @pointerup="sendNow" @change="sendNow" />
            <small><i>{{ format(motor.min, motor.unit) }}{{ motor.unit }}</i><i>{{ format(motor.max, motor.unit) }}{{ motor.unit }}</i></small>
          </label>
        </div>
        <footer class="release-actions"><button class="release-emergency" :disabled="releasing" title="停止控制并关闭所有电机扭矩" @click="emit('release')"><el-icon><WarningFilled /></el-icon>{{ releasing ? "正在释力..." : "紧急停止并释力" }}</button></footer>
      </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { CircleCloseFilled, Cpu, Finished, RefreshLeft, VideoCamera, VideoPlay, WarningFilled } from "@element-plus/icons-vue";
import type { JointData } from "../composables/useWebSocket";
import CameraView from "./CameraView.vue";

type MotorKey = "shoulder_pan" | "shoulder_lift" | "elbow_flex" | "wrist_flex" | "wrist_roll" | "gripper";
type Motor = { key: MotorKey; id: number; shortLabel: string; min: number; max: number; step: number; unit: string };

const props = defineProps<{ running: boolean; busy: boolean; releasing: boolean; released: boolean; controlEnabled: boolean; controlLatency: number | null; rtcStatus: "connecting" | "connected" | "disabled" | "failed" | "fallback"; cameraLatency: number | null; camera2Latency: number | null; camera3Latency: number | null; camera4Latency: number | null; cameraFps: number; cameraDropped: number; camera2Fps: number; camera2Dropped: number; follower: JointData | null; send: (message: object) => void; cameraStream: MediaStream | null; camera2Stream: MediaStream | null; camera3Stream: MediaStream | null; camera4Stream: MediaStream | null; cameraFrame: string | null; camera2Frame: string | null; camera3Frame: string | null; camera4Frame: string | null }>();
const emit = defineEmits<{ start: []; stop: []; release: [] }>();

const motors = ref<Motor[]>([
  { key: "shoulder_pan", id: 1, shortLabel: "Base", min: -112.17, max: 112.17, step: 0.1, unit: "°" },
  { key: "shoulder_lift", id: 2, shortLabel: "Shoulder", min: -103.82, max: 103.82, step: 0.1, unit: "°" },
  { key: "elbow_flex", id: 3, shortLabel: "Elbow", min: -96.62, max: 96.62, step: 0.1, unit: "°" },
  { key: "wrist_flex", id: 4, shortLabel: "Wrist1", min: -102.46, max: 102.46, step: 0.1, unit: "°" },
  { key: "wrist_roll", id: 5, shortLabel: "Wrist2", min: -164.57, max: 164.57, step: 0.1, unit: "°" },
  { key: "gripper", id: 6, shortLabel: "Gripper", min: 0, max: 100, step: 1, unit: "%" },
]);
const targets = reactive<Record<MotorKey, number>>({ shoulder_pan: 0, shoulder_lift: 2, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 50 });
// The requested physical home pose. wrist_flex is re-expressed against the
// expanded calibrated range, so -102.2deg is the prior -103.7deg raw position.
const connectionPose: Record<MotorKey, number> = { shoulder_pan: 5.6, shoulder_lift: -99.1, elbow_flex: 95.8, wrist_flex: -102.2, wrist_roll: 5.4, gripper: 1 };
const origin = ref<Partial<Record<MotorKey, number>>>({});
const initialized = ref(false);
let wasRunning = false;
const current = computed(() => props.follower || {});
const hasCurrent = computed(() => motors.value.every((motor) => typeof current.value[motor.key] === "number"));
const hasOrigin = computed(() => motors.value.every((motor) => typeof origin.value[motor.key] === "number"));
const cameraFps = computed(() => Math.round((props.cameraFps + props.camera2Fps) / 2));
const droppedFrames = computed(() => props.cameraDropped + props.camera2Dropped);

watch(() => props.follower, (value) => {
  if (!value || !motors.value.every((motor) => typeof value[motor.key] === "number")) return;
  if (!hasOrigin.value) for (const motor of motors.value) origin.value[motor.key] = value[motor.key];
  if (!initialized.value) { for (const motor of motors.value) targets[motor.key] = clamp(value[motor.key], motor); initialized.value = true; }
}, { deep: true, immediate: true });
watch(() => props.running, (running) => {
  if (running && !wasRunning) {
    for (const motor of motors.value) targets[motor.key] = clamp(connectionPose[motor.key], motor);
    sendNow();
  }
  wasRunning = running;
}, { immediate: true });
function clamp(value: number, motor: Motor) { return Math.min(motor.max, Math.max(motor.min, value)); }
function format(value: number, unit: string) { return unit === "%" ? `${Math.round(value)}` : value.toFixed(1); }
function sliderStyle(motor: Motor) { const fill = (targets[motor.key] - motor.min) / (motor.max - motor.min) * 100; return { "--slider-fill": `${Math.min(100, Math.max(0, fill))}%` }; }
function statePercent(motor: Motor) {
  const value = current.value[motor.key];
  if (typeof value !== "number" || motor.max <= motor.min) return 0;
  return Math.round((clamp(value, motor) - motor.min) / (motor.max - motor.min) * 100);
}
function barStyle(motor: Motor) { return { width: `${statePercent(motor)}%` }; }
function onSliderInput(key: MotorKey, event: Event) {
  targets[key] = Number((event.target as HTMLInputElement).value);
  sendNow();
}
function sendNow() { if (props.controlEnabled && props.running) props.send({ type: "manual_action", joints: { ...targets }, ts_ms: Date.now() }); }
function copyCurrent() { if (!hasCurrent.value) return; for (const motor of motors.value) targets[motor.key] = clamp(current.value[motor.key], motor); sendNow(); }
function setCenter() { if (!hasOrigin.value) return; for (const motor of motors.value) targets[motor.key] = clamp(origin.value[motor.key]!, motor); sendNow(); }
onMounted(async () => { try { const response = await fetch("/api/calibration/follower"); const data = await response.json(); if (!response.ok || !data.ok) return; for (const motor of motors.value) { const calibration = data.calibration?.[motor.key] || data.calibration?.[String(motor.id)]; if (!calibration || !Number.isFinite(calibration.range_min) || !Number.isFinite(calibration.range_max) || motor.key === "gripper") continue; const halfRange = (calibration.range_max - calibration.range_min) * 180 / 4095; motor.min = Math.max(motor.min, -halfRange); motor.max = Math.min(motor.max, halfRange); } } catch { /* Fixed mechanical bounds stay active. */ } });
</script>

<style scoped>
.control-heading-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.route-view .arm-slider { background:linear-gradient(to right,var(--dcp-primary) 0,var(--dcp-primary) var(--slider-fill),var(--dcp-line) var(--slider-fill),var(--dcp-line) 100%) !important; }
.route-view .arm-slider::-webkit-slider-runnable-track { height:6px; border-radius:999px; background:transparent; }
.route-view .arm-slider::-moz-range-track { height:6px; border-radius:999px; background:transparent; }
.release-actions { display:flex; justify-content:flex-end; margin-top:24px; padding-top:18px; border-top:1px solid var(--dcp-line); }
.release-emergency,.stop-control,.restore-control { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:0 15px; border:0; border-radius:999px; background:var(--dcp-danger); color:#fff; cursor:pointer; font-size:13px; font-weight:700; }
.restore-control { background:var(--dcp-primary); }
.release-emergency { min-height:40px; padding:0 18px; }
.release-emergency:disabled,.stop-control:disabled,.restore-control:disabled { cursor:not-allowed; opacity:.45; }
.arm-workspace { color:var(--dcp-ink); padding-top:32px; padding-bottom:40px; }.page-header>p { margin:0 0 4px; color:var(--dcp-ink-3); font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }.page-header h1 { margin:0; font-size:30px; line-height:1.15; font-weight:600; }.page-header>span { display:block; margin-top:5px; color:var(--dcp-ink-2); font-size:14px; }.tabs { display:inline-flex; gap:4px; margin-top:16px; padding:4px; border-radius:999px; background:var(--dcp-surface-2); }.tabs button,.gesture-library button { min-height:32px; padding:0 14px; border:1px solid transparent; border-radius:999px; background:transparent; color:var(--dcp-ink-2); cursor:pointer; font-size:13px; font-weight:500; }.tabs button.active { border-color:var(--dcp-line); background:var(--dcp-surface); color:var(--dcp-ink); box-shadow:0 1px 2px rgba(0,0,0,.04); }.arm-card { border:1px solid var(--dcp-line); border-radius:19px; background:var(--dcp-surface); box-shadow:0 1px 2px rgba(0,0,0,.04); }.status-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:24px 0; padding:12px 20px; }.status-items { display:flex; align-items:center; flex-wrap:wrap; gap:16px; color:var(--dcp-ink-2); font-size:12px; font-weight:500; }.status-items span { display:inline-flex; align-items:center; gap:6px; }.status-items .el-icon { font-size:14px; }.status-items .muted { color:var(--dcp-ink-3); }.status-items b { color:inherit; font:600 12px var(--dcp-font-mono,ui-monospace,monospace); }.connected-pill,.live-pill { padding:5px 10px; border-radius:999px; background:rgba(52,199,89,.12); color:#258942; }.connected-pill i,.live-pill i { width:6px; height:6px; border-radius:50%; background:#34c759; }.connected-pill.idle { background:var(--dcp-surface-2); color:var(--dcp-ink-3); }.connected-pill.idle i { background:var(--dcp-ink-3); }.emergency-stop { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:0 15px; border:0; border-radius:999px; background:var(--dcp-danger); color:#fff; cursor:pointer; font-size:13px; font-weight:700; }.emergency-stop:disabled { opacity:.45; cursor:not-allowed; }.overview-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,1fr); gap:24px; }.camera-card,.joint-card { padding:20px; }.card-heading,.control-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }.card-heading h2,.control-heading h2 { margin:0; color:var(--dcp-ink); font-size:16px; font-weight:650; }.live-pill,.dof-pill,.preview-pill,.rec-pill { display:inline-flex; align-items:center; gap:5px; padding:4px 9px; border-radius:999px; background:var(--dcp-surface-2); color:var(--dcp-ink-3); font:500 10px var(--dcp-font-mono,ui-monospace,monospace); }.dof-pill .el-icon,.preview-pill .el-icon { font-size:12px; }.camera-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.camera-grid :deep(.camera-view-root) { min-width:0; }.camera-grid :deep(.view-heading) { margin-bottom:6px; }.camera-grid :deep(.kicker) { font-size:10px; }.camera-grid :deep(h2) { font-size:13px; }.camera-grid :deep(.video-box) { border-radius:12px; }.kinematics { margin-top:18px; padding:16px; border:1px solid var(--dcp-line); border-radius:13px; background:var(--dcp-bg); }.kinematics header { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }.kinematics h3 { margin:0; font-size:14px; font-weight:650; }.kinematics header span { padding:3px 8px; border-radius:999px; background:var(--dcp-surface); color:var(--dcp-ink-3); font:500 10px var(--dcp-font-mono,ui-monospace,monospace); }.arm-diagram { display:grid; place-items:center; min-height:300px; overflow:hidden; }.arm-diagram svg { width:min(100%,420px); max-height:360px; }.svg-label { fill:var(--dcp-ink-3); font:12px var(--dcp-font-sans,system-ui,sans-serif); }.joint-text { fill:#fff; font:600 9px var(--dcp-font-sans,system-ui,sans-serif); }.joint-list { padding:0 4px; }.joint-row { display:grid; grid-template-columns:64px minmax(0,1fr) auto; align-items:center; gap:12px; padding:13px 0; border-bottom:1px solid var(--dcp-line); }.joint-row:last-child { border-bottom:0; }.joint-row>strong { color:var(--dcp-ink-2); font-size:12px; font-weight:600; }.joint-reading>div { display:flex; justify-content:space-between; gap:8px; margin-bottom:6px; }.joint-reading span { color:var(--dcp-ink-3); font-size:11px; }.joint-reading output { color:var(--dcp-primary); font:600 12px var(--dcp-font-mono,ui-monospace,monospace); }.joint-reading i,.episode>i { display:block; height:6px; overflow:hidden; border-radius:999px; background:var(--dcp-line); }.joint-reading b,.episode>i>b { display:block; height:100%; border-radius:inherit; background:var(--dcp-primary); transition:width .15s ease; }.joint-row>small { padding:4px 7px; border-radius:5px; background:var(--dcp-surface-2); color:var(--dcp-ink-2); font:500 10px var(--dcp-font-mono,ui-monospace,monospace); }.control-card { margin-top:24px; padding:20px; }.control-heading button { display:inline-flex; align-items:center; gap:5px; min-height:32px; padding:0 12px; border:1px solid var(--dcp-line); border-radius:999px; background:var(--dcp-surface); color:var(--dcp-ink-2); cursor:pointer; font-size:12px; font-weight:600; }.control-heading button:disabled,.gesture-library button:disabled,.control-actions button:disabled { opacity:.45; cursor:not-allowed; }.slider-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:21px 34px; }.joint-control>span { display:flex; align-items:baseline; gap:8px; }.joint-control b { font-size:14px; font-weight:600; }.joint-control em { color:var(--dcp-ink-3); font-size:12px; font-style:normal; }.joint-control output { margin-left:auto; color:var(--dcp-primary); font:600 14px var(--dcp-font-mono,ui-monospace,monospace); }.arm-slider { width:100%; height:6px; margin:11px 0 4px; appearance:none; border-radius:999px; background:linear-gradient(to right,var(--dcp-primary) 0,var(--dcp-primary) var(--slider-fill),var(--dcp-line) var(--slider-fill),var(--dcp-line) 100%); cursor:pointer; }.arm-slider::-webkit-slider-thumb { width:18px; height:18px; appearance:none; border:3px solid var(--dcp-surface); border-radius:50%; background:var(--dcp-primary); box-shadow:0 1px 3px rgba(0,0,0,.15); }.arm-slider::-moz-range-thumb { width:14px; height:14px; border:3px solid var(--dcp-surface); border-radius:50%; background:var(--dcp-primary); box-shadow:0 1px 3px rgba(0,0,0,.15); }.arm-slider:disabled { opacity:.45; cursor:not-allowed; }.joint-control>small { display:flex; justify-content:space-between; color:var(--dcp-ink-3); font:10px var(--dcp-font-mono,ui-monospace,monospace); }.joint-control>small i { font-style:normal; }.gesture-library { margin-top:24px; padding-top:19px; border-top:1px solid var(--dcp-line); }.gesture-library h3 { margin:0 0 12px; color:var(--dcp-ink-3); font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }.gesture-library div { display:flex; flex-wrap:wrap; gap:8px; }.gesture-library button { min-height:30px; padding:0 13px; border-color:var(--dcp-line); background:var(--dcp-surface-2); font-size:12px; }.gesture-library button:hover:not(:disabled) { border-color:var(--dcp-primary); background:var(--dcp-primary); color:#fff; }.control-actions { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-top:24px; padding-top:19px; border-top:1px solid var(--dcp-line); }.control-actions>div { display:flex; align-items:center; flex-wrap:wrap; gap:14px; }.teleop-toggle { display:inline-flex; align-items:center; gap:8px; color:var(--dcp-ink); font-size:13px; font-weight:600; cursor:pointer; }.teleop-toggle input { position:absolute; opacity:0; }.teleop-toggle span { width:42px; height:24px; border-radius:999px; background:var(--dcp-line); position:relative; }.teleop-toggle span:after { content:""; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.16); transition:transform .15s; }.teleop-toggle input:checked + span { background:var(--dcp-primary); }.teleop-toggle input:checked + span:after { transform:translateX(18px); }.control-actions>div>button { display:inline-flex; align-items:center; gap:6px; min-height:36px; padding:0 15px; border:1px solid var(--dcp-line); border-radius:999px; background:var(--dcp-surface); color:var(--dcp-ink); cursor:pointer; font-size:13px; font-weight:650; }.control-actions>div>.primary { border-color:var(--dcp-primary); background:var(--dcp-primary); color:#fff; }.recorder-layout { display:grid; grid-template-columns:minmax(300px,360px) minmax(0,1fr); gap:24px; margin-top:24px; }.recorder-controls,.recorder-preview { padding:20px; align-self:start; }.rec-pill.recording { background:rgba(255,59,48,.12); color:#d9342b; }.episode { margin-bottom:18px; }.episode>div { display:flex; justify-content:space-between; margin-bottom:8px; font-size:14px; font-weight:600; }.episode b { color:var(--dcp-primary); font-family:var(--dcp-font-mono,ui-monospace,monospace); }.episode>i { height:8px; }.recorder-controls :deep(.recording-panel) { padding:0; }.recorder-controls :deep(.heading) { display:none; }.preview-pill { padding:5px 9px; }.recorder-preview .camera-grid :deep(.video-box) { aspect-ratio:16/10; }
@media (max-width:900px) { .overview-grid,.recorder-layout { grid-template-columns:1fr; }.recorder-controls { max-width:none; }.status-bar,.control-actions { align-items:stretch; flex-direction:column; }.emergency-stop { align-self:flex-start; }.slider-grid { gap:20px; } }
@media (max-width:600px) { .arm-workspace { padding-top:24px; }.page-header h1 { font-size:26px; }.status-items { gap:10px 14px; }.camera-grid,.slider-grid { grid-template-columns:1fr; }.camera-card,.joint-card,.control-card,.recorder-controls,.recorder-preview { padding:16px; }.control-actions .emergency-stop { width:100%; }.joint-row { grid-template-columns:56px minmax(0,1fr) auto; gap:8px; } }
</style>
