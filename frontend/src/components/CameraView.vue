<template>
  <div class="camera-view-root">
    <div class="view-heading">
      <div>
        <p class="kicker">{{ kicker }}</p>
        <h2>{{ title }}</h2>
      </div>
      <div class="view-status">
        <el-tag size="small" effect="light" :type="hasImage ? 'success' : 'info'">{{ hasImage ? liveText : waitText }}</el-tag>
      </div>
    </div>
    <div class="video-box">
      <!-- Keep the WebRTC element mounted so it can start in the background.  Until
           it has actually produced a frame, retain the JPEG stream as the display. -->
      <video ref="videoElement" :class="{ hidden: !showVideo }" autoplay muted playsinline @playing="videoPlaying = true" @waiting="videoPlaying = false" @emptied="videoPlaying = false"></video>
      <img v-if="frame || fallbackSrc" :class="{ hidden: showVideo }" :src="frame || fallbackSrc" :alt="title" @load="fallbackLoaded = true" @error="fallbackLoaded = false" />
      <span v-else-if="!showVideo" class="placeholder">{{ placeholder }}<small>{{ hint }}</small></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  frame: string | null;
  stream?: MediaStream | null;
  fallbackSrc?: string;
  kicker?: string;
  title?: string;
  placeholder?: string;
  hint?: string;
  liveText?: string;
  waitText?: string;
  latencyMs?: number | null;
}>(), {
  kicker: "实时镜像",
  title: "实时画面",
  placeholder: "等待遥操作画面…",
  hint: "启动后将在这里实时显示从臂姿态",
  liveText: "实时",
  waitText: "等待",
  latencyMs: null,
});

const fallbackLoaded = ref(false);
const videoElement = ref<HTMLVideoElement | null>(null);
const videoPlaying = ref(false);
const hasImage = computed(() => videoPlaying.value || Boolean(props.frame) || fallbackLoaded.value);
const showVideo = computed(() => videoPlaying.value && props.stream?.getVideoTracks().some((track) => track.readyState === "live") === true);

function formatLatency(value: number | null): string {
  return value === null ? "--" : `${value} 毫秒`;
}

watch(() => props.stream, async (stream) => {
  videoPlaying.value = false;
  await nextTick();
  if (videoElement.value) {
    videoElement.value.srcObject = stream || null;
    if (stream) void videoElement.value.play().catch(() => undefined);
  }
}, { immediate: true });

onUnmounted(() => {
  if (videoElement.value) videoElement.value.srcObject = null;
});
</script>

<style scoped>
.camera-view-root { min-width: 0; container-type: inline-size; }
.view-heading { display: flex; align-items: center; justify-content: space-between; margin: 0 0 9px; }
.kicker { color: #85878a; font-size: 11px; font-weight: 650; letter-spacing: 0; }
h2 { margin-top: 2px; color: #292b2e; font-size: 14px; letter-spacing: 0; }
.view-status { display: flex; align-items: center; gap: 4px; min-width: 0; }
.view-status :deep(.el-tag) { border-radius: 4px; font: 10px ui-monospace, monospace; }
.latency, .live { color: #989b9e; font-family: ui-monospace, monospace; font-size: 10px; letter-spacing: 0; white-space: nowrap; }
.latency { color: #5f7b72; }
.latency.pending { color: #989b9e; }
.video-box {
  background: #eff1f1;
  border: 1px solid #e0e2e2;
  border-radius: 5px;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  min-width: 0;
  aspect-ratio: 16 / 9;
  position: relative;
}
.video-box img, .video-box video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.video-box .hidden { display: none; }
.placeholder {
  color: #777b7e;
  font-size: 14px;
  text-align: center;
}
.placeholder small { display: block; margin-top: 8px; color: #9a9da0; font-size: 12px; }

@container (max-width: 300px) {
  .view-heading { align-items: flex-end; margin-bottom: 7px; }
  .kicker { display: none; }
  h2 { margin-top: 0; font-size: 12px; }
  .view-status { gap: 3px; }
  .latency, .live { font-size: 8px; }
  .video-box { border-radius: 6px; }
  .placeholder { padding: 6px; font-size: 9px; }
  .placeholder small { display: none; }
}

@container (max-width: 190px) {
  h2 { font-size: 10px; }
  .latency { font-size: 0; }
  .latency::before { content: "延迟"; font-size: 8px; }
  .live { font-size: 0; }
}
</style>
