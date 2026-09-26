<template>
  <main class="log-workspace">
    <section class="log-toolbar">
      <div>
        <h2>日志管理</h2>
        <p>每次启动生成独立日志，保存在机器人本地：{{ archiveRoot || "正在读取…" }}</p>
      </div>
      <div class="actions">
        <button :disabled="!filteredLogs.length" @click="exportLogs">导出文本</button>
        <button @click="loadArchive">刷新</button>
        <button class="danger" :disabled="!logs.length" @click="$emit('clear')">清空当前会话</button>
      </div>
    </section>

    <section class="log-body">
      <aside class="date-list">
        <header>启动会话 <span>{{ files.length }}</span></header>
        <button class="session" :class="{ active: selectedDate === 'session' }" @click="selectedDate = 'session'">
          <strong>当前会话</strong><small>{{ logs.length }} 条</small>
        </button>
        <button v-for="file in files" :key="file.id" :class="{ active: selectedDate === file.id }" @click="selectDate(file.id)">
          <strong>{{ file.current ? "本次启动" : formatSession(file) }}</strong>
          <small>{{ file.legacy ? "旧版每日归档 · " : "" }}{{ file.lines }} 条 · {{ formatBytes(file.bytes) }}</small>
        </button>
        <p v-if="!files.length && !loading" class="date-empty">还没有本地日志文件</p>
      </aside>

      <div class="log-content">
        <section class="log-filters">
          <input v-model.trim="query" type="search" placeholder="搜索日志内容…" />
          <select v-model="level">
            <option value="all">全部级别</option><option value="error">错误</option>
            <option value="warn">警告</option><option value="info">信息</option>
          </select>
          <select v-model="source">
            <option value="all">全部来源</option><option value="teleop">遥操作</option>
            <option value="recorder">录制</option><option value="system">系统</option>
          </select>
          <label class="limit-slider" title="控制最多显示的日志条数">
            <span>显示最近 {{ maxLines }} 条</span>
            <input v-model.number="maxLines" type="range" min="50" max="2000" step="50" />
          </label>
          <span>{{ selectedDate === "session" ? "当前会话" : selectedDate }} · {{ displayedLogs.length }} 条</span>
        </section>

        <section class="log-list" aria-live="polite">
          <p v-if="loading" class="empty">正在读取本地日志…</p>
          <p v-else-if="loadError" class="empty error-text">{{ loadError }}</p>
          <p v-else-if="!filteredLogs.length" class="empty">没有符合条件的日志</p>
          <article v-for="(item, index) in displayedLogs" :key="`${item.timestamp}-${index}`" :class="item.level">
            <span class="level-dot"></span>
            <time>{{ formatTime(item.timestamp) }}</time>
            <code>[{{ sourceName(item.source) }}/{{ levelName(item.level) }}] {{ item.message }}</code>
          </article>
        </section>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

type Level = "info" | "warn" | "error";
type Source = "teleop" | "recorder" | "system";
interface LogEntry { timestamp: string; source: Source; level: Level; message: string }
interface LogFile { id: string; date: string; startedAt: string; current: boolean; legacy: boolean; lines: number; bytes: number }

const props = defineProps<{ logs: string[] }>();
defineEmits<{ clear: [] }>();
const query = ref("");
const level = ref<"all" | Level>("all");
const source = ref<"all" | Source>("all");
const files = ref<LogFile[]>([]);
const archivedEntries = ref<LogEntry[]>([]);
const selectedDate = ref("session");
const maxLines = ref(300);
const archiveRoot = ref("");
const loading = ref(false);
const loadError = ref("");

function parseSessionLine(line: string): LogEntry {
  const match = line.match(/^\[([^\]]+)\]\s*(?:\[([^/]+)\/([^\]]+)\]\s*)?(.*)$/);
  const levelText = match?.[3] || "";
  return {
    timestamp: `${new Date().toISOString().slice(0, 10)}T${match?.[1] || "00:00:00"}`,
    source: match?.[2] === "录制" ? "recorder" : match?.[2] === "遥操作" ? "teleop" : "system",
    level: levelText === "错误" ? "error" : levelText === "警告" ? "warn" : "info",
    message: match?.[4] || line,
  };
}

const visibleEntries = computed(() => selectedDate.value === "session"
  ? props.logs.map(parseSessionLine)
  : archivedEntries.value);
const filteredLogs = computed(() => visibleEntries.value.filter((item) => {
  if (query.value && !item.message.toLowerCase().includes(query.value.toLowerCase())) return false;
  if (level.value !== "all" && item.level !== level.value) return false;
  if (source.value !== "all" && item.source !== source.value) return false;
  return true;
}));
const displayedLogs = computed(() => filteredLogs.value.slice(-maxLines.value));

async function loadArchive() {
  loading.value = true; loadError.value = "";
  try {
    const response = await fetch("/api/logs");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取日志目录失败");
    files.value = data.files || [];
    archiveRoot.value = data.root || "";
    if (selectedDate.value !== "session") await selectDate(selectedDate.value);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally { loading.value = false; }
}

async function selectDate(date: string) {
  selectedDate.value = date; loading.value = true; loadError.value = "";
  try {
    const response = await fetch(`/api/logs/${encodeURIComponent(date)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取日志文件失败");
    archivedEntries.value = data.entries || [];
  } catch (error) {
    archivedEntries.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally { loading.value = false; }
}

function sourceName(value: Source) { return value === "recorder" ? "录制" : value === "teleop" ? "遥操作" : "系统"; }
function levelName(value: Level) { return value === "error" ? "错误" : value === "warn" ? "警告" : "信息"; }
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
}
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function formatSession(file: LogFile) {
  if (file.legacy) return file.date;
  const date = new Date(file.startedAt);
  return Number.isNaN(date.getTime())
    ? file.id
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function exportLogs() {
  const content = [...displayedLogs.value].reverse().map((item) =>
    `[${formatTime(item.timestamp)}] [${sourceName(item.source)}/${levelName(item.level)}] ${item.message}`).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `robot-platform-log-${selectedDate.value}.txt`; link.click();
  URL.revokeObjectURL(url);
}

watch(selectedDate, (date) => { if (date === "session") { loadError.value = ""; archivedEntries.value = []; } });
onMounted(loadArchive);
</script>

<style scoped>
/* Light operational theme: matches the capture/data workspaces (white cards, gray borders, red accent). */
.log-workspace { max-width: 1500px; margin: 0 auto; padding: 26px 30px; background: transparent; color: #323437; }
.log-toolbar, .log-body { border: 1px solid #dedfe0; background: #fff; box-shadow: 0 1px 3px rgba(22, 27, 29, .04); }
.log-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px 20px; border-bottom: 1px solid #e6e7e8; border-radius: 8px 8px 0 0; }
.log-toolbar h2 { color: #303235; font-size: 17px; }
.log-toolbar p { margin-top: 5px; color: #818589; font-size: 11px; }
.actions { display: flex; gap: 8px; }
.log-toolbar button { min-height: 34px; padding: 7px 14px; border: 1px solid #d8dade; border-radius: 5px; background: #fff; color: #45484b; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s; }
.log-toolbar button:hover:not(:disabled) { border-color: #c8cbce; background: #f5f6f6; }
.log-toolbar button:disabled { opacity: .45; cursor: default; }
.log-toolbar button.danger { border-color: #f0c9cb; color: #c13d43; }
.log-toolbar button.danger:hover:not(:disabled) { background: #fdf1f2; }
.log-body { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 500px; border-top: 0; border-radius: 0 0 8px 8px; overflow: hidden; }
.date-list { max-height: calc(100vh - 240px); min-height: 440px; overflow-y: auto; border-right: 1px solid #e3e4e5; background: #fafbfb; }
.date-list header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: 13px 14px; border-bottom: 1px solid #e5e6e7; background: #fafbfb; color: #666a6d; font-size: 11px; font-weight: 700; }
.date-list header span { padding: 2px 8px; border-radius: 9px; background: #eef0f1; color: #62676b; font-size: 10px; }
.date-list button { display: grid; width: 100%; gap: 4px; padding: 11px 14px; border: 0; border-bottom: 1px solid #eef0f1; text-align: left; background: transparent; color: #4e5357; cursor: pointer; transition: background .15s; }
.date-list button:hover { background: #f1f3f4; }
.date-list button.active { background: #f3f4f4; box-shadow: inset 3px 0 #0d0e10; }
.date-list button.active strong { color: #0d0e10; }
.date-list strong { font-size: 12px; }
.date-list small { color: #818589; font-size: 10px; }
.date-empty { padding: 18px 14px; color: #8b8f92; font-size: 11px; }
.log-content { min-width: 0; background: #fff; }
.log-filters { display: grid; grid-template-columns: minmax(180px, 1fr) 118px 118px minmax(170px, 230px) auto; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #e5e6e7; background: #fafbfb; }
.limit-slider { display: grid; gap: 4px; cursor: default; }
.limit-slider span { color: #666a6d; font-size: 10px; font-weight: 600; white-space: nowrap; }
.limit-slider input { width: 100%; height: 4px; padding: 0; border: 0; border-radius: 2px; outline: none; background: #e3e4e5; appearance: none; -webkit-appearance: none; cursor: pointer; }
.limit-slider input::-webkit-slider-thumb { width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; background: #0d0e10; box-shadow: 0 1px 3px rgba(22, 27, 29, .25); appearance: none; -webkit-appearance: none; }
.limit-slider input::-moz-range-thumb { width: 12px; height: 12px; border: 2px solid #fff; border-radius: 50%; background: #0d0e10; box-shadow: 0 1px 3px rgba(22, 27, 29, .25); }
.limit-slider input::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; }
.limit-slider input::-moz-range-track { height: 4px; border-radius: 2px; background: #e3e4e5; }
.limit-slider input:focus { box-shadow: none; }
.log-filters input:not([type="range"]), .log-filters select { min-height: 34px; padding: 7px 10px; border: 1px solid #d8dade; border-radius: 5px; outline: none; background: #fff; color: #45484b; font-size: 12px; }
.log-filters input:not([type="range"]):focus, .log-filters select:focus { border-color: #34373a; box-shadow: 0 0 0 3px rgba(13, 14, 16, .08); }
.log-filters input:not([type="range"])::placeholder { color: #a5a8ab; }
.log-filters span { color: #818589; font-size: 11px; text-align: right; }
.log-list { height: calc(100vh - 240px); min-height: 440px; overflow: auto; background: #fff; }
.log-list article { display: grid; grid-template-columns: 8px 64px minmax(0, 1fr); align-items: start; gap: 10px; padding: 8px 16px; border-bottom: 1px solid #f0f1f2; }
.log-list article:hover { background: #f8f9f9; }
.log-list time { color: #8b8f92; font: 10px/1.7 ui-monospace, monospace; }
.log-list code { color: #4c5054; font: 11px/1.55 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.level-dot { width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: #35805d; }
.log-list article.warn .level-dot { background: #db9b45; }
.log-list article.warn code { color: #8c6a19; }
.log-list article.error .level-dot { background: #c23c43; }
.log-list article.error { background: #fdf7f7; }
.log-list article.error code, .error-text { color: #c23c43; }
.empty { padding: 80px 20px; color: #8b8f92; text-align: center; font-size: 12px; }
.log-list::-webkit-scrollbar, .date-list::-webkit-scrollbar { width: 8px; height: 8px; }
.log-list::-webkit-scrollbar-track, .date-list::-webkit-scrollbar-track { background: transparent; }
.log-list::-webkit-scrollbar-thumb, .date-list::-webkit-scrollbar-thumb { border-radius: 4px; background: #d4d6d8; }
.log-list::-webkit-scrollbar-thumb:hover, .date-list::-webkit-scrollbar-thumb:hover { background: #bfc2c5; }
@media (max-width:760px) { .log-workspace { padding: 12px; } .log-toolbar { align-items: flex-start; flex-direction: column; } .log-body { grid-template-columns: 1fr; } .date-list { display: flex; max-height: none; min-height: 0; overflow-x: auto; overflow-y: hidden; border-right: 0; } .date-list header, .date-empty { display: none; } .date-list button { min-width: 130px; } .log-filters { grid-template-columns: 1fr 1fr; } .log-filters input { grid-column: 1 / -1; } .limit-slider { grid-column: 1 / -1; } .limit-slider input { grid-column: auto; } }
</style>
