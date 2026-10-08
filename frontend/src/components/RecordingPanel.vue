<template>
  <div class="recording-panel">
    <div class="heading">
      <div><h2>数据录制</h2><small>按任务组织多轮数据采集</small></div>
      <span class="state" :class="recording.state"><i></i>{{ stateText }}</span>
    </div>

    <template v-if="!active">
      <label>数据集名称<input v-model.trim="form.dataset" :disabled="busy" placeholder="so101_pick_cube" maxlength="64" /></label>
      <label>任务描述<input v-model.trim="form.task" :disabled="busy" placeholder="抓取方块并放入盒中" maxlength="200" /></label>
      <div class="row-fields">
        <label>计划轮数<input v-model.number="form.plannedEpisodes" :disabled="busy" type="number" min="1" max="1000" /></label>
        <label>每轮上限（秒）<input v-model.number="form.episodeTime" :disabled="busy || form.continuous" type="number" min="1" max="3600" /></label>
      </div>
      <label class="continuous-option"><input v-model="form.continuous" type="checkbox" :disabled="busy" />单轮不限时</label>
      <p v-if="recording.error" class="error">{{ recording.error }}</p>
      <p v-else-if="recording.lastResult === 'saved'" class="saved">已保存 {{ recording.completedEpisodes }} 轮</p>
      <p v-else-if="recording.lastResult === 'discarded'" class="task">当前轮已丢弃，之前已保存的轮次保留</p>
      <p v-else class="workflow-note">采集完成后可在“数据”中审核片段，深度编辑使用 LeRobot Studio。</p>
      <button class="record" :disabled="!running || busy || !valid" @click="$emit('start', { ...form })"><span>●</span>开始采集任务</button>
    </template>

    <template v-else>
      <div class="progress"><div><strong>{{ recording.completedEpisodes }}</strong><span> / {{ recording.plannedEpisodes }} 轮已保存</span></div><div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div></div>
      <div v-if="recording.state === 'ready'" class="reset-card ready-card"><strong>第 {{ recording.episode }} 轮已就绪</strong><span>手动复位完成后，按键盘 ← 或点击按钮开始录制</span></div>
      <div v-else class="counter"><strong>{{ elapsed }}</strong><span>秒</span><small>{{ phaseText }}</small></div>
      <p class="task"><b>{{ recording.dataset }}</b><br />{{ recording.task }}</p>
      <div class="actions">
        <button class="discard" :disabled="busy || recording.state === 'saving'" @click="$emit('cancel')">{{ recording.state === 'ready' ? '结束采集' : '丢弃并结束' }}</button>
        <button class="retry" :disabled="busy || recording.state !== 'recording'" @click="$emit('retry')">重录本轮</button>
      </div>
      <div class="actions main-actions">
        <button class="finish" :disabled="busy || !['recording', 'ready'].includes(recording.state)" @click="$emit('finish')">结束任务</button>
        <button v-if="recording.state === 'ready'" class="save begin" :disabled="busy" @click="$emit('begin')">{{ recording.lastResult === 'discarded' ? '重录本轮 ←' : '开始下一轮 ←' }}</button>
        <button v-else class="save" :disabled="busy || recording.state !== 'recording'" @click="$emit('next')">{{ recording.continuous ? '结束本轮 →' : '提前结束本轮 →' }}</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { RecordingStatus } from "../composables/useWebSocket";

const props = defineProps<{ recording: RecordingStatus; running: boolean; busy: boolean }>();
const emit = defineEmits<{
  start: [config: { dataset: string; task: string; plannedEpisodes: number; episodeTime: number; continuous: boolean }];
  next: [];
  begin: [];
  retry: [];
  finish: [];
  cancel: [];
}>();

const form = reactive({ dataset: "so101_dataset", task: "", plannedEpisodes: 10, episodeTime: 20, continuous: false });
const active = computed(() => ["preparing", "recording", "saving", "ready"].includes(props.recording.state));
const valid = computed(() => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(form.dataset)
  && form.task.length > 0
  && Number.isInteger(form.plannedEpisodes) && form.plannedEpisodes >= 1 && form.plannedEpisodes <= 1000
  && (form.continuous || (Number.isInteger(form.episodeTime) && form.episodeTime >= 1 && form.episodeTime <= 3600))
);

const now = ref(Date.now());
const stoppedAt = ref<number | null>(null);
let tickTimer: ReturnType<typeof setInterval> | null = null;
function onEpisodeKey(event: KeyboardEvent) {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === "ArrowRight" && props.recording.state === "recording" && !props.busy) {
    event.preventDefault();
    emit("next");
  } else if (event.key === "ArrowLeft" && props.recording.state === "ready" && !props.busy) {
    event.preventDefault();
    emit("begin");
  }
}
onMounted(() => {
  tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  window.addEventListener("keydown", onEpisodeKey);
});
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
  window.removeEventListener("keydown", onEpisodeKey);
});
watch(() => props.recording.state, (state, previousState) => {
  if (state === "saving" && previousState !== "saving") stoppedAt.value = Date.now();
  if (state !== "saving") stoppedAt.value = null;
}, { immediate: true });
const elapsed = computed(() => {
  if (!props.recording.startedAt || !active.value) return 0;
  const end = props.recording.state === "saving" ? (stoppedAt.value ?? now.value) : now.value;
  return Math.max(0, Math.floor((end - props.recording.startedAt) / 1000));
});
const progress = computed(() => props.recording.plannedEpisodes > 0 ? Math.min(100, props.recording.completedEpisodes / props.recording.plannedEpisodes * 100) : 0);
const phaseText = computed(() => {
  if (props.recording.state === "preparing") return "正在启动 rosbag…";
  if (props.recording.state === "saving") return "正在关闭 rosbag 并保存元数据…";
  return `第 ${props.recording.episode ?? "-"} / ${props.recording.plannedEpisodes} 轮 · ${props.recording.continuous ? "不限时录制" : `上限 ${props.recording.episodeTime} 秒`}`;
});
const stateText = computed(() => ({ idle: "待机", preparing: "准备中", recording: "录制中", saving: "保存中", ready: "等待开始", error: "异常" })[props.recording.state]);
</script>

<style scoped>
.recording-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -12px -12px 1px; padding: 11px 12px; border-bottom: 1px solid #e5e6e6; }
h2 { color: #292b2e; font-size: 13px; } .heading small { display: block; margin-top: 3px; color: #85898c; font-size: 9px; }
.state { display: flex; align-items: center; gap: 5px; padding: 5px 9px; border-radius: 12px; color: #777b7e; background: #f0f1f1; font-size: 10px; font-weight: 650; white-space: nowrap; }
.state i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.state.recording { color: #fff; background: #f04d52; } .state.recording i { animation: pulse 1s ease-in-out infinite; }
.state.preparing, .state.saving, .state.ready { color: #a46b17; background: #fff5df; } .state.error, .error { color: #c9363b; }
label { display: grid; gap: 4px; color: #616568; font-size: 10px; font-weight: 600; }
input { width: 100%; padding: 7px; border: 1px solid #dedfe0; border-radius: 5px; outline: none; background: #fff; color: #27292b; font-size: 11px; }
.row-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; }
.continuous-option { display: flex; align-items: center; gap: 7px; min-height: 31px; }
.continuous-option input { width: auto; margin: 0; accent-color: #258260; }
input:focus { border-color: #75b99f; box-shadow: 0 0 0 3px rgba(66, 167, 129, .1); }
button { min-height: 30px; border: 0; border-radius: 6px; cursor: pointer; font-size: 10px; font-weight: 650; }
button:disabled { cursor: default; opacity: .45; }
.record { margin-top: 2px; min-height: 34px; color: #fff; background: #f04d52; font-size: 11px; }
.record:hover:not(:disabled) { background: #db3d43; } .record span { margin-right: 6px; }
.progress { display: grid; gap: 6px; color: #5e6265; font-size: 10px; } .progress strong { color: #258260; font-size: 15px; }
.progress-track { height: 5px; overflow: hidden; border-radius: 5px; background: #e8eeeb; }.progress-track i { display: block; height: 100%; background: #48a77d; transition: width .25s; }
.counter, .reset-card { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 4px 7px; padding: 9px; border: 1px solid #f2c9ca; border-radius: 5px; background: #fff8f8; }
.counter strong { color: #d63f44; font: 700 22px/1 ui-monospace, monospace; }.counter span { color: #777b7e; font-size: 11px; }.counter small { grid-column: 1 / -1; color: #85898c; font-size: 10px; }
.reset-card { border-color: #ecd9b1; background: #fffbf1; }.reset-card strong { color: #946313; font-size: 11px; }.reset-card span { grid-column: 1 / -1; color: #85898c; font-size: 10px; }
.task, .saved, .error, .workflow-note { overflow-wrap: anywhere; font-size: 10px; line-height: 1.45; }.task { color: #5e6265; }.task b { color: #292b2e; }.saved { color: #258260; }.workflow-note { color: #85898c; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }.main-actions { grid-template-columns: .8fr 1.4fr; }
.discard { color: #55595c; background: #eaebeb; }.retry { color: #6c581e; background: #f7edcf; }.finish { color: #55595c; background: #eaebeb; }.save { color: #fff; background: #f04d52; }.begin { background: #258260; }
@keyframes pulse { 50% { opacity: .25; } }
</style>
