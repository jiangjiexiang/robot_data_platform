<template>
  <main class="workspace">
    <div class="data-platform">
      <aside class="data-sidebar" aria-label="数据管理功能">
        <div class="data-sidebar-title"><strong>数据管理</strong></div>
        <nav>
          <button :class="{ active: dataSection === 'datasets' }" @click="openSection('datasets')"><span>▤</span>数据资产</button>
          <button :class="{ active: dataSection === 'viewer' }" @click="openSection('viewer')"><span>◧</span>数据查看</button>
          <button :class="{ active: dataSection === 'review' }" @click="openSection('review')"><span>✓</span>质量审核 <i v-if="pendingReviewCount">{{ pendingReviewCount }}</i></button>
          <button :class="{ active: dataSection === 'collections' }" @click="openSection('collections')"><span>▱</span>数据选集</button>
          <button :class="{ active: dataSection === 'audit' }" @click="openSection('audit')"><span>☷</span>操作记录</button>
        </nav>
        <div class="data-sidebar-foot"><span>本地目录</span><button @click="loadDatasets(true)" title="刷新数据目录">↻</button></div>
      </aside>
      <section class="data-content">
    <div v-if="error" class="workspace-error">{{ error }}<button @click="loadDatasets(true)">重试</button></div>
    <div v-if="loading && datasets.length === 0" class="catalog-skeleton"><i v-for="item in 3" :key="item"></i></div>
    <div v-else-if="!loading && datasets.length === 0" class="empty">尚无已保存的数据集</div>

    <template v-else>
      <section v-if="dataSection === 'datasets' && !selectedDataset" class="manager-view">
        <div class="reference-dataset-toolbar">
          <div class="reference-dataset-filters">
            <label class="reference-search"><span aria-hidden="true">⌕</span><input v-model="datasetQuery" placeholder="搜索数据集名称..." aria-label="搜索数据集名称" /></label>
            <select v-model="datasetStatus" aria-label="数据集状态"><option value="all">全部状态</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已拒绝</option></select>
            <select v-model="datasetQuality" aria-label="数据集质量"><option value="all">全部质量</option><option value="high">优质（≥95）</option><option value="medium">合格（80-94）</option><option value="low">低质量（&lt;80）</option></select>
            <select v-model="datasetSort" aria-label="数据集排序"><option value="updated-desc">最近更新</option><option value="updated-asc">最早更新</option><option value="quality-desc">质量分从高到低</option><option value="quality-asc">质量分从低到高</option></select>
          </div>
          <div class="reference-dataset-actions"><span>共 {{ managerDatasets.length }} 个数据集</span><button class="create-dataset-button" type="button" @click="showCreateNotice">＋ 新建数据集</button></div>
        </div>
        <div v-if="managerDatasets.length" class="reference-dataset-grid">
          <article v-for="item in managerDatasets" :key="item.name" class="reference-dataset-card">
            <div class="reference-card-heading"><div><h3>{{ item.name }}</h3><p>{{ item.robotType || "so101_follower" }}</p></div><span :class="['reference-status', datasetStatusClass(item)]"><i></i>{{ datasetStatusText(item) }}</span></div>
            <div class="reference-card-stats"><div><strong>{{ item.totalEpisodes }}</strong><span>段采集</span></div><div><strong>{{ item.cameras.length }}</strong><span>路相机</span></div><div><strong>{{ datasetQualityScore(item) }}</strong><span>质量分</span></div></div>
            <div class="reference-card-quality"><div class="reference-quality-ring" :style="qualityRingStyle(item)"><span>{{ datasetQualityScore(item) }}</span></div><span>质量评分</span><time>更新于<br /><b>{{ formatDate(item.modifiedAt) }}</b></time></div>
            <div class="reference-card-footer"><button class="reference-view-button" type="button" @click="openStudio(item)">◉ <span>Studio 编辑</span></button><button class="reference-delete-button" type="button" :aria-label="`删除 ${item.name}`" @click="openDeleteDataset(item)">⌫</button></div>
          </article>
        </div>
        <div v-else class="reference-empty"><span>□</span><strong>未找到匹配的数据集</strong><small>请调整搜索词或筛选条件</small></div>
      </section>

      <template v-else-if="selectedDataset">
      <div class="dataset-context">
        <button @click="closeDataset">← 返回列表</button>
        <div><strong>{{ selectedDataset.name }}</strong><small>{{ selectedDataset.robotType || "机器人数据" }} · {{ selectedDataset.totalEpisodes }} 段采集 · {{ selectedDataset.cameras.length }} 路相机</small></div>
        <div class="context-actions"><span :class="{ loading: detailLoading }">{{ detailLoading ? "正在读取…" : "读取完成" }}</span></div>
      </div>
      <div class="data-layout">

      <section class="episode-list" aria-label="采集片段列表">
        <div class="pane-title episode-title"><strong>采集片段</strong><small>{{ filteredEpisodes.length }} / {{ episodes.length }}</small></div>
        <div class="episode-tools">
          <label class="search"><span>⌕</span><input v-model="query" aria-label="搜索采集片段" placeholder="搜索编号、任务、标签" /></label>
          <div class="tool-row">
            <select v-model="filter" aria-label="审核状态">
              <option v-for="item in filters" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
            <select v-model="qualityFilter" aria-label="质量状态"><option value="all">全部质量</option><option value="issues">有问题</option><option value="clean">规则通过</option></select>
            <select v-model="sort" aria-label="排序"><option value="episode-asc">编号升序</option><option value="episode-desc">编号降序</option><option value="quality-asc">质量较差优先</option><option value="updated-desc">最近审核</option></select>
          </div>
          <label v-if="dataSection === 'review'" class="select-all"><input type="checkbox" :checked="allFilteredSelected" @change="toggleAllFiltered" /> 选择当前结果</label>
        </div>

        <div v-if="dataSection === 'review' && selectedIds.size" class="batch-bar">
          <span>已选 {{ selectedIds.size }} 项</span>
          <select v-model="batch.status" aria-label="批量审核状态"><option value="approved">通过</option><option value="rejected">拒绝</option><option value="unreviewed">待审核</option></select>
          <button :disabled="saving" @click="saveBatch">应用</button>
          <button class="clear" title="清除选择" @click="selectedIds.clear()">×</button>
        </div>

        <div v-if="detailLoading" class="episode-loading">正在读取采集片段…</div>
        <div v-else class="episode-scroll">
          <div v-for="item in filteredEpisodes" :key="item.episode" class="episode-row" :class="{ active: selectedEpisode?.episode === item.episode }">
            <input v-if="dataSection === 'review'" type="checkbox" :checked="selectedIds.has(item.episode)" :aria-label="`选择采集片段 ${item.episode}`" @change="toggleSelected(item.episode)" />
            <button :class="{ 'with-checkbox': dataSection === 'review' }" @click="selectEpisode(item)">
              <span class="episode-index">#{{ String(item.episode).padStart(3, "0") }}</span>
              <span class="episode-duration">{{ formatDuration(item.duration) }}</span>
              <span class="episode-task">{{ item.tasks.join(" / ") || "未命名任务" }}</span>
              <span class="review-state" :class="item.review.status">{{ statusText(item.review.status) }}</span>
              <span v-if="item.review.tags.length" class="episode-tags">{{ item.review.tags.slice(0, 3).join(" · ") }}</span>
              <span v-if="item.quality.flags.length" class="quality-state issue">{{ item.quality.flags.length }} 项问题</span>
              <span v-else class="quality-state">质量 {{ item.quality.score }}</span>
            </button>
          </div>
          <div v-if="filteredEpisodes.length === 0" class="no-results">没有符合条件的采集片段</div>
        </div>
      </section>

      <section v-if="selectedDataset" class="review-pane" aria-label="数据详情">
        <div v-if="detailLoading" class="detail-skeleton">
          <i class="wide"></i><i></i><i></i><i class="video"></i><i class="video"></i>
        </div>
        <template v-else>
        <template v-if="dataSection === 'review' && selectedEpisode">
          <div class="review-export">
            <span>已通过 <strong>{{ approvedCount }}</strong> / {{ episodes.length }} 个片段</span>
            <input v-model="exportTarget" :placeholder="`${selectedDataset.name}_approved`" aria-label="导出目标数据集名称" />
            <button :disabled="exporting || approvedCount === 0" @click="exportReviewed">{{ exporting ? "导出中…" : "导出到新数据集" }}</button>
          </div>
          <p v-if="exportMessage" class="review-export-message">{{ exportMessage }}</p>
          <div class="review-head">
            <div><p class="eyebrow">片段 {{ String(selectedEpisode.episode).padStart(3, "0") }}</p><h3>{{ selectedEpisode.tasks.join(" / ") || "未命名任务" }}</h3></div>
            <div class="episode-facts"><span>{{ selectedEpisode.frames }} 帧</span><span>{{ selectedDataset?.fps }} 帧/秒</span><span>{{ formatDuration(selectedEpisode.duration) }}</span></div>
          </div>
          <div class="quality-panel" :class="{ warning: selectedEpisode.quality.flags.length }">
            <div><small>自动检查</small><strong>{{ selectedEpisode.quality.score }} / 100</strong></div>
            <span>{{ selectedEpisode.quality.cameraCoverage }} / {{ selectedEpisode.quality.expectedCameras }} 路视频</span>
            <p v-if="!selectedEpisode.quality.flags.length">帧数与视频通道检查通过</p>
            <ul v-else><li v-for="flag in selectedEpisode.quality.flags" :key="flag.code">{{ flag.label }}</li></ul>
          </div>
          <div class="videos" :class="{ single: videoEntries.length < 2 }">
            <div v-for="([camera, url], index) in videoEntries" :key="camera" class="video-channel">
              <video :ref="(element) => setVideoRef(element, index)" :src="url" muted playsinline preload="metadata" @error="videoErrors.add(camera)"></video>
              <span>{{ cameraLabel(camera, index) }}</span>
              <small v-if="videoErrors.has(camera)">视频加载失败，请检查数据集视频文件</small>
            </div>
            <div v-if="videoEntries.length === 0" class="video-missing">该采集片段没有可回放的视频</div>
          </div>
        <div class="review-editor">
          <div class="editor-heading"><strong>审核与标注</strong><label><input v-model="syncEnabled" type="checkbox" /> 双路同步</label></div>
          <div class="status-control" role="group" aria-label="审核状态">
            <button v-for="item in reviewStates" :key="item.value" :class="[item.value, { active: edit.status === item.value }]" @click="edit.status = item.value">{{ item.label }}</button>
          </div>
          <label>审核备注<textarea v-model="edit.notes" rows="3" placeholder="记录动作质量、画面问题或可用范围"></textarea></label>
          <div class="review-meta"><span v-if="selectedEpisode.review.updatedAt">上次更新 {{ formatDate(selectedEpisode.review.updatedAt) }}</span></div>
          <div class="save-row"><span>{{ savedMessage }}</span><button class="reject-quick" :disabled="saving" @click="rejectWithTags">{{ saving ? "保存中…" : "标记问题并拒绝" }}</button><button :disabled="saving" @click="saveReview">{{ saving ? "保存中…" : "保存审核" }}</button></div>
        </div>
        </template>

        <template v-else-if="dataSection === 'review'">
          <div class="review-export">
            <span>已通过 <strong>{{ approvedCount }}</strong> / {{ episodes.length }} 个片段</span>
            <input v-model="exportTarget" :placeholder="`${selectedDataset.name}_approved`" aria-label="导出目标数据集名称" />
            <button :disabled="exporting || approvedCount === 0" @click="exportReviewed">{{ exporting ? "导出中…" : "导出到新数据集" }}</button>
          </div>
          <p v-if="exportMessage" class="review-export-message">{{ exportMessage }}</p>
          <div class="review-placeholder">
            <strong>质量审核</strong>
            <p>在左侧选择任意采集片段即可开始审核：判定 通过 / 拒绝、勾选常见问题标签或写备注。</p>
            <p>「选择当前结果」可对筛选出的片段批量审核；审核通过的片段可以用上面的按钮导出成一个新数据集。</p>
          </div>
        </template>

        <section v-else-if="dataSection === 'collections'" class="collections-pane">
          <header><div><h3>数据选集</h3></div><span>{{ approvedCount }} 个采集片段已通过</span></header>
          <div class="publish-box">
            <label>版本名称<input v-model="collectionName" placeholder="例如：抓取任务基线集" /></label>
            <button :disabled="saving || approvedCount === 0" @click="publishCollection">发布已通过数据</button>
            <p>发布后生成不可变清单；原始视频和数据文件保持在当前数据集。</p>
          </div>
          <div class="publish-box">
            <label>导出为数据集<input v-model="exportTarget" :placeholder="`${selectedDataset.name}_approved`" /></label>
            <button :disabled="exporting || approvedCount === 0" @click="exportReviewed">{{ exporting ? "导出中…" : "导出已通过片段" }}</button>
            <p>{{ exportMessage || `把 ${approvedCount} 个已通过片段连同数据和视频复制到一个新数据集，可直接查看或继续审核。` }}</p>
          </div>
          <div v-if="collections.length" class="collection-list">
            <article v-for="item in collections" :key="item.id">
              <div><strong>{{ item.id }} · {{ item.name }}</strong><small>{{ formatDate(item.createdAt) }} · {{ item.episodes.length }} 组</small></div>
              <span class="published">已发布</span>
              <a :href="`/api/datasets/${encodeURIComponent(selectedDataset.name)}/collections/${item.id}/manifest`" title="下载数据选集清单">下载清单</a>
              <button class="collection-delete" title="删除数据选集" @click="deleteCollection(item)">删除</button>
              <p>片段 {{ item.episodes.map((episode) => episode.episode).join(", ") }}</p>
            </article>
          </div>
          <div v-else class="no-results">尚未发布数据选集</div>
        </section>

        <section v-else-if="dataSection === 'audit'" class="audit-pane">
          <header><div><h3>操作记录</h3></div><span>最近 {{ auditEntries.length }} 条</span></header>
          <div v-if="auditEntries.length" class="audit-list">
            <article v-for="(entry, index) in auditEntries" :key="`${entry.at}-${index}`">
              <span class="audit-action">{{ auditAction(entry.action) }}</span>
              <strong>{{ entry.actor || "本地用户" }}</strong>
              <time>{{ formatDate(entry.at) }}</time>
              <p>{{ auditSummary(entry) }}</p>
            </article>
          </div>
          <div v-else class="no-results">尚无操作记录</div>
        </section>
        <div v-else class="section-empty">从左侧选择功能区</div>
        </template>
      </section>
      <section v-else class="review-pane empty">选择一个数据集查看详情</section>
      </div>
      </template>
      <section v-else class="section-empty no-dataset">请先从“数据资产”选择一个数据集</section>
    </template>
      </section>
    </div>

    <div v-if="deleteTarget" class="confirm-backdrop" @click.self="closeDeleteDialog">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <span class="danger-mark">!</span>
        <div><p class="eyebrow">危险操作</p><h3 id="delete-title">删除数据集</h3></div>
        <p>数据集 <strong>{{ deleteTarget.name }}</strong> 将从资产库移出。文件会保留在本地回收目录，可由管理员手动恢复。</p>
        <div class="confirm-actions">
          <button @click="closeDeleteDialog">取消</button>
          <button class="confirm-delete" :disabled="deleting" @click="deleteDataset">{{ deleting ? "正在移入回收目录…" : "移入回收目录" }}</button>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

type ReviewStatus = "unreviewed" | "approved" | "rejected";
interface Review { status: ReviewStatus; tags: string[]; notes: string; assignee?: string; reviewer?: string; qualityFlags?: string[]; createdAt?: string; updatedAt?: string }
interface QualityFlag { code: string; level: "warning" | "error"; label: string }
interface Quality { score: number; flags: QualityFlag[]; cameraCoverage: number; expectedCameras: number }
interface DatasetSummary { name: string; robotType: string | null; fps: number; totalEpisodes: number; totalFrames: number; storageBytes?: number; cameras: string[]; modifiedAt: string; reviews: Record<ReviewStatus, number> }
interface Episode { episode: number; frames: number; duration: number; tasks: string[]; videos: Record<string, string>; quality: Quality; review: Review }
interface TrainingCollection { id: string; name: string; createdAt: string; episodes: Array<{ episode: number; tags: string[]; reviewUpdatedAt: string }> }
interface AuditEntry { at: string; action: string; actor?: string; episodes?: number[]; status?: ReviewStatus; collection?: string; tags?: string[] }

const datasets = ref<DatasetSummary[]>([]);
const episodes = ref<Episode[]>([]);
const selectedDataset = ref<DatasetSummary | null>(null);
const selectedEpisode = ref<Episode | null>(null);
const selectedIds = reactive(new Set<number>());
const root = ref("");
const loading = ref(false);
const detailLoading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const savedMessage = ref("");
const filter = ref<"all" | ReviewStatus>("all");
const qualityFilter = ref<"all" | "issues" | "clean">("all");
const sort = ref("episode-asc");
const query = ref("");
const datasetQuery = ref("");
const datasetStatus = ref("all");
const datasetQuality = ref("all");
const datasetSort = ref("updated-desc");
const datasetType = ref("all");
const reviewFilter = ref("all");
const projectFilter = ref<"all" | "captured" | "pending" | "published">("all");
const selectedDatasetNames = reactive(new Set<string>());
const syncEnabled = ref(true);
const videos = ref<HTMLVideoElement[]>([]);
const videoErrors = reactive(new Set<string>());
const playing = ref(false);
const currentTime = ref(0);
const videoDuration = ref(0);
const playbackSpeed = ref(1);
const playbackState = ref("idle");
const playbackFrame = ref(0);
const playbackFrames = ref(0);
let playbackTimer: number | null = null;
const collections = ref<TrainingCollection[]>([]);
const auditEntries = ref<AuditEntry[]>([]);
type DataSection = "datasets" | "viewer" | "review" | "collections" | "audit";
const dataSection = ref<DataSection>("datasets");
const collectionName = ref("");
const exportTarget = ref("");
const exporting = ref(false);
const exportMessage = ref("");
const deleteTarget = ref<DatasetSummary | null>(null);
const deleting = ref(false);
const deletingEpisode = ref(false);
let syncing = false;
let detailRequest = 0;

const edit = reactive({ status: "unreviewed" as ReviewStatus, tags: "", notes: "", assignee: "", reviewer: "" });
const batch = reactive({ status: "approved" as ReviewStatus, tags: "" });
const filters = [{ value: "all", label: "全部状态" }, { value: "unreviewed", label: "待审核" }, { value: "approved", label: "通过" }, { value: "rejected", label: "拒绝" }] as const;
const reviewStates: { value: ReviewStatus; label: string }[] = [
  { value: "unreviewed", label: "待审核" },
  { value: "approved", label: "通过" },
  { value: "rejected", label: "拒绝" },
];
const totalEpisodes = computed(() => datasets.value.reduce((sum, item) => sum + item.totalEpisodes, 0));
const totalFrames = computed(() => datasets.value.reduce((sum, item) => sum + item.totalFrames, 0));
const totalStorageBytes = computed(() => datasets.value.reduce((sum, item) => sum + (item.storageBytes || 0), 0));
const reviewedEpisodes = computed(() => datasets.value.reduce((sum, item) => sum + item.reviews.approved + item.reviews.rejected, 0));
const reviewRate = computed(() => totalEpisodes.value ? Math.round(reviewedEpisodes.value / totalEpisodes.value * 100) : 0);
const totalDuration = computed(() => `${Math.round(totalFrames.value / Math.max(1, selectedDataset.value?.fps || 30) / 60)} 分钟`);
const qualityIssueCount = computed(() => episodes.value.filter((item) => item.quality.flags.length).length);
const qualityPassRate = computed(() => episodes.value.length ? Math.round((episodes.value.length - qualityIssueCount.value) / episodes.value.length * 100) : 100);
const pendingReviewCount = computed(() => Math.max(0, totalEpisodes.value - reviewedEpisodes.value));
const filteredDatasets = computed(() => {
  const needle = datasetQuery.value.trim().toLocaleLowerCase();
  return needle ? datasets.value.filter((item) => `${item.name} ${item.robotType || ""}`.toLocaleLowerCase().includes(needle)) : datasets.value;
});
const managerDatasets = computed(() => filteredDatasets.value.filter((item) => {
  if (datasetType.value === "arm" && !(item.robotType || "").trim()) return false;
  const reviewed = item.reviews.approved + item.reviews.rejected;
  if (projectFilter.value === "captured" && item.totalEpisodes === 0) return false;
  if (projectFilter.value === "pending" && reviewed >= item.totalEpisodes) return false;
  if (projectFilter.value === "published" && item.reviews.approved === 0) return false;
  const status = datasetStatus.value === "all" || datasetStatusFor(item) === datasetStatus.value;
  const score = datasetQualityScore(item);
  const quality = datasetQuality.value === "all" || (datasetQuality.value === "high" ? score >= 95 : datasetQuality.value === "medium" ? score >= 80 && score < 95 : score < 80);
  const review = reviewFilter.value === "all" || (reviewFilter.value === "pending" ? reviewed < item.totalEpisodes : reviewed > 0);
  return status && quality && review;
}).sort((a, b) => {
  if (datasetSort.value === "quality-desc") return datasetQualityScore(b) - datasetQualityScore(a);
  if (datasetSort.value === "quality-asc") return datasetQualityScore(a) - datasetQualityScore(b);
  const left = new Date(a.modifiedAt).getTime(); const right = new Date(b.modifiedAt).getTime();
  return datasetSort.value === "updated-asc" ? left - right : right - left;
}));
const allDatasetsSelected = computed(() => managerDatasets.value.length > 0 && managerDatasets.value.every((item) => selectedDatasetNames.has(item.name)));
const approvedCount = computed(() => episodes.value.filter((item) => item.review.status === "approved").length);
const filteredEpisodes = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return episodes.value.filter((item) => {
    if (filter.value !== "all" && item.review.status !== filter.value) return false;
    if (qualityFilter.value === "issues" && item.quality.flags.length === 0) return false;
    if (qualityFilter.value === "clean" && item.quality.flags.length > 0) return false;
    return !needle || `#${item.episode} ${item.episode} ${item.tasks.join(" ")} ${item.review.tags.join(" ")}`.toLocaleLowerCase().includes(needle);
  }).sort((a, b) => sort.value === "episode-desc" ? b.episode - a.episode : sort.value === "quality-asc" ? a.quality.score - b.quality.score || a.episode - b.episode : sort.value === "updated-desc" ? (b.review.updatedAt || "").localeCompare(a.review.updatedAt || "") : a.episode - b.episode);
});
const allFilteredSelected = computed(() => filteredEpisodes.value.length > 0 && filteredEpisodes.value.every((item) => selectedIds.has(item.episode)));
const videoEntries = computed(() => Object.entries(selectedEpisode.value?.videos || {}));

function statusText(status: ReviewStatus) { return ({ unreviewed: "待审核", approved: "通过", rejected: "拒绝" })[status]; }
function formatDuration(seconds: number) { const total = Math.max(0, Math.round(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function formatDate(value?: string) { if (!value) return "-"; return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatBytes(value?: number) { if (!value) return "-"; const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`; }
function cameraLabel(camera: string, index: number) { return camera.split(".").pop()?.replace("camera", "摄像头 ") || `摄像头 ${index + 1}`; }
function reviewWidth(item: DatasetSummary, status: ReviewStatus) { return item.totalEpisodes ? `${(item.reviews[status] || 0) / item.totalEpisodes * 100}%` : "0%"; }
function datasetReviewState(item: DatasetSummary) { const reviewed = item.reviews.approved + item.reviews.rejected; return reviewed >= item.totalEpisodes && item.totalEpisodes > 0 ? "reviewed" : reviewed ? "partial" : "pending"; }
function datasetReviewText(item: DatasetSummary) { const reviewed = item.reviews.approved + item.reviews.rejected; return reviewed >= item.totalEpisodes && item.totalEpisodes > 0 ? "已审核" : reviewed ? `已审核 ${reviewed}/${item.totalEpisodes}` : "未审核"; }
function datasetStatusFor(item: DatasetSummary) { return item.reviews.rejected > item.reviews.approved ? "rejected" : item.reviews.approved >= item.totalEpisodes && item.totalEpisodes > 0 ? "approved" : "pending"; }
function datasetStatusText(item: DatasetSummary) { return ({ pending: "待审核", approved: "已通过", rejected: "已拒绝" } as Record<string, string>)[datasetStatusFor(item)]; }
function datasetStatusClass(item: DatasetSummary) { return datasetStatusFor(item); }
function datasetQualityScore(item: DatasetSummary) { return item.totalEpisodes ? Math.max(0, Math.min(100, Math.round(((item.reviews.approved + (item.totalEpisodes - item.reviews.approved - item.reviews.rejected) * 0.9) / item.totalEpisodes) * 100))) : 0; }
function qualityRingStyle(item: DatasetSummary) { const score = datasetQualityScore(item); const color = score >= 95 ? "var(--dcp-success)" : score >= 80 ? "var(--dcp-primary)" : "var(--dcp-danger)"; return { "--quality-deg": `${score * 3.6}deg`, background: `conic-gradient(${color} ${score * 3.6}deg, var(--dcp-line) ${score * 3.6}deg)` }; }
function showCreateNotice() { window.alert("数据集由“概览”中的数据录制流程自动创建，请先开始一次录制。"); }
function toggleDatasetSelected(name: string) { selectedDatasetNames.has(name) ? selectedDatasetNames.delete(name) : selectedDatasetNames.add(name); }
function toggleAllDatasets() { if (allDatasetsSelected.value) managerDatasets.value.forEach((item) => selectedDatasetNames.delete(item.name)); else managerDatasets.value.forEach((item) => selectedDatasetNames.add(item.name)); }
function clearManagerFilters() { datasetQuery.value = ""; datasetType.value = "all"; reviewFilter.value = "all"; projectFilter.value = "all"; }
function openStudio(item: DatasetSummary) {
  const manifest = `/api/datasets/${encodeURIComponent(item.name)}/studio-manifest`;
  window.location.assign(`/studio/?manifest=${encodeURIComponent(manifest)}`);
}
function openSection(section: DataSection) {
  if (section === "datasets") { closeDataset(); return; }
  dataSection.value = section;
}
function deleteSelectedDataset() { const target = datasets.value.find((item) => selectedDatasetNames.has(item.name)); if (target) openDeleteDataset(target); }
function tagsFrom(value: string) { return value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean); }
function auditAction(action: string) { return ({ "review.update": "更新审核", "review.batch": "批量审核", "episode.delete": "删除采集片段", "collection.publish": "发布数据选集", "collection.delete": "删除数据选集" } as Record<string, string>)[action] || action; }
function auditSummary(entry: AuditEntry) {
  const episodesText = entry.episodes?.length ? `采集片段 ${entry.episodes.join(", ")}` : "";
  const statusTextValue = entry.status ? `设为${statusText(entry.status)}` : "";
  const collectionText = entry.collection ? `生成 ${entry.collection}` : "";
  return [episodesText, statusTextValue, collectionText].filter(Boolean).join(" · ") || "数据集操作";
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("机器人服务无响应，请确认启动脚本正在运行");
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `请求失败，状态码 ${response.status}`);
  return data;
}

async function loadDatasets(refresh = false) {
  loading.value = true; error.value = null;
  try {
    const data = await requestJson(`/api/datasets${refresh ? "?refresh=1" : ""}`);
    datasets.value = data.datasets || []; root.value = data.root || "";
    if (selectedDataset.value) {
      selectedDataset.value = datasets.value.find((item) => item.name === selectedDataset.value?.name) || null;
    }
  } catch (cause) {
    datasets.value = []; root.value = "";
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
  finally { loading.value = false; }
}

async function selectDataset(item: DatasetSummary) {
  const requestId = ++detailRequest;
  selectedDataset.value = item; selectedEpisode.value = null; selectedIds.clear(); dataSection.value = "viewer"; error.value = null; detailLoading.value = true;
  writeDatasetHash(item.name);
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(item.name)}?refresh=1`);
    if (requestId !== detailRequest) return;
    episodes.value = data.episodes || [];
    if (episodes.value.length) selectEpisode(episodes.value[0]);
    void loadDatasetOperations(item.name);
  } catch (cause) { if (requestId === detailRequest) { episodes.value = []; error.value = cause instanceof Error ? cause.message : String(cause); } }
  finally { if (requestId === detailRequest) detailLoading.value = false; }
}

function closeDataset() {
  detailRequest += 1;
  if (document.fullscreenElement) void document.exitFullscreen();
  selectedDataset.value = null; selectedEpisode.value = null; episodes.value = [];
  collections.value = []; auditEntries.value = []; selectedIds.clear(); detailLoading.value = false;
  dataSection.value = "datasets"; exportMessage.value = "";
  history.replaceState(null, "", `${location.pathname}${location.search}#datasets`);
}

async function loadDatasetOperations(dataset: string) {
  try {
    const [collectionData, auditData] = await Promise.all([
      requestJson(`/api/datasets/${encodeURIComponent(dataset)}/collections`),
      requestJson(`/api/datasets/${encodeURIComponent(dataset)}/audit`),
    ]);
    collections.value = collectionData.collections || [];
    auditEntries.value = auditData.entries || [];
  } catch (cause) {
    collections.value = []; auditEntries.value = [];
    if (selectedDataset.value?.name === dataset) {
      error.value = `数据集操作记录加载失败: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
}

function selectEpisode(item: Episode) {
  videos.value = []; videoErrors.clear(); playing.value = false; currentTime.value = 0; videoDuration.value = 0; selectedEpisode.value = item;
  edit.status = item.review.status || "unreviewed"; edit.tags = (item.review.tags || []).join(", "); edit.notes = item.review.notes || "";
  edit.assignee = item.review.assignee || ""; edit.reviewer = item.review.reviewer || ""; savedMessage.value = "";
}
const playbackBusy = computed(() => ["preparing", "playing", "stopping"].includes(playbackState.value));
async function loadPlaybackStatus() {
  try {
    const data = await requestJson("/api/playback/status");
    playbackState.value = data.state; playbackFrame.value = data.frame || 0; playbackFrames.value = data.frames || 0;
  } catch { /* status is optional while the robot server is offline */ }
}
async function togglePlayback() {
  if (!selectedDataset.value || !selectedEpisode.value) return;
  try {
    const stopping = playbackBusy.value;
    const data = await requestJson(stopping ? "/api/playback/stop" : "/api/playback/start", stopping ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset: selectedDataset.value.name, episode: selectedEpisode.value.episode, speed: playbackSpeed.value }) });
    playbackState.value = data.state; playbackFrame.value = data.frame || 0; playbackFrames.value = data.frames || 0;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
function toggleSelected(episode: number) { selectedIds.has(episode) ? selectedIds.delete(episode) : selectedIds.add(episode); }
function toggleAllFiltered() { if (allFilteredSelected.value) filteredEpisodes.value.forEach((item) => selectedIds.delete(item.episode)); else filteredEpisodes.value.forEach((item) => selectedIds.add(item.episode)); }
function setVideoRef(element: unknown, index: number) { if (element instanceof HTMLVideoElement) videos.value[index] = element; }
function peers(index: number) { return videos.value.filter((_, peer) => peer !== index); }
async function syncPlay(index: number) { playing.value = true; if (!syncEnabled.value || syncing) return; syncing = true; for (const video of peers(index)) { video.currentTime = videos.value[index].currentTime; await video.play().catch(() => undefined); } syncing = false; }
function syncPause(index: number) { playing.value = false; if (syncEnabled.value && !syncing) peers(index).forEach((video) => video.pause()); }
function syncSeek(index: number) { if (syncEnabled.value && !syncing) peers(index).forEach((video) => { video.currentTime = videos.value[index].currentTime; }); }
function syncTime(index: number) { currentTime.value = videos.value[index]?.currentTime || 0; if (!syncEnabled.value || syncing || !videos.value[index] || videos.value[index].paused) return; for (const video of peers(index)) if (Math.abs(video.currentTime - videos.value[index].currentTime) > .12) video.currentTime = videos.value[index].currentTime; }
function readVideoDuration() { videoDuration.value = Math.max(videoDuration.value, ...videos.value.map((video) => video.duration || 0)); }
function seekVideo(value: number) { currentTime.value = value; videos.value.forEach((video) => { video.currentTime = value; }); }
async function toggleVideoPlayback() { if (playing.value) videos.value.forEach((video) => video.pause()); else { for (const video of videos.value) await video.play().catch(() => undefined); } }
function stepVideo(direction: number) { const step = 1 / Math.max(1, selectedDataset.value?.fps || 30); seekVideo(Math.max(0, Math.min(videoDuration.value, currentTime.value + direction * step))); }
function onVideoEnded() { playing.value = false; }
function formatPlaybackTime(value: number) { const seconds = Math.max(0, value); return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor(seconds * 10) % 10)}`; }

function updateReview(episode: number, review: Review) {
  const target = episodes.value.find((item) => item.episode === episode);
  if (!target || !selectedDataset.value) return;
  const previous = target.review.status;
  target.review = review;
  if (previous !== review.status) {
    selectedDataset.value.reviews[previous] = Math.max(0, selectedDataset.value.reviews[previous] - 1);
    selectedDataset.value.reviews[review.status] += 1;
  }
}

async function exportApprovedDataset() {
  if (!selectedDataset.value || approvedCount.value === 0) return;
  exporting.value = true;
  try {
    const source = selectedDataset.value.name;
    const target = `${source}_approved`;
    const data = await requestJson(`/api/datasets/${encodeURIComponent(source)}/export-reviewed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, refreshExisting: true, episodes: episodes.value.filter((item) => item.review.status === "approved").map((item) => item.episode), actor: edit.reviewer }),
    });
    const exported = data.dataset;
    exportMessage.value = `已自动更新数据集 ${exported.dataset}：${exported.episodes.length} 个通过片段、${exported.frames} 帧`;
    await loadDatasets(true);
  } catch (cause) {
    exportMessage.value = `审核已保存，但自动生成数据集失败：${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    exporting.value = false;
  }
}

async function saveReview() {
  if (!selectedDataset.value || !selectedEpisode.value || saving.value) return;
  saving.value = true; savedMessage.value = "";
  try {
    const episode = selectedEpisode.value.episode;
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/episodes/${episode}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: edit.status, tags: tagsFrom(edit.tags), notes: edit.notes, assignee: edit.assignee, reviewer: edit.reviewer, qualityFlags: selectedEpisode.value.review.qualityFlags || [] }) });
    updateReview(episode, data.review); selectedEpisode.value.review = data.review; savedMessage.value = "已保存并记录审计";
    if (data.review.status === "approved") await exportApprovedDataset();
  } catch (cause) { savedMessage.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

// 采集分类常见问题；点选后写入标签，配合「标记问题并拒绝」快速筛掉不可用数据。
const problemTags = ["视频缺失/卡顿", "画面模糊", "轨迹抖动", "任务未完成", "抓取失败", "碰撞风险", "重复采集", "光照异常"];
function toggleQuickTag(tag: string) {
  const list = tagsFrom(edit.tags);
  edit.tags = (list.includes(tag) ? list.filter((item) => item !== tag) : [...list, tag]).join(", ");
}
async function rejectWithTags() {
  edit.status = "rejected";
  await saveReview();
}

async function saveBatch() {
  if (!selectedDataset.value || !selectedIds.size || saving.value) return;
  saving.value = true; savedMessage.value = "";
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/reviews/batch`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodes: [...selectedIds], status: batch.status, tags: tagsFrom(batch.tags), appendTags: true, keepExisting: true, reviewer: edit.reviewer }) });
    Object.entries(data.reviews as Record<string, Review>).forEach(([episode, review]) => updateReview(Number(episode), review));
    if (selectedEpisode.value && data.reviews[String(selectedEpisode.value.episode)]) selectEpisode(selectedEpisode.value);
    selectedIds.clear(); batch.tags = ""; savedMessage.value = `已批量更新 ${data.count} 项`;
    if (batch.status === "approved") await exportApprovedDataset();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

async function publishCollection() {
  if (!selectedDataset.value || !collectionName.value.trim() || saving.value) return;
  saving.value = true; error.value = null;
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/collections`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: collectionName.value, episodes: episodes.value.filter((item) => item.review.status === "approved").map((item) => item.episode), actor: edit.reviewer }),
    });
    collections.value.unshift(data.collection); collectionName.value = "";
    const auditData = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/audit`);
    auditEntries.value = auditData.entries || [];
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

async function exportReviewed() {
  if (!selectedDataset.value || exporting.value) return;
  exporting.value = true; error.value = null; exportMessage.value = "";
  try {
    const data = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/export-reviewed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: exportTarget.value.trim() || `${selectedDataset.value.name}_approved`,
        episodes: episodes.value.filter((item) => item.review.status === "approved").map((item) => item.episode),
        actor: edit.reviewer,
      }),
    });
    const exported = data.dataset;
    exportTarget.value = "";
    exportMessage.value = `已导出 ${exported.episodes.length} 个片段、${exported.frames} 帧到数据集 ${exported.dataset}`;
    try {
      const auditData = await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/audit`);
      auditEntries.value = auditData.entries || [];
    } catch { /* 审计刷新失败不影响导出结果 */ }
    await loadDatasets(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { exporting.value = false; }
}

function openDeleteDataset(item: DatasetSummary) {
  deleteTarget.value = item;
}
function closeDeleteDialog() {
  if (deleting.value) return;
  deleteTarget.value = null;
}
async function deleteDataset() {
  if (!deleteTarget.value || deleting.value) return;
  deleting.value = true; error.value = null;
  const name = deleteTarget.value.name;
  try {
    await requestJson(`/api/datasets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (selectedDataset.value?.name === name) closeDataset();
    deleteTarget.value = null;
    await loadDatasets(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { deleting.value = false; }
}
async function deleteEpisode() {
  if (!selectedDataset.value || !selectedEpisode.value || deletingEpisode.value) return;
  const dataset = selectedDataset.value.name;
  const episode = selectedEpisode.value.episode;
  if (!window.confirm(`删除片段 #${String(episode).padStart(3, "0")}？原始文件会移入回收目录。`)) return;
  deletingEpisode.value = true; error.value = null;
  try {
    await requestJson(`/api/datasets/${encodeURIComponent(dataset)}/episodes/${episode}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: edit.reviewer }) });
    await loadDatasets(true);
    const refreshed = datasets.value.find((item) => item.name === dataset);
    if (refreshed) await selectDataset(refreshed); else closeDataset();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { deletingEpisode.value = false; }
}
async function deleteCollection(item: TrainingCollection) {
  if (!selectedDataset.value || saving.value || !window.confirm(`删除数据选集 ${item.id} · ${item.name}？原始数据不会被删除。`)) return;
  saving.value = true; error.value = null;
  try {
    await requestJson(`/api/datasets/${encodeURIComponent(selectedDataset.value.name)}/collections/${encodeURIComponent(item.id)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: edit.reviewer }),
    });
    await loadDatasetOperations(selectedDataset.value.name);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}

function datasetFromHash(): string | null {
  if (!location.hash.startsWith("#datasets/")) return null;
  try { return decodeURIComponent(location.hash.slice("#datasets/".length)); }
  catch { return null; }
}

function writeDatasetHash(name: string) {
  history.replaceState(null, "", `${location.pathname}${location.search}#datasets/${encodeURIComponent(name)}`);
}

async function openDatasetFromHash() {
  const name = datasetFromHash();
  if (!name) return;
  const dataset = datasets.value.find((item) => item.name === name);
  if (dataset && selectedDataset.value?.name !== dataset.name) await selectDataset(dataset);
  if (dataset && selectedDataset.value?.name === dataset.name) dataSection.value = "viewer";
}

function onHashChange() {
  if (location.hash === "#datasets" && selectedDataset.value) { closeDataset(); return; }
  void openDatasetFromHash();
}

onMounted(async () => {
  void loadPlaybackStatus(); playbackTimer = window.setInterval(loadPlaybackStatus, 500);
  await loadDatasets();
  await openDatasetFromHash();
  window.addEventListener("hashchange", onHashChange);
});
onUnmounted(() => { window.removeEventListener("hashchange", onHashChange); if (playbackTimer !== null) window.clearInterval(playbackTimer); });
</script>

<style scoped>
.review-export { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px; border: 1px solid #e5e5ea; border-radius: 8px; background: #f7f8f8; font-size: 11px; color: #5f6468; }
.review-export strong { color: #1f8a5b; font-variant-numeric: tabular-nums; }
.review-export input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid #d8dade; border-radius: 999px; background: #fff; color: #3e4245; font-size: 11px; }
.review-export button { height: 32px; padding: 0 14px; border: 0; border-radius: 999px; background: #007aff; color: #fff; font-size: 11px; cursor: pointer; }
.review-export button:disabled { background: #dfe1e2; color: #9b9ea1; cursor: not-allowed; }
.review-export-message { margin: -4px 0 12px; color: #1f8a5b; font-size: 11px; }
.quick-tags { display: grid; gap: 6px; margin: 2px 0 8px; }
.quick-tags > span { color: #85898c; font-size: 10px; }
.quick-tags > div { display: flex; flex-wrap: wrap; gap: 5px; }
.quick-tags button { padding: 4px 9px; border: 1px solid #d8dade; border-radius: 999px; background: #fff; color: #5f6368; font-size: 10px; cursor: pointer; }
.quick-tags button.active { border-color: #e86676; background: #fdeff1; color: #c23c43; }
.save-row .reject-quick { border: 1px solid #f0c9cb; background: #fff; color: #c13d43; }
.episode-tags { max-width: 110px; overflow: hidden; color: #c13d43; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.review-placeholder { padding: 26px 20px; border: 1px dashed #e0e2e3; border-radius: 10px; background: #fafbfb; color: #6d7276; font-size: 12px; }
.review-placeholder strong { display: block; margin-bottom: 10px; color: #34373a; font-size: 14px; }
.review-placeholder p { margin: 0 0 6px; line-height: 1.7; }
.workspace { container-type: inline-size; max-width: 1900px; margin: 0 auto; padding: 18px 24px 28px; }
.workspace-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }.workspace-head h2 { margin-top: 2px; font-size: 20px; }.eyebrow { color: #78a9c6; font-size: 9px; font-weight: 700; letter-spacing: 1px; }
.icon-button { width: 32px; height: 32px; border: 1px solid #315574; border-radius: 5px; background: #102941; color: #8dd4f4; cursor: pointer; font-size: 18px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid rgba(151,188,222,.15); border-bottom: 0; background: #0b1724; }.kpis div { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 3px 10px; min-width: 0; padding: 11px 14px; border-right: 1px solid rgba(151,188,222,.12); }.kpis div:last-child { border-right: 0; }.kpis small { color: #7890a3; font-size: 9px; }.kpis strong { grid-row: 1 / span 2; grid-column: 2; color: #e7f1f7; font: 22px ui-monospace, monospace; }.kpis strong.alert { color: #ff9aa7; }.kpis span { color: #587185; font-size: 9px; }
.workspace-error { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; padding: 8px 11px; border-left: 3px solid #ff7384; background: #25141b; color: #ffadb7; font-size: 11px; }.workspace-error button { border: 0; border-radius: 4px; padding: 5px 9px; background: #713040; color: white; cursor: pointer; }
.catalog-skeleton,.dataset-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }.catalog-skeleton { padding-top: 14px; }.catalog-skeleton i { min-height: 190px; border: 1px solid rgba(151,188,222,.1); border-radius: 10px; background: linear-gradient(100deg,#0d1a28 30%,#142a3c 48%,#0d1a28 66%); background-size: 220% 100%; animation: catalog-shimmer 1.25s linear infinite; }
@keyframes catalog-shimmer { to { background-position-x: -220%; } }
.catalog-view { min-height: calc(100vh - 190px); border: 1px solid rgba(151,188,222,.15); border-radius: 10px; background: rgba(10,22,35,.72); }.catalog-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 17px; border-bottom: 1px solid rgba(151,188,222,.12); }.catalog-heading > div { display: grid; gap: 3px; }.catalog-heading strong { font-size: 13px; }.catalog-heading small { max-width: 600px; overflow: hidden; color: #607b90; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.catalog-heading label { display: flex; align-items: center; gap: 7px; width: min(310px,40vw); padding: 0 10px; border: 1px solid #29435f; border-radius: 6px; background: #091522; color: #688195; }.catalog-heading input { width: 100%; padding: 9px 0; border: 0; outline: 0; background: transparent; color: #e7edf8; font-size: 10px; }
.dataset-grid { padding: 16px; }.dataset-card { display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; min-height: 190px; padding: 16px; border: 1px solid rgba(151,188,222,.14); border-radius: 9px; text-align: left; cursor: pointer; background: linear-gradient(145deg,rgba(18,39,57,.95),rgba(10,22,34,.95)); color: #dce8f2; transition: border-color .16s,transform .16s,box-shadow .16s; }.dataset-card:hover { transform: translateY(-2px); border-color: rgba(100,201,232,.5); box-shadow: 0 12px 28px rgba(0,0,0,.2); }.card-icon { grid-row: 1/span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 7px; background: #173d55; color: #77cce9; font-size: 17px; }.card-title { overflow: hidden; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.card-type { color: #6f899c; font-size: 9px; }.card-stats { grid-column: 1/-1; display: flex; align-items: baseline; gap: 5px; margin-top: 10px; color: #718b9e; font-size: 9px; }.card-stats b { color: #d8e8f2; font: 16px ui-monospace,monospace; }.card-stats i { width: 1px; height: 13px; margin: 0 5px; background: #2a4153; }.card-tags { grid-column: 1/-1; display: flex; gap: 5px; }.card-tags em { padding: 3px 6px; border-radius: 4px; background: #122b3d; color: #7fa4b9; font-size: 8px; font-style: normal; }.dataset-card .review-meter { grid-column: 1/-1; align-self: end; }.card-foot { grid-column: 1/-1; display: flex; align-items: center; justify-content: space-between; margin-top: 3px; }.card-foot small { color: #607b90; font-size: 8px; }.card-foot b { color: #72cbe9; font-size: 9px; }
.dataset-context { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 13px; padding: 11px 14px; border: 1px solid rgba(151,188,222,.15); border-bottom: 0; background: #0b1724; }.dataset-context button { padding: 7px 9px; border: 1px solid #29435f; border-radius: 5px; cursor: pointer; background: #10263a; color: #8dbbd2; font-size: 9px; }.dataset-context div { display: grid; gap: 2px; }.dataset-context strong { font-size: 12px; }.dataset-context small { color: #668196; font-size: 8px; }.dataset-context > span { color: #62c995; font-size: 9px; }.dataset-context > span.loading { color: #e6bd67; }
.data-layout { display: grid; grid-template-columns: 335px minmax(500px, 1fr); min-height: calc(100vh - 245px); border: 1px solid rgba(151,188,222,.15); background: #0d1928; }.episode-list { min-width: 0; border-right: 1px solid rgba(151,188,222,.13); }
.pane-title { display: flex; flex-direction: column; justify-content: center; min-height: 54px; padding: 9px 12px; border-bottom: 1px solid rgba(151,188,222,.13); }.pane-title strong { font-size: 11px; }.pane-title small { overflow: hidden; margin-top: 3px; color: #647f94; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.episode-title { flex-direction: row; align-items: center; justify-content: space-between; }
.dataset-row { position: relative; display: grid; gap: 5px; width: 100%; padding: 12px; border: 0; border-bottom: 1px solid rgba(151,188,222,.08); text-align: left; cursor: pointer; background: transparent; color: #dce8f2; }.dataset-row:hover,.dataset-row.selected { background: #14283b; }.dataset-row.selected::before,.episode-row.active::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: #66c8e8; }.dataset-name { overflow: hidden; font-size: 11px; font-weight: 650; text-overflow: ellipsis; }.dataset-meta,.dataset-time { color: #738da1; font-size: 8px; }.review-meter { display: flex; height: 3px; overflow: hidden; background: #263545; }.review-meter i.approved { background: #54c994; }.review-meter i.rejected { background: #e86676; }
.episode-tools { display: grid; gap: 6px; padding: 8px; border-bottom: 1px solid rgba(151,188,222,.1); }.search { display: flex; align-items: center; gap: 5px; padding: 0 7px; border: 1px solid #29435f; border-radius: 4px; background: #091522; color: #688195; }.search input { min-width: 0; width: 100%; padding: 7px 0; border: 0; outline: 0; background: transparent; color: #e7edf8; font-size: 10px; }.tool-row { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 4px; } select,.batch-bar input { min-width: 0; padding: 6px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #101f2e; color: #a8bdcc; font-size: 9px; }.select-all { display: flex; align-items: center; gap: 6px; color: #7890a3; font-size: 9px; }
.batch-bar { display: grid; grid-template-columns: auto 75px minmax(70px,1fr) auto 25px; align-items: center; gap: 5px; padding: 7px 8px; border-bottom: 1px solid #315574; background: #142c40; color: #b8d3e5; font-size: 9px; }.batch-bar button { padding: 6px 9px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.batch-bar .clear { padding: 3px; background: transparent; color: #91a9bb; font-size: 16px; }
.episode-scroll { max-height: calc(100vh - 365px); overflow: auto; }.episode-loading,.no-results { display: grid; place-items: center; min-height: 140px; color: #71899c; font-size: 10px; }.episode-row { position: relative; display: grid; grid-template-columns: 28px minmax(0,1fr); align-items: center; border-bottom: 1px solid rgba(151,188,222,.08); }.episode-row:hover,.episode-row.active { background: #14283b; }.episode-row > input { grid-column: 1; justify-self: center; }.episode-row > button { grid-column: 1 / -1; display: grid; grid-template-columns: 34px 42px minmax(0,1fr) auto auto; align-items: center; gap: 8px; min-width: 0; padding: 10px 10px 10px 0; border: 0; text-align: left; cursor: pointer; background: transparent; color: #dce8f2; }.episode-row > button.with-checkbox { grid-column: 2 / -1; }.episode-index { font: 10px ui-monospace, monospace; }.episode-duration { color: #8197aa; font: 9px ui-monospace, monospace; }.episode-task { min-width: 0; overflow: hidden; color: #9fb1c0; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.review-state,.quality-state { width: fit-content; padding: 2px 5px; border-radius: 3px; color: #8ba0b0; background: #253443; font-size: 8px; white-space: nowrap; }.review-state.approved { color: #65daa4; background: #173a31; }.review-state.rejected,.quality-state.issue { color: #ff91a0; background: #3a2028; }
.review-pane { min-width: 0; padding: 14px; overflow: hidden; }.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 10px; }.review-head h3 { max-width: 650px; margin-top: 3px; overflow-wrap: anywhere; font-size: 14px; }.episode-facts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }.episode-facts span { padding: 4px 6px; border-radius: 4px; background: #152638; color: #89a1b4; font: 9px ui-monospace, monospace; }
.detail-skeleton { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }.detail-skeleton i { height: 34px; border-radius: 5px; background: linear-gradient(100deg,#102030 30%,#1a3347 48%,#102030 66%); background-size: 220% 100%; animation: catalog-shimmer 1.25s linear infinite; }.detail-skeleton .wide { grid-column: 1/-1; }.detail-skeleton .video { height: auto; aspect-ratio: 16/9; }
.detail-tabs { display: flex; gap: 3px; margin: -4px 0 12px; border-bottom: 1px solid rgba(151,188,222,.13); }.detail-tabs button { position: relative; padding: 8px 10px; border: 0; cursor: pointer; background: transparent; color: #71899c; font-size: 9px; }.detail-tabs button.active { color: #dff5ff; }.detail-tabs button.active::after { content: ""; position: absolute; right: 8px; bottom: -1px; left: 8px; height: 2px; background: #64c9e8; }.detail-tabs span { margin-left: 3px; color: #5e849b; }
.quality-panel { display: grid; grid-template-columns: auto auto 1fr; align-items: center; gap: 5px 14px; margin-bottom: 10px; padding: 8px 10px; border-left: 3px solid #4fbd8b; background: #10251f; }.quality-panel.warning { border-color: #e66d7c; background: #27181e; }.quality-panel div { display: flex; align-items: baseline; gap: 7px; }.quality-panel small,.quality-panel span,.quality-panel p,.quality-panel li { color: #8199a9; font-size: 9px; }.quality-panel strong { font: 13px ui-monospace,monospace; }.quality-panel ul { display: flex; gap: 12px; margin: 0; padding: 0; list-style: none; }.quality-panel p { margin: 0; }
.videos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.videos.single { grid-template-columns: minmax(280px,720px); }.video-channel { min-width: 0; background: #05090e; }.video-channel video { display: block; width: 100%; aspect-ratio: 16/9; background: #000; }.video-channel span,.video-channel small { display: block; padding: 5px 7px; color: #7892a6; font-size: 9px; }.video-channel small { color: #ff91a0; }.video-missing { grid-column: 1/-1; display: grid; place-items: center; min-height: 220px; color: #61798c; background: #080f18; font-size: 11px; }
.review-editor { display: grid; gap: 8px; margin-top: 11px; padding-top: 11px; border-top: 1px solid rgba(151,188,222,.13); }.editor-heading { display: flex; align-items: center; justify-content: space-between; }.editor-heading strong { font-size: 11px; }.editor-heading label { display: flex; align-items: center; gap: 5px; color: #8197aa; font-size: 9px; }.status-control { display: grid; grid-template-columns: repeat(3,1fr); gap: 4px; }.status-control button { padding: 7px; border: 1px solid #29435f; border-radius: 4px; cursor: pointer; background: transparent; color: #8095a6; font-size: 9px; }.status-control button.active { background: #294050; color: white; }.status-control button.approved.active { background: #24684f; }.status-control button.rejected.active { background: #793746; }.review-editor > label,.people-fields label { display: grid; gap: 4px; color: #8ca2b3; font-size: 9px; }.people-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.review-editor input,.review-editor textarea { width: 100%; padding: 7px; resize: vertical; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #091522; color: #e7edf8; font: 10px/1.5 inherit; }.review-meta { color: #647d90; font-size: 8px; }.save-row { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-height: 31px; color: #69d7a3; font-size: 9px; }.save-row button { padding: 7px 13px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-weight: 650; }.empty { display: grid; place-items: center; min-height: 240px; color: #667f92; }
.collections-pane > header,.audit-pane > header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }.collections-pane h3,.audit-pane h3 { margin-top: 3px; font-size: 15px; }.collections-pane > header > span,.audit-pane > header > span { color: #7890a3; font-size: 9px; }.publish-box { display: grid; grid-template-columns: minmax(180px,1fr) auto; align-items: end; gap: 8px; padding: 12px; border: 1px solid #28425a; background: #0a1622; }.publish-box label { display: grid; gap: 5px; color: #8ca2b3; font-size: 9px; }.publish-box input { min-width: 0; padding: 8px; border: 1px solid #29435f; border-radius: 4px; outline: 0; background: #101f2e; color: #e7edf8; font-size: 10px; }.publish-box button { height: 33px; padding: 0 12px; border: 0; border-radius: 4px; cursor: pointer; background: #64c9e8; color: #07131c; font-size: 9px; font-weight: 650; }.publish-box button:disabled { cursor: not-allowed; opacity: .45; }.publish-box p { grid-column: 1/-1; margin: 0; color: #60798c; font-size: 8px; }.collection-list,.audit-list { margin-top: 10px; border-top: 1px solid rgba(151,188,222,.12); }.collection-list article { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 7px 12px; padding: 11px 5px; border-bottom: 1px solid rgba(151,188,222,.1); }.collection-list article div { display: grid; gap: 3px; }.collection-list strong { font-size: 10px; }.collection-list small,.collection-list p { color: #6f879a; font-size: 8px; }.collection-list p { grid-column: 1/-1; margin: 0; }.collection-list a { color: #77cce9; font-size: 9px; text-decoration: none; }.published { padding: 2px 5px; border-radius: 3px; background: #173a31; color: #65daa4; font-size: 8px; }.audit-list article { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 5px 9px; padding: 10px 5px; border-bottom: 1px solid rgba(151,188,222,.1); }.audit-list strong,.audit-list time { color: #8299aa; font-size: 8px; }.audit-list time { font-family: ui-monospace,monospace; }.audit-list p { grid-column: 2/-1; margin: 0; color: #b3c5d1; font-size: 9px; }.audit-action { padding: 3px 5px; border-radius: 3px; background: #173148; color: #8acfea; font-size: 8px; }
@container (max-width: 1150px) { .catalog-skeleton,.dataset-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.data-layout { grid-template-columns: 300px minmax(300px,1fr); }.episode-scroll { max-height: 360px; } }
@container (max-width: 720px) { .workspace { padding: 10px; }.kpis { grid-template-columns: 1fr 1fr; }.kpis div:nth-child(2) { border-right: 0; }.kpis div:nth-child(-n+2) { border-bottom: 1px solid rgba(151,188,222,.12); }.catalog-heading { align-items: stretch; flex-direction: column; }.catalog-heading label { width: 100%; }.catalog-skeleton,.dataset-grid { grid-template-columns: 1fr; }.dataset-context { grid-template-columns: auto 1fr; }.dataset-context > span { grid-column: 2; }.data-layout { display: block; }.episode-list { max-height: none; border-right: 0; border-bottom: 1px solid rgba(151,188,222,.13); }.episode-scroll { max-height: 300px; }.review-pane { padding: 10px; }.review-head { flex-direction: column; }.episode-facts { justify-content: flex-start; }.videos { grid-template-columns: 1fr; }.quality-panel { grid-template-columns: 1fr auto; }.quality-panel ul,.quality-panel p { grid-column: 1/-1; }.batch-bar { grid-template-columns: auto 75px 1fr auto 25px; }.publish-box { grid-template-columns: 1fr; }.publish-box p { grid-column: 1; } }
@container (max-width: 440px) { .kpis strong { font-size: 18px; }.tool-row { grid-template-columns: 1fr 1fr; }.tool-row select:last-child { grid-column: 1/-1; }.batch-bar { grid-template-columns: 1fr 1fr; }.batch-bar input { grid-column: 1/-1; }.batch-bar .clear { position: absolute; right: 15px; }.people-fields { grid-template-columns: 1fr; } }

/* Black data studio theme */
.workspace-head { margin-bottom:16px; }.workspace-head h2 { margin-top:3px;font-size:24px;letter-spacing:-.5px; }.workspace-head > div > span { display:block;margin-top:5px;color:#71717a;font-size:10px; }.eyebrow { color:#9b87f5;letter-spacing:1.4px; }
.icon-button { width:auto;height:34px;padding:0 13px;border-color:#303030;border-radius:7px;background:#121212;color:#d4d4d8;font-size:10px; }
.kpis,.dataset-context { border-color:#242424;background:#0d0d0d; }.kpis div { border-color:#222; }.catalog-view { border-color:#222;background:#0a0a0a; }
.catalog-heading,.episode-list,.pane-title,.detail-tabs { border-color:#242424; }.catalog-heading label,.search { border-color:#303030;background:#0d0d0d; }
.dataset-card { position:relative;display:block;min-height:190px;padding:0;border-color:#262626;border-radius:11px;background:linear-gradient(145deg,#121212,#0c0c0c);color:#f4f4f5;overflow:hidden; }
.dataset-card:hover { border-color:#51458d;box-shadow:0 16px 36px rgba(0,0,0,.38); }.card-open { display:grid;grid-template-columns:auto 1fr;gap:5px 10px;width:100%;min-height:190px;padding:16px;border:0;text-align:left;cursor:pointer;background:transparent;color:inherit; }
.card-delete { position:absolute;top:10px;right:9px;width:30px;height:25px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:#717579;cursor:pointer;letter-spacing:1px; }.card-delete:hover { border-color:#efc8cb;background:#fff4f5;color:#c23e45; }
.card-icon { background:#211d35;color:#ae9cff;font:700 13px ui-monospace,monospace; }.card-tags em { border:1px solid #292929;background:#171717;color:#a1a1aa; }
.context-actions { display:flex!important;align-items:center;gap:10px!important; }.context-actions span { color:#3a8463;font-size:9px; }.context-actions span.loading { color:#9a701f; }.danger-button { border-color:#efc8cb!important;background:#fff!important;color:#c23e45!important; }
.data-layout { border-color:#242424;background:#0b0b0b; }.episode-row:hover,.episode-row.active { background:#16141c; }.review-pane,.publish-box { background:#0b0b0b; }.review-editor input,.review-editor textarea,select,.batch-bar input,.publish-box input { border-color:#303030;background:#111;color:#e4e4e7; }
.collection-list article { grid-template-columns:1fr auto auto auto; }.collection-delete { padding:4px 7px;border:1px solid #efc8cb;border-radius:4px;background:#fff;color:#c23e45;cursor:pointer;font-size:8px; }.collection-delete:hover { background:#fff4f5; }
.confirm-backdrop { position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:20px;background:rgba(22,25,29,.48);backdrop-filter:blur(3px); }
.confirm-dialog { display:grid;grid-template-columns:38px 1fr;gap:15px;width:min(480px,100%);padding:22px;border:1px solid #dedfe0;border-radius:7px;background:#fff;box-shadow:0 18px 55px rgba(0,0,0,.2); }
.danger-mark { display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:#fff0f1;color:#c23e45;font-weight:800; }.confirm-dialog h3 { margin-top:3px;color:#303235;font-size:18px; }.confirm-dialog > p,.confirm-dialog > label,.confirm-actions { grid-column:1/-1; }.confirm-dialog > p { color:#696e72;font-size:11px;line-height:1.6; }.confirm-dialog > p strong { color:#303235; }.confirm-dialog label { display:grid;gap:7px;color:#62676b;font-size:10px; }.confirm-dialog input { padding:10px;border:1px solid #d5d8da;border-radius:5px;outline:0;background:#fff;color:#303235; }.confirm-dialog input:focus { border-color:#c23e45;box-shadow:0 0 0 3px rgba(194,62,69,.1); }
.confirm-actions { display:flex;justify-content:flex-end;gap:8px;margin-top:3px; }.confirm-actions button { padding:8px 13px;border:1px solid #d5d8da;border-radius:5px;background:#fff;color:#4d5256;cursor:pointer; }.confirm-actions button:hover:not(:disabled) { background:#f5f6f6; }.confirm-actions .confirm-delete { border-color:#c23e45;background:#c23e45;color:#fff; }.confirm-actions .confirm-delete:hover:not(:disabled) { background:#ad333b; }.confirm-actions button:disabled { opacity:.35;cursor:not-allowed; }

/* Table-first data manager. The detail reviewer below remains available from each row. */
.workspace { max-width:none; padding:22px 36px 28px; background:#f5f6f6; color:#323437; }
.manager-view { overflow:hidden; border:1px solid #dedfe0; border-radius:7px; background:#fff; box-shadow:0 1px 2px rgba(20,25,27,.04); }
.project-tabs { display:flex; align-items:center; gap:24px; min-height:56px; padding:0 18px; border-bottom:1px solid #e2e3e4; white-space:nowrap; overflow-x:auto; }
.project-tabs > span:first-child { color:#666a6d; font-size:12px; }.project-tabs button { align-self:stretch; border:0; border-bottom:2px solid transparent; padding:0 3px; background:transparent; color:#686c6f; font-size:13px; cursor:pointer; }.project-tabs button.active { border-color:#0d0e10; color:#0d0e10; font-weight:700; }
.catalog-root { margin-left:auto; overflow:hidden; color:#9a9da0; font-size:10px; text-overflow:ellipsis; }
.manager-tools { display:flex; align-items:center; gap:10px; padding:18px; border-bottom:1px solid #e5e6e7; }.manager-tools label { min-width:155px; }.manager-tools input,.manager-tools select { width:100%; height:36px; padding:0 10px; border:1px solid #d8dade; border-radius:5px; outline:0; background:#fff; color:#45484b; font-size:12px; }.manager-tools input:focus,.manager-tools select:focus { border-color:#34373a; box-shadow:0 0 0 3px rgba(13,14,16,.08); }
.search-button,.text-button,.filter-chip { height:36px; padding:0 14px; border-radius:5px; cursor:pointer; font-size:12px; font-weight:650; }.search-button { border:1px solid #0d0e10; background:#0d0e10; color:#fff; }.text-button { border:0; background:transparent; color:#8c9093; }.tool-spacer { flex:1; }.filter-chip { border:1px solid #d9dbdd; background:#f5f6f6; color:#62666a; }
.manager-selection { display:flex; align-items:center; gap:12px; padding:8px 18px; border-bottom:1px solid #e3e4e5; background:#f3f4f4; color:#0d0e10; font-size:12px; }.manager-selection button { border:0; background:transparent; color:#62666a; cursor:pointer; text-decoration:underline; }
.data-table-wrap { overflow:auto; }.data-table { width:100%; min-width:950px; border-collapse:collapse; text-align:left; font-size:12px; }.data-table th { height:48px; padding:0 12px; border-bottom:1px solid #dfe1e2; color:#565a5d; font-weight:700; white-space:nowrap; }.data-table td { height:62px; padding:8px 12px; border-bottom:1px solid #e7e8e8; color:#55595c; vertical-align:middle; }.data-table tbody tr:hover { background:#f8f9f9; }.data-table th:first-child,.data-table td:first-child { width:42px; padding-right:0; text-align:center; }.data-table input[type="checkbox"] { width:18px; height:18px; accent-color:#0d0e10; }.dataset-link { display:block; max-width:260px; overflow:hidden; padding:0; border:0; background:transparent; color:#0d0e10; cursor:pointer; font:inherit; font-weight:650; text-align:left; text-overflow:ellipsis; white-space:nowrap; }.data-table td small { display:block; margin-top:4px; color:#9b9ea1; font-size:10px; }.project-tag { display:inline-block; padding:5px 9px; border-radius:14px; background:#f0f1f1; color:#565a5d; font-size:11px; }.review-pill { display:inline-block; padding:5px 8px; border-radius:12px; font-size:10px; white-space:nowrap; }.review-pill.pending { background:#f0f1f1; color:#777b7e; }.review-pill.partial { background:#fff3d9; color:#9a701f; }.review-pill.reviewed { background:#e6f6ed; color:#3d8a65; }.row-action { border:0; background:transparent; color:#0d0e10; cursor:pointer; font-size:12px; font-weight:650; }.row-action span { margin-left:4px; font-size:17px; vertical-align:-1px; }.row-menu { margin-left:8px; border:0; background:transparent; color:#888c8f; cursor:pointer; letter-spacing:1px; }.no-results { padding:30px!important; color:#92969a!important; text-align:center; }
.manager-footer { display:flex; align-items:center; gap:26px; min-height:52px; padding:0 18px; color:#818589; font-size:11px; }.manager-footer div { display:flex; align-items:center; gap:10px; margin-left:auto; }.manager-footer button { width:25px; height:25px; border:0; background:transparent; color:#a1a4a7; font-size:18px; }.manager-footer strong { display:grid; place-items:center; width:25px; height:25px; border-radius:4px; background:#0d0e10; color:#fff; }
.manager-actions { display:flex; align-items:center; gap:29px; min-height:70px; padding:0 24px; border-top:1px solid #e4e5e6; background:#fff; }.manager-actions button { display:grid; grid-template-columns:auto; justify-items:center; gap:4px; min-width:40px; border:0; background:transparent; color:#65696c; cursor:pointer; font-size:21px; }.manager-actions button span { font-size:10px; }.manager-actions button:disabled { color:#c3c6c8; cursor:default; }
@container (max-width:900px) { .workspace { padding:14px; }.manager-tools { flex-wrap:wrap; }.manager-tools label { flex:1 1 145px; }.tool-spacer { display:none; }.project-tabs { gap:17px; }.catalog-root { display:none; } }
@container (max-width:520px) { .workspace { padding:8px; }.manager-tools { gap:7px; padding:12px; }.manager-tools label { min-width:100%; }.filter-chip { display:none; }.manager-footer { gap:10px; padding:0 12px; }.manager-footer > span:nth-child(2) { display:none; } }

/* Detail view uses the same white data-table surface as the catalog. */
.dataset-context,.data-layout,.episode-list,.review-pane,.publish-box { background:#fff; border-color:#dedfe0; color:#34373a; }.dataset-context button,.review-editor input,.review-editor textarea,.publish-box input,.batch-bar input,.episode-tools select,.batch-bar select { border-color:#d8dade; background:#fff; color:#3e4245; }.dataset-context small,.pane-title small,.episode-row small,.review-meta { color:#85898c; }.episode-row:hover,.episode-row.active,.job-row.active { background:#f8f9f9; }.review-pane { border-left:1px solid #e4e5e6; }.detail-tabs { border-color:#e1e2e3; }.detail-tabs button { color:#777b7e; }.detail-tabs button.active { border-color:#0d0e10; color:#0d0e10; }.detail-tabs button.active::after { background:#0d0e10; }.quality-panel { background:#f2faf6; border-color:#4ba77d; }.quality-panel.warning { background:#fff6e8; border-color:#db9b45; }.videos .video-channel { background:#f3f4f4; }.video-missing { background:#f4f5f5; color:#8c9093; }.review-editor { border-color:#e2e3e4; }.status-control button { border-color:#d7d9da; color:#62666a; }.status-control button.active { background:#f0f1f1; color:#0d0e10; }.status-control button.approved.active { background:#e8f6ee; color:#32825d; }.status-control button.rejected.active { background:#fff0f1; color:#bd3c42; }.save-row button,.publish-box button { background:#0d0e10; color:#fff; }.collection-list article,.audit-list article { border-color:#e5e6e7; }.collection-list strong,.audit-list strong { color:#424649; }

/* Dataset detail: a compact local-review tool, not a dashboard. */
.dataset-context { grid-template-columns:auto minmax(0,1fr) auto; margin-bottom:12px; padding:13px 15px; border:1px solid #dedfe0; border-radius:7px; }.dataset-context > button { padding:7px 0; border:0; color:#0d0e10; background:transparent; font-size:12px; }.dataset-context strong { color:#303235; font-size:14px; }.dataset-context small { margin-top:4px; font-size:11px; }.context-actions .danger-button { padding:6px 9px!important; border:1px solid #f0c9cb!important; border-radius:5px!important; background:#fff!important; color:#c13d43!important; }.data-layout { min-height:620px; border:1px solid #dedfe0; border-radius:7px; overflow:hidden; }.episode-list { border-right:1px solid #e3e4e5; }.pane-title { min-height:52px; padding:12px 14px; border-bottom:1px solid #e5e6e7; background:#fafbfb; }.pane-title strong { color:#36393c; font-size:13px; }.episode-tools { padding:10px; border-bottom:1px solid #e6e7e8; background:#fff; }.search { border-color:#d9dbdd; background:#fff; }.search input { color:#45494c; }.tool-row select { border-color:#d9dbdd; background:#fff; color:#62666a; }.select-all { color:#74787b; }.episode-row { border-color:#e7e8e9; }.episode-row > button { color:#3e4245; }.episode-index { color:#0d0e10; }.episode-duration,.episode-task { color:#686d70; }.review-state,.quality-state { border-radius:10px; background:#f0f1f1; color:#74787b; }.review-state.approved { background:#e8f6ee; color:#34815e; }.quality-state.issue { background:#fff1ef; color:#bb5546; }.detail-tabs { margin:0 -14px 16px; padding:0 14px; background:#fafbfb; }.detail-tabs button { padding:12px 10px; font-size:12px; }.review-head h3 { color:#34373a; font-size:15px; }.review-head .eyebrow { color:#818589; letter-spacing:0; }.episode-facts span { border:0; border-radius:0; background:transparent; color:#74787b; font-size:11px; }.quality-panel { border-left-width:3px; border-radius:0; }.quality-panel small,.quality-panel span,.quality-panel p,.quality-panel li { color:#617067; font-size:10px; }.quality-panel strong { color:#327b5a; }.videos { border:1px solid #e0e2e3; }.video-missing { min-height:210px; }.review-editor { padding-top:15px; }.editor-heading strong { color:#3b3f42; font-size:13px; }.editor-heading label { color:#777b7e; }.review-editor > label,.people-fields label { color:#64686b; font-size:11px; }.review-editor input,.review-editor textarea { padding:8px; font-size:12px; }.save-row { justify-content:space-between; }.save-row button { padding:8px 14px; border-radius:5px; }

/* The data area is a workspace: browsing, reviewing and publishing are separate tasks. */
.data-platform { display:grid; grid-template-columns:188px minmax(0,1fr); gap:20px; align-items:start; }
.data-sidebar { position:sticky; top:84px; overflow:hidden; border:1px solid #dedfe0; border-radius:7px; background:#fff; }
.data-sidebar-title { padding:17px 16px 15px; border-bottom:1px solid #e4e5e6; }.data-sidebar-title strong { color:#333639; font-size:14px; }
.data-sidebar nav { display:grid; gap:2px; padding:8px; }.data-sidebar nav button { display:flex; align-items:center; gap:10px; min-height:37px; width:100%; padding:0 9px; border:0; border-radius:4px; background:transparent; color:#666a6d; cursor:pointer; font-size:12px; text-align:left; }.data-sidebar nav button:hover { background:#f5f7fa; color:#0d0e10; }.data-sidebar nav button.active { background:#f0f1f1; color:#0d0e10; font-weight:700; }.data-sidebar nav button > span { width:16px; color:#8391a4; font:15px/1 ui-monospace,monospace; text-align:center; }.data-sidebar nav button.active > span { color:#0d0e10; }.data-sidebar nav i { margin-left:auto; min-width:18px; padding:2px 5px; border-radius:10px; background:#fff0d8; color:#9b6f1d; font-size:9px; font-style:normal; text-align:center; }
.data-sidebar-foot { display:flex; align-items:center; justify-content:space-between; padding:11px 14px; border-top:1px solid #e8e9ea; color:#9a9da0; font-size:10px; }.data-sidebar-foot button { width:25px; height:25px; border:0; border-radius:4px; background:transparent; color:#666a6d; cursor:pointer; font-size:17px; }.data-sidebar-foot button:hover { background:#f0f1f1; }
.data-content { min-width:0; }.section-empty { display:grid; place-items:center; min-height:360px; border:1px dashed #d6d8da; border-radius:7px; color:#8b8f92; font-size:12px; background:#fff; }.section-empty.no-dataset { margin:0; }
@container (max-width:900px) { .data-platform { grid-template-columns:1fr; gap:12px; }.data-sidebar { position:static; }.data-sidebar nav { display:flex; overflow-x:auto; padding:7px; }.data-sidebar nav button { flex:0 0 auto; width:auto; padding:0 10px; }.data-sidebar-title { display:none; }.data-sidebar-foot { display:none; } }

/* Playback keeps the recorded frame as large as the review pane allows. */
.videos { grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); align-items:start; gap:10px; padding:14px; border:0; background:#f7f8f8; }.videos.single { grid-template-columns:minmax(280px,900px); justify-content:center; }.video-channel { min-width:0; overflow:hidden; border:1px solid #e0e2e3; border-radius:6px; background:#fff; }.video-channel video { display:block; width:100%; max-height:520px; aspect-ratio:16/9; background:#101112; object-fit:contain; }.video-channel span,.video-channel small { display:block; padding:7px 9px; color:#5f6468; font-size:11px; }.video-channel small { color:#c23c43; }.video-missing { grid-column:1/-1; display:grid; place-items:center; min-height:220px; border:1px dashed #d5d8da; border-radius:6px; color:#8b8f92; background:#fff; font-size:11px; }
.playback-button { padding:5px 8px; border:1px solid #0d0e10; border-radius:4px; background:#0d0e10; color:#fff; cursor:pointer; font-size:10px; }.playback-button:disabled { cursor:wait; opacity:.55; }
.episode-delete-button { padding:5px 8px; border:1px solid #d34b55; border-radius:4px; background:#fff; color:#b3343d; cursor:pointer; font-size:10px; }.episode-delete-button:disabled { cursor:wait; opacity:.55; }
.playback-toolbar { display:flex; align-items:center; gap:7px; padding:9px 10px; border:1px solid #e0e2e3; border-bottom:0; background:#fafbfb; }.playback-icon { display:grid; place-items:center; width:27px; height:27px; padding:0; border:1px solid #d6d8da; border-radius:4px; background:#fff; color:#242628; cursor:pointer; font-size:13px; }.playback-icon:hover { background:#f0f1f1; }.playback-time { min-width:82px; color:#63686b; font:10px ui-monospace,monospace; }.playback-scrubber { flex:1; min-width:80px; accent-color:#0d0e10; }.playback-loop { display:flex; align-items:center; gap:4px; color:#73777a; font-size:10px; white-space:nowrap; }

/* Episode list rows: card-style items, monochrome theme. */
.episode-list { background: #f7f8f8; }
.episode-scroll { display: grid; gap: 8px; padding: 10px; }
.episode-row { border: 1px solid #e7e8e9; border-radius: 8px; background: #fff; transition: border-color .15s, box-shadow .15s, background .15s; }
.episode-row:hover { border-color: #d0d3d6; background: #fcfcfc; box-shadow: 0 2px 6px rgba(22, 27, 29, .05); }
.episode-row.active { border-color: #0d0e10; background: #fff; box-shadow: 0 2px 8px rgba(22, 27, 29, .08); }
.episode-row.active::before { content: none; }
.episode-row > button { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "index task state" "meta meta quality"; gap: 5px 10px; padding: 11px 13px; }
.episode-row > button.with-checkbox { padding-left: 6px; }
.episode-index { grid-area: index; align-self: start; padding: 2px 7px; border-radius: 5px; background: #0d0e10; color: #fff; font: 700 10px/1.6 ui-monospace, monospace; letter-spacing: .5px; }
.episode-task { grid-area: task; overflow: hidden; color: #24262a; font-size: 12.5px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.episode-duration { grid-area: meta; color: #8b8f92; font: 10px/1.5 ui-monospace, monospace; }
.episode-duration::before { content: "⏱ "; }
.review-state { grid-area: state; align-self: start; }
.quality-state { grid-area: quality; justify-self: end; }
.review-state, .quality-state { width: fit-content; padding: 3px 9px; border-radius: 10px; font-size: 10px; font-weight: 600; white-space: nowrap; }
.review-state.unreviewed { background: #f0f1f1; color: #74787b; }
.review-state.approved { background: #e8f6ee; color: #34815e; }
.review-state.rejected { background: #fff0f1; color: #bd3c42; }
.quality-state { background: #f3f4f4; color: #62666a; }
.quality-state.issue { background: #fff1ef; color: #bb5546; }

/* The review videos form one continuous comparison surface. */
.videos { gap:0; padding:0; border:0; background:#f7f8f8; }
.video-channel { overflow:hidden; border:0; border-right:1px solid #e0e2e3; border-radius:0; }
.video-channel:last-of-type { border-right:0; }
.playback-icon.el-button { width:28px; height:28px; margin:0; color:#303438; }
.playback-icon.el-button:hover { background:#eceeef; }
.playback-icon :deep(.el-icon) { font-size:14px; }
@container (max-width:720px) { .video-channel { border-right:0; border-bottom:1px solid #e0e2e3; } .video-channel:last-of-type { border-bottom:0; } }

/* Dataset catalog migrated from 数据.html. */
.reference-dataset-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; padding:16px; border:1px solid var(--dcp-line); border-radius:var(--dcp-radius, 1.2rem); background:var(--dcp-surface); box-shadow:var(--dcp-shadow-1); }
.reference-dataset-filters { display:flex; flex:1; flex-wrap:wrap; align-items:center; gap:10px; }
.reference-search { display:flex; flex:1 1 230px; align-items:center; gap:8px; max-width:360px; height:40px; padding:0 13px; border:1px solid var(--dcp-line); border-radius:999px; color:var(--dcp-ink-3); }
.reference-search input { width:100%; height:100%; padding:0; border:0 !important; outline:0; box-shadow:none !important; background:transparent !important; }
.reference-dataset-filters select { height:36px; min-width:125px; padding:0 30px 0 12px; border-radius:999px !important; }
.reference-dataset-actions { display:flex; align-items:center; gap:12px; color:var(--dcp-ink-3); font-size:12px; white-space:nowrap; }
.create-dataset-button { height:36px; padding:0 16px; border:0; border-radius:999px !important; background:var(--dcp-primary); color:#fff; cursor:pointer; font-size:13px; font-weight:600; }
.reference-dataset-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.reference-dataset-card { padding:16px; border:1px solid var(--dcp-line); border-radius:var(--dcp-radius, 1.2rem); background:var(--dcp-surface); box-shadow:var(--dcp-shadow-1); transition:box-shadow .15s,transform .15s; }
.reference-dataset-card:hover { transform:translateY(-2px); box-shadow:var(--dcp-shadow-2); }
.reference-card-heading,.reference-card-quality,.reference-card-footer { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.reference-card-heading h3 { margin:0; overflow:hidden; color:var(--dcp-ink); font-size:16px; font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
.reference-card-heading p { margin:3px 0 0; color:var(--dcp-ink-3); font-size:12px; }
.reference-status { display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:999px; font-size:11px; font-weight:600; white-space:nowrap; }
.reference-status i { width:6px; height:6px; border-radius:50%; background:currentColor; }.reference-status.pending { color:#b87300; background:rgba(255,149,0,.12); }.reference-status.approved { color:#248a3d; background:rgba(52,199,89,.12); }.reference-status.rejected { color:#c41c14; background:rgba(255,59,48,.12); }
.reference-card-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:18px 0; text-align:center; }
.reference-card-stats div { padding:9px 4px; border-radius:.8rem; background:var(--dcp-surface-2); }.reference-card-stats strong { display:block; color:var(--dcp-ink); font-size:16px; }.reference-card-stats span { display:block; margin-top:2px; color:var(--dcp-ink-3); font-size:10px; }
.reference-card-quality { align-items:center; margin-bottom:15px; color:var(--dcp-ink-3); font-size:11px; }.reference-quality-ring { position:relative; display:grid; place-items:center; width:40px; height:40px; border-radius:50%; }.reference-quality-ring::after { content:""; position:absolute; inset:4px; border-radius:50%; background:var(--dcp-surface); }.reference-quality-ring span { position:relative; z-index:1; font-size:10px; font-weight:600; color:var(--dcp-primary); }.reference-card-quality time { margin-left:auto; text-align:right; font-size:10px; font-style:normal; }.reference-card-quality time b { color:var(--dcp-ink-2); font:10px var(--dcp-font-mono); }
.reference-card-footer { align-items:center; padding-top:12px; border-top:1px solid var(--dcp-line); }.reference-view-button { display:flex; flex:1; align-items:center; justify-content:center; gap:6px; height:36px; border:0; border-radius:999px !important; background:var(--dcp-primary); color:#fff; cursor:pointer; font-size:13px; font-weight:600; }.reference-delete-button { width:36px; height:36px; border:1px solid var(--dcp-line); border-radius:999px !important; background:var(--dcp-surface); color:var(--dcp-state-error); cursor:pointer; }
.reference-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:260px; border:1px solid var(--dcp-line); border-radius:var(--dcp-radius, 1.2rem); background:var(--dcp-surface); color:var(--dcp-ink-3); }.reference-empty > span { font-size:34px; }.reference-empty strong { margin-top:12px; color:var(--dcp-ink-2); font-size:14px; }.reference-empty small { margin-top:3px; font-size:12px; }
@container (max-width:900px) { .reference-dataset-toolbar { align-items:stretch; flex-direction:column; }.reference-dataset-actions { justify-content:space-between; }.reference-dataset-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@container (max-width:560px) { .reference-dataset-grid { grid-template-columns:1fr; }.reference-dataset-filters select { flex:1 1 130px; }.reference-search { max-width:none; } }
</style>
