<template>
  <main class="dcp-page upload-page">
    <header class="dcp-page-title"><p>数据交付</p><h1>上传训练主机</h1></header>

    <section class="summary-grid" aria-label="上传汇总">
      <article><small>队列中</small><strong>{{ pendingTasks.length }}</strong></article>
      <article><small>上传成功</small><strong class="success">{{ successTasks.length }}</strong></article>
      <article><small>上传失败</small><strong class="danger">{{ failedTasks.length }}</strong></article>
      <article><small>本地数据集</small><strong>{{ datasets.length }}</strong></article>
    </section>

    <div class="upload-layout">
      <aside class="settings-column">
        <section class="dcp-card service-card">
          <div class="card-heading"><h2>自动上传</h2><i :class="{ active: enabled }"></i></div>
          <p><b :class="{ active: enabled }">{{ enabled ? "已开启" : "已关闭" }}</b><span>录制保存完成后自动入队上传</span></p>
          <label class="toggle-row"><span>启用自动上传</span><input v-model="enabled" type="checkbox" /></label>
        </section>

        <section class="dcp-card settings-card">
          <h2>训练主机</h2>
          <label>传输方式
            <select v-model="method" @change="onMethodChange">
              <option value="ssh">SSH（rsync over ssh，免密密钥）</option>
              <option value="rsyncd">rsync 守护进程（局域网免认证）</option>
            </select>
          </label>
          <label>主机地址<input v-model="host" placeholder="例如 192.168.1.20" /></label>
          <label>端口<input v-model.number="port" type="number" min="1" max="65535" /></label>
          <template v-if="method === 'rsyncd'">
            <label>rsync 模块名<input v-model="rsyncModule" placeholder="lerobot" /></label>
          </template>
          <template v-else>
            <label>用户名<input v-model="user" placeholder="例如 train" /></label>
            <label>数据根目录<input v-model="remoteRoot" placeholder="/data/lerobot" /></label>
          </template>
          <label>失败重试次数<input v-model.number="retries" type="number" min="0" max="5" /></label>
          <div class="check-row">
            <button class="ghost-button" :disabled="checking" @click="checkConnection">{{ checking ? "测试中…" : "测试连接" }}</button>
            <span v-if="checkResult" :class="checkResult.ok ? 'ok-text' : 'fail-text'">{{ checkResult.message }}</span>
          </div>
          <p v-if="method === 'ssh' && publicKey" class="key-hint">本机公钥（部署到训练主机 <code>~/.ssh/authorized_keys</code> 后即可免密上传）：<code>{{ publicKey }}</code></p>
          <p v-if="method === 'rsyncd'" class="key-hint">训练主机需用 <code>rsync --daemon</code> 导出上述模块目录（见 docs/UPLOAD_TO_TRAINING_HOST.md），局域网内免密钥免密码直传。</p>
        </section>
        <button class="primary-button save-button" @click="saveSettings">{{ saved ? "已保存" : "保存设置" }}</button>
        <p v-if="saveError" class="fail-text">{{ saveError }}</p>
      </aside>

      <section class="queue-column">
        <div class="queue-tabs">
          <button :class="{ active: tab === 'tasks' }" @click="tab = 'tasks'">上传任务</button>
          <button :class="{ active: tab === 'datasets' }" @click="tab = 'datasets'">数据集</button>
          <button class="refresh-button" title="刷新" @click="refresh">刷新</button>
        </div>

        <div v-if="tab === 'tasks'" class="dcp-card queue-card">
          <div class="queue-head"><span>数据集</span><span>大小</span><span>状态</span><span>操作</span></div>
          <div v-if="loading && !tasks.length" class="empty-row">正在读取任务…</div>
          <div v-else-if="!tasks.length" class="empty-row">暂无上传任务，可在“数据集”页发起上传</div>
          <article v-for="task in tasks" :key="task.id" class="queue-row task-row">
            <div>
              <i>⇪</i>
              <span>
                <strong>{{ task.dataset }}</strong>
                <small>第 {{ task.attempts }} 次尝试 · {{ formatBytes(task.transferredBytes) }} 已传输</small>
                <span v-if="task.state === 'running'" class="progress-bar"><span :style="{ width: `${task.progress}%` }"></span></span>
              </span>
            </div>
            <span>--</span>
            <span :class="stateClass(task.state)">{{ stateLabel(task) }}</span>
            <div class="row-actions">
              <button v-if="task.state === 'failed'" @click="retryTask(task.id)">重试</button>
              <button class="link" @click="expanded = expanded === task.id ? '' : task.id">{{ expanded === task.id ? "收起" : "日志" }}</button>
            </div>
            <pre v-if="expanded === task.id" class="log-box">{{ (task.logs || []).slice(-60).join("\n") || "（暂无日志）" }}</pre>
          </article>
        </div>

        <div v-else class="dcp-card queue-card">
          <div class="queue-head"><span>数据集</span><span>大小</span><span>状态</span><span>操作</span></div>
          <div v-if="loading && !datasets.length" class="empty-row">正在读取本地数据…</div>
          <div v-else-if="!datasets.length" class="empty-row">暂无数据集</div>
          <article v-for="item in datasets" :key="item.name" class="queue-row">
            <div><i>▤</i><span><strong>{{ item.name }}</strong><small>{{ item.totalEpisodes || 0 }} 段采集 · {{ recordingLabel(item) }}</small></span></div>
            <span>{{ formatBytes(item.storageBytes || 0) }}</span>
            <span :class="uploadBadge(item.name) === '已上传' ? 'success-text' : 'waiting'">{{ uploadBadge(item.name) }}</span>
            <button :disabled="Boolean(activeTaskFor(item.name)) || !configured" :title="!configured ? '请先保存训练主机配置' : ''" @click="upload(item.name)">
              {{ activeTaskFor(item.name) ? "队列中" : "上传" }}
            </button>
          </article>
        </div>
        <p class="capability-note">上传通过 rsync 增量同步到训练主机的数据根目录（排除审核 sidecar），完成后自动做一致性复核；rosbag → LeRobot 转换与训练在训练主机平台执行。</p>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

type Dataset = { name: string; recordingType?: string; totalEpisodes?: number; storageBytes?: number };
type UploadTask = {
  id: string; dataset: string; state: string; progress: number; transferredBytes: number;
  attempts: number; error: string | null; logs: string[]; verifiedAt: string | null; finishedAt: string | null;
};

const datasets = ref<Dataset[]>([]);
const tasks = ref<UploadTask[]>([]);
const loading = ref(false);
const tab = ref<"tasks" | "datasets">("tasks");
const expanded = ref("");

const enabled = ref(false);
const method = ref<"rsyncd" | "ssh">("ssh");
const host = ref("");
const port = ref(22);
const user = ref("");
const remoteRoot = ref("/data/lerobot");
const rsyncModule = ref("lerobot");
const retries = ref(3);
const publicKey = ref("");
const saved = ref(false);
const saveError = ref("");
const checking = ref(false);
const checkResult = ref<{ ok: boolean; message: string } | null>(null);

let pollTimer: number | null = null;
const configured = computed(() => Boolean(host.value) && (method.value === "rsyncd" || Boolean(user.value)));

function onMethodChange() {
  port.value = method.value === "rsyncd" ? 873 : 22;
  checkResult.value = null;
}
const pendingTasks = computed(() => tasks.value.filter((task) => task.state === "queued" || task.state === "running"));
const successTasks = computed(() => tasks.value.filter((task) => task.state === "success"));
const failedTasks = computed(() => tasks.value.filter((task) => task.state === "failed"));

async function api(route: string, options?: RequestInit) {
  const response = await fetch(route, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

async function loadSettings() {
  try {
    const data = await api("/api/upload/settings");
    enabled.value = Boolean(data.settings.enabled);
    method.value = data.settings.method === "rsyncd" ? "rsyncd" : "ssh";
    host.value = data.settings.host || "";
    port.value = data.settings.port || (method.value === "ssh" ? 22 : 873);
    user.value = data.settings.user || "";
    remoteRoot.value = data.settings.remoteRoot || "/data/lerobot";
    rsyncModule.value = data.settings.module || "lerobot";
    retries.value = data.settings.retries ?? 3;
    publicKey.value = data.publicKey || "";
  } catch { /* settings unavailable until first save */ }
}

async function loadDatasets() {
  try {
    const data = await api("/api/datasets");
    datasets.value = Array.isArray(data.datasets) ? data.datasets : [];
  } catch { datasets.value = []; }
}

async function loadTasks() {
  try {
    const data = await api("/api/upload/tasks");
    tasks.value = Array.isArray(data.tasks) ? data.tasks : [];
  } catch { /* keep previous list */ }
}

async function refresh() {
  loading.value = true;
  await Promise.all([loadDatasets(), loadTasks()]);
  loading.value = false;
}

async function saveSettings() {
  saved.value = false;
  saveError.value = "";
  try {
    await api("/api/upload/settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: enabled.value, method: method.value, host: host.value.trim(), port: port.value,
        user: user.value.trim(), remoteRoot: remoteRoot.value.trim(), module: rsyncModule.value.trim(), retries: retries.value,
      }),
    });
    saved.value = true;
    window.setTimeout(() => { saved.value = false; }, 1600);
    void loadTasks();
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : "保存失败";
  }
}

async function checkConnection() {
  checking.value = true;
  checkResult.value = null;
  try {
    const data = await api("/api/upload/check", { method: "POST", body: "{}" });
    if (data.ok === false) {
      checkResult.value = { ok: false, message: data.error || "检查未通过" };
      return;
    }
    checkResult.value = { ok: true, message: `连接正常${data.freeDiskMb ? ` · 远端剩余 ${formatBytes(data.freeDiskMb * 1024 * 1024)}` : ""}` };
    if (Array.isArray(data.modules) && data.modules.length) checkResult.value.message += ` · 模块: ${data.modules.join(", ")}`;
  } catch (error) {
    checkResult.value = { ok: false, message: error instanceof Error ? error.message : "连接失败" };
  } finally {
    checking.value = false;
  }
}

async function upload(dataset: string) {
  try {
    await api(`/api/datasets/${encodeURIComponent(dataset)}/upload`, { method: "POST", body: "{}" });
    tab.value = "tasks";
    await loadTasks();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "入队失败");
  }
}

async function retryTask(id: string) {
  try {
    await api(`/api/upload/tasks/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" });
    await loadTasks();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "重试失败");
  }
}

function activeTaskFor(dataset: string) {
  return pendingTasks.value.find((task) => task.dataset === dataset);
}
function lastTaskFor(dataset: string) {
  return tasks.value.find((task) => task.dataset === dataset && task.state === "success");
}
function uploadBadge(dataset: string) {
  const task = activeTaskFor(dataset);
  if (task) return task.state === "running" ? `上传中 ${task.progress}%` : "排队中";
  if (lastTaskFor(dataset)) return "已上传";
  return "待上传";
}
function recordingLabel(item: Dataset) {
  return item.recordingType === "lerobot" ? "LeRobot 格式" : "rosbag 采集";
}
function stateLabel(task: UploadTask) {
  if (task.state === "running") return `上传中 ${task.progress}%`;
  if (task.state === "queued") return "排队中";
  if (task.state === "success") return task.verifiedAt ? "已复核" : "成功";
  return "失败";
}
function stateClass(state: string) {
  if (state === "success") return "success-text";
  if (state === "failed") return "fail-text";
  if (state === "running") return "running-text";
  return "waiting";
}
function formatBytes(value: number) {
  if (!value) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function schedulePoll() {
  pollTimer = window.setInterval(() => {
    void loadTasks();
    if (tab.value === "datasets") void loadDatasets();
  }, pendingTasks.value.length ? 1500 : 6000);
}

onMounted(async () => {
  await Promise.all([loadSettings(), refresh()]);
  schedulePoll();
});
onBeforeUnmount(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<style scoped>
.dcp-page { width:min(1280px,calc(100% - 48px)); margin:auto; padding:32px 0 44px; color:#1d1d1f; }.dcp-page-title { margin-bottom:28px; }.dcp-page-title p { margin:0 0 4px; color:#8e8e93; font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }.dcp-page-title h1 { margin:0; font-size:30px; font-weight:650; }.summary-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:24px; }.summary-grid article,.dcp-card { border:1px solid #e5e5ea; border-radius:19px; background:#fff; }.summary-grid article { padding:20px; }.summary-grid small { display:block; color:#8e8e93; font-size:12px; }.summary-grid strong { display:block; margin-top:8px; font-size:24px; }.summary-grid .success { color:#34c759; }.summary-grid .danger { color:#ff3b30; }.upload-layout { display:grid; grid-template-columns:minmax(280px,1fr) minmax(0,2fr); gap:24px; }.settings-column { display:grid; align-content:start; gap:18px; }.dcp-card { padding:20px; }.card-heading { display:flex; justify-content:space-between; align-items:center; }.card-heading i { width:9px; height:9px; border-radius:50%; background:#c7c7cc; }.card-heading i.active { background:#34c759; }.dcp-card h2 { margin:0 0 16px; font-size:14px; }.service-card p { display:flex; gap:8px; margin:0 0 18px; color:#8e8e93; font-size:12px; }.service-card b { color:#8e8e93; }.service-card b.active { color:#34c759; }.toggle-row { display:flex!important; flex-direction:row!important; justify-content:space-between; align-items:center; }.toggle-row input { width:38px!important; height:22px; accent-color:#34c759; }.settings-card { display:grid; gap:14px; }.settings-card h2 { margin-bottom:0; }.settings-card label { display:grid; gap:7px; color:#48484a; font-size:12px; }.settings-card input,.settings-card select { width:100%; height:38px; padding:0 11px; border:1px solid #d1d1d6; border-radius:10px; outline:0; }.check-row { display:flex; align-items:center; gap:10px; }.key-hint { margin:0; color:#8e8e93; font-size:11px; line-height:1.5; word-break:break-all; }.key-hint code { background:#f2f2f7; padding:2px 6px; border-radius:6px; }.ghost-button { padding:8px 14px; border:1px solid #d1d1d6; border-radius:999px; background:#fff; color:#007aff; font-weight:600; cursor:pointer; }.ghost-button:disabled { opacity:.5; }.primary-button { min-height:42px; border:0; border-radius:999px; color:#fff; background:#007aff; font-weight:650; cursor:pointer; }.save-button:disabled { opacity:.6; }.queue-tabs { display:flex; gap:5px; margin-bottom:12px; }.queue-tabs button { padding:8px 14px; border:0; border-radius:999px; color:#8e8e93; background:transparent; cursor:pointer; }.queue-tabs button.active { color:#0064d6; background:#cfe5ff; }.queue-tabs .refresh-button { margin-left:auto; color:#48484a; background:#fff; border:1px solid #e5e5ea; }.queue-card { padding:0; overflow:hidden; }.queue-head,.queue-row { display:grid; grid-template-columns:minmax(0,1fr) 100px 110px 90px; align-items:center; gap:14px; }.queue-head { padding:13px 20px; border-bottom:1px solid #e5e5ea; color:#8e8e93; font-size:11px; }.queue-row { padding:16px 20px; border-bottom:1px solid #e5e5ea; font-size:12px; }.queue-row:last-child { border-bottom:0; }.queue-row > div { display:flex; align-items:center; gap:10px; min-width:0; }.queue-row > div > i { color:#007aff; font-style:normal; }.queue-row strong,.queue-row small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.queue-row small { margin-top:4px; color:#8e8e93; }.queue-row .waiting { color:#ff9500; }.success-text { color:#34c759; }.ok-text { color:#34c759; font-size:12px; }.fail-text { color:#ff3b30; font-size:12px; }.running-text { color:#007aff; }.queue-row button { padding:6px 10px; border:0; border-radius:999px; color:#007aff; background:#edf5ff; cursor:pointer; }.queue-row button:disabled { opacity:.45; cursor:default; }.queue-row button.link { background:transparent; text-decoration:underline; }.row-actions { display:flex; gap:6px; justify-content:flex-end; }.task-row { grid-template-columns:minmax(0,1fr) 60px 110px 120px; }.task-row > span:nth-child(2) { display:none; }.progress-bar { display:block; height:4px; margin-top:6px; border-radius:4px; background:#e5e5ea; overflow:hidden; }.progress-bar span { display:block; height:100%; background:#007aff; transition:width .4s; }.log-box { grid-column:1/-1; margin:10px 0 0; padding:12px; border-radius:10px; background:#1d1d1f; color:#e5e5ea; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; max-height:260px; overflow:auto; }.empty-row { padding:50px; color:#8e8e93; text-align:center; font-size:13px; }.capability-note { margin:12px 4px 0; color:#8e8e93; font-size:11px; line-height:1.5; }
@media(max-width:800px){.summary-grid{grid-template-columns:1fr 1fr}.upload-layout{grid-template-columns:1fr}.dcp-page{width:calc(100% - 28px);padding-top:24px}.queue-head{display:none}.queue-row{grid-template-columns:1fr auto}.queue-row>span{display:none}}
</style>
