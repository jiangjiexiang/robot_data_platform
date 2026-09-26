<template>
  <main class="clip-page">
    <section class="clip-toolbar">
      <div>
        <select v-model="datasetName" aria-label="选择数据集" @change="loadDataset"><option value="">选择数据集</option><option v-for="item in datasets" :key="item.name" :value="item.name">{{ item.name }}</option></select>
        <select v-model.number="episodeIndex" aria-label="选择采集片段" @change="selectEpisode"><option v-for="item in episodes" :key="item.episode" :value="item.episode">片段 {{ String(item.episode).padStart(3,"0") }}</option></select>
        <button class="play-button" :disabled="!videos.length || Boolean(videoError)" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">{{ playing ? "Ⅱ" : "▶" }}</button>
        <strong>{{ timeText(currentTime) }} / {{ timeText(duration) }}</strong>
      </div>
      <div><label>缩放<input v-model.number="zoom" type="range" min="1" max="3" step=".1" /></label><button class="export-button" :disabled="!selectedEpisode || !duration || exporting" @click="exportClip">{{ exporting ? "正在导出…" : "✂ 导出裁剪 ROS bag" }}</button><small v-if="exportError" class="export-error">{{ exportError }}</small></div>
    </section>

    <div v-if="loading" class="clip-loading">正在读取录制数据…</div>
    <div v-else class="clip-layout">
      <section class="viewer-card">
        <div v-if="videos.length" class="video-grid" :style="{ '--zoom': zoom }">
          <div v-for="(item,index) in videos" :key="item.name" :class="{ primary:index===0 }"><video :ref="el => setVideo(el,index)" :src="item.url" muted playsinline preload="metadata" @loadedmetadata="readDuration" @timeupdate="syncTime(index)" @play="playing=true" @pause="playing=false" @error="markVideoError(index)"></video><span>{{ cameraLabel(item.name,index) }}</span></div>
        </div>
        <div v-if="videoError" class="video-error">{{ videoError }}<button @click="retryEpisode">重新加载</button></div>
        <div v-else-if="!videos.length" class="video-empty">该片段暂无可预览的视频</div>

        <div class="timeline-area">
          <header><h2>时间轴</h2><span>{{ timeText(trimStart) }} - {{ timeText(trimEnd) }}</span></header>
          <div class="range-pair">
            <div class="selected-range" :style="rangeStyle"></div>
            <input v-model.number="trimStart" type="range" min="0" :max="Math.max(duration,.01)" step=".01" aria-label="裁剪入点" @input="normalizeTrim('start')" />
            <input v-model.number="trimEnd" type="range" min="0" :max="Math.max(duration,.01)" step=".01" aria-label="裁剪出点" @input="normalizeTrim('end')" />
          </div>
          <input class="scrubber" type="range" min="0" :max="Math.max(duration,.01)" step=".01" :value="currentTime" aria-label="播放进度" @input="seek(Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="preview-strip"><h3>▤ 视频预览 <small v-if="thumbnailLoading">正在生成缩略图…</small></h3><div v-if="videos.length"><button v-for="index in 8" :key="index" :class="{ active: previewActive(index) }" :disabled="!duration" :aria-label="`跳转到 ${timeText(previewTime(index))}`" @click="seek(previewTime(index))"><span :style="{ backgroundImage: thumbnailUrls[index - 1] ? `url(${thumbnailUrls[index - 1]})` : undefined }"></span><small>{{ timeText(previewTime(index)) }}</small></button></div><p v-else class="preview-placeholder">加载片段后显示视频缩略图</p></div>
      </section>

      <aside class="clip-sidebar">
        <h2>片段信息</h2>
        <dl><div><dt>录制名称</dt><dd>{{ datasetName || "-" }}</dd></div><div><dt>片段</dt><dd>#{{ String(selectedEpisode?.episode ?? 0).padStart(3,"0") }}</dd></div><div><dt>原始时长</dt><dd>{{ timeText(duration) }}</dd></div><div><dt>裁剪区间</dt><dd class="blue">{{ timeText(trimStart) }} - {{ timeText(trimEnd) }}</dd></div><div><dt>选中时长</dt><dd>{{ timeText(Math.max(0,trimEnd-trimStart)) }}</dd></div></dl>
        <section><h3>片段列表</h3><button v-for="item in episodes" :key="item.episode" :class="{ active:item.episode===episodeIndex }" @click="episodeIndex=item.episode;selectEpisode()"><span>▤ Clip {{ String(item.episode).padStart(2,"0") }}</span><small>{{ item.frames || 0 }} 帧</small></button></section>
        <section><h3>Joint State</h3><div v-for="([name,value],index) in jointRows" :key="name" class="joint"><p><span>{{ name }}</span><b>{{ Number(value).toFixed(2) }}</b></p><i><span :style="{ width:`${Math.max(3,Math.min(100,50+Number(value)*12))}%` }"></span></i></div><p v-if="!jointRows.length" class="joint-empty">暂无关节状态</p></section>
      </aside>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

type Dataset = { name:string; recordingType?:"lerobot"|"rosbag2" };
type Episode = { episode:number; frames?:number; videos?:Record<string,string> };
const props = defineProps<{ joints:Record<string,number>|null }>();
const datasets=ref<Dataset[]>([]), episodes=ref<Episode[]>([]), datasetName=ref(""), episodeIndex=ref(0), loading=ref(false);
const selectedEpisode=ref<Episode|null>(null), videos=ref<{name:string;url:string}[]>([]), videoEls=ref<HTMLVideoElement[]>([]);
const playing=ref(false), currentTime=ref(0), duration=ref(0), trimStart=ref(0), trimEnd=ref(0), zoom=ref(1);
const thumbnailUrls=ref<string[]>([]), thumbnailLoading=ref(false), videoError=ref(""), exporting=ref(false), exportError=ref("");
let episodeRequest=0;
let thumbnailSource="";
const recordedJointSamples=ref<{time:number;values:Record<string,number>}[]>([]);
const jointRows=computed(()=>Object.entries(recordedJointSamples.value.length ? (recordedJointSamples.value.reduce((best,sample)=>Math.abs(sample.time-currentTime.value)<Math.abs(best.time-currentTime.value)?sample:best).values) : (props.joints||{})).slice(0,6));
const rangeStyle=computed(()=>({left:`${duration.value ? trimStart.value/duration.value*100:0}%`,right:`${duration.value ? 100-trimEnd.value/duration.value*100:100}%`}));

async function json(url:string, init?:RequestInit){const response=await fetch(url,init);const data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||"读取失败");return data;}
async function loadDatasets(){try{const data=await json("/api/datasets");datasets.value=data.datasets||[];if(datasets.value.length){datasetName.value=datasets.value[0].name;await loadDataset();}}catch{datasets.value=[];}}
async function loadDataset(){if(!datasetName.value)return;loading.value=true;try{const data=await json(`/api/datasets/${encodeURIComponent(datasetName.value)}`);episodes.value=data.episodes||[];if(episodes.value.length){episodeIndex.value=episodes.value[0].episode;await selectEpisode();}else{await selectEpisode();}}finally{loading.value=false;}}
async function selectEpisode(){const requestId=++episodeRequest;videoEls.value.forEach(v=>v.pause());videoEls.value=[];selectedEpisode.value=episodes.value.find(item=>item.episode===episodeIndex.value)||null;videos.value=Object.entries(selectedEpisode.value?.videos||{}).slice(0,3).map(([name,url])=>({name,url}));currentTime.value=0;duration.value=0;trimStart.value=0;trimEnd.value=0;playing.value=false;recordedJointSamples.value=[];thumbnailUrls.value=[];thumbnailLoading.value=false;thumbnailSource="";videoError.value="";exportError.value="";if(selectedEpisode.value){try{const data=await json(`/api/datasets/${encodeURIComponent(datasetName.value)}/episodes/${selectedEpisode.value.episode}/joints`);if(requestId===episodeRequest) recordedJointSamples.value=Array.isArray(data.samples)?data.samples:[];}catch{if(requestId===episodeRequest) recordedJointSamples.value=[];}}}
function setVideo(value:unknown,index:number){if(value instanceof HTMLVideoElement)videoEls.value[index]=value;}
function readDuration(){duration.value=Math.max(0,...videoEls.value.map(v=>Number.isFinite(v.duration)?v.duration:0));if(!trimEnd.value)trimEnd.value=duration.value;const source=videoEls.value[0];if(source?.currentSrc&&source.currentSrc!==thumbnailSource&&duration.value>0){thumbnailSource=source.currentSrc;void generateThumbnails(source.currentSrc,episodeRequest);}}
function markVideoError(index:number){videoError.value=`${cameraLabel(videos.value[index]?.name||"",index)} 视频加载失败，请检查机器人服务或重新转换视频`;
}
function retryEpisode(){void selectEpisode();}
function previewTime(index:number){return duration.value?duration.value*(index-1)/8:0;}
function previewActive(index:number){const start=previewTime(index);const end=index===8?duration.value+0.001:previewTime(index+1);return duration.value>0&&currentTime.value>=start&&currentTime.value<end;}
function seekMedia(video:HTMLVideoElement,time:number):Promise<void>{return new Promise((resolve,reject)=>{if(Math.abs(video.currentTime-time)<0.01){resolve();return;}const timeout=window.setTimeout(()=>{cleanup();reject(new Error("视频定位超时"));},5000);const cleanup=()=>{window.clearTimeout(timeout);video.removeEventListener("seeked",onSeeked);video.removeEventListener("error",onError);};const onSeeked=()=>{cleanup();resolve();};const onError=()=>{cleanup();reject(new Error("视频读取失败"));};video.addEventListener("seeked",onSeeked,{once:true});video.addEventListener("error",onError,{once:true});video.currentTime=time;});}
async function generateThumbnails(sourceUrl:string,requestId:number){thumbnailLoading.value=true;const source=document.createElement("video");source.muted=true;source.playsInline=true;source.preload="auto";source.crossOrigin="anonymous";source.src=sourceUrl;try{await new Promise<void>((resolve,reject)=>{if(source.readyState>=1){resolve();return;}const timeout=window.setTimeout(()=>{cleanup();reject(new Error("视频元数据读取超时"));},8000);const cleanup=()=>{window.clearTimeout(timeout);source.removeEventListener("loadedmetadata",onLoaded);source.removeEventListener("error",onError);};const onLoaded=()=>{cleanup();resolve();};const onError=()=>{cleanup();reject(new Error("视频读取失败"));};source.addEventListener("loadedmetadata",onLoaded,{once:true});source.addEventListener("error",onError,{once:true});});const canvas=document.createElement("canvas");const width=Math.min(source.videoWidth||320,320);const height=Math.max(1,Math.round(width*(source.videoHeight||180)/(source.videoWidth||320)));canvas.width=width;canvas.height=height;const context=canvas.getContext("2d");if(!context)throw new Error("浏览器不支持视频缩略图");const images:string[]=[];for(let index=0;index<8;index+=1){if(requestId!==episodeRequest) return;await seekMedia(source,duration.value*index/8);context.drawImage(source,0,0,width,height);images.push(canvas.toDataURL("image/jpeg",0.72));}if(requestId===episodeRequest)thumbnailUrls.value=images;}catch{if(requestId===episodeRequest)thumbnailUrls.value=[];}finally{source.removeAttribute("src");source.load();if(requestId===episodeRequest)thumbnailLoading.value=false;}}
async function togglePlay(){if(playing.value){videoEls.value.forEach(v=>v.pause());return;}for(const video of videoEls.value){video.currentTime=currentTime.value;await video.play().catch(()=>undefined);}}
function syncTime(index:number){const source=videoEls.value[index];if(!source)return;currentTime.value=source.currentTime;if(!source.paused)videoEls.value.forEach((video,i)=>{if(i!==index&&Math.abs(video.currentTime-source.currentTime)>.15)video.currentTime=source.currentTime;});}
function seek(value:number){currentTime.value=value;videoEls.value.forEach(video=>{video.currentTime=value;});}
function normalizeTrim(changed:"start"|"end"){if(changed==="start"&&trimStart.value>trimEnd.value)trimStart.value=trimEnd.value;if(changed==="end"&&trimEnd.value<trimStart.value)trimEnd.value=trimStart.value;seek(changed==="start"?trimStart.value:trimEnd.value);}
function timeText(value:number){const seconds=Math.max(0,Math.floor(value||0));return `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;}
function cameraLabel(name:string,index:number){return name.split(".").pop()?.replace("camera","摄像头 ")||`摄像头 ${index+1}`;}
async function exportClip(){
  if(!selectedEpisode.value || !duration.value || exporting.value) return;
  exporting.value=true;exportError.value="";
  try { const data = await json(`/api/datasets/${encodeURIComponent(datasetName.value)}/episodes/${selectedEpisode.value.episode}/clip`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({start:trimStart.value,end:trimEnd.value}),
  });
  if (Array.isArray(data.videos) && data.videos.length) {
    videos.value = data.videos;
    videoEls.value = [];
    currentTime.value = 0;
    duration.value = 0;
    trimStart.value = 0;
    trimEnd.value = 0;
    thumbnailUrls.value = [];
    thumbnailLoading.value = false;
    thumbnailSource = "";
    videoError.value = "";
  }
  const anchor=document.createElement("a"); anchor.href=data.bagUrl; anchor.download=`${datasetName.value}-episode-${selectedEpisode.value.episode}-clip.mcap`; anchor.click();
  } catch (cause) { exportError.value=cause instanceof Error?cause.message:String(cause); } finally { exporting.value=false; }
}
onMounted(()=>{void loadDatasets();});
onUnmounted(()=>{episodeRequest+=1;videoEls.value.forEach(video=>video.pause());});
</script>

<style scoped>
.clip-page{width:min(1280px,calc(100% - 48px));margin:auto;padding:32px 0 44px;color:#1d1d1f}.clip-title{margin-bottom:24px}.clip-title p{margin:0 0 4px;color:#8e8e93;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.clip-title h1{margin:0;font-size:30px}.clip-title>span{display:block;margin-top:6px;color:#48484a;font-size:14px}.clip-toolbar,.viewer-card,.clip-sidebar,.clip-loading{border:1px solid #e5e5ea;border-radius:19px;background:#fff}.clip-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;padding:12px 20px}.clip-toolbar>div{display:flex;align-items:center;gap:10px}.clip-toolbar select{height:36px;padding:0 10px;border:1px solid #d1d1d6;border-radius:999px;background:#fff}.clip-toolbar button{height:36px;border:0;border-radius:999px;cursor:pointer}.play-button{width:36px;color:#fff;background:#007aff}.clip-toolbar strong{color:#48484a;font-size:13px;font-variant-numeric:tabular-nums}.clip-toolbar label{display:flex;align-items:center;gap:8px;color:#8e8e93;font-size:11px}.export-button{padding:0 16px;color:#fff;background:#007aff}.export-error{max-width:220px;color:#d93843;font-size:11px}.clip-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px}.viewer-card{padding:20px}.video-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;overflow:hidden}.video-grid>div{position:relative;aspect-ratio:16/9;overflow:hidden;border-radius:13px;background:#000}.video-grid>div.primary{grid-column:1/-1}.video-grid video{width:100%;height:100%;object-fit:contain;transform:scale(var(--zoom));transition:transform .15s}.video-grid>div>span{position:absolute;left:12px;top:12px;padding:5px 8px;border-radius:6px;color:#fff;background:rgba(0,0,0,.55);font-size:11px}.video-empty,.video-error{display:grid;place-items:center;min-height:400px;border-radius:13px;color:#8e8e93;background:#f2f2f7}.video-error{gap:10px;color:#c62835;background:#fff4f5}.video-error button{padding:7px 12px;border:0;border-radius:8px;color:#fff;background:#c62835;cursor:pointer}.timeline-area{margin-top:20px}.timeline-area header{display:flex;justify-content:space-between;align-items:center}.timeline-area h2{font-size:14px}.timeline-area header span{color:#8e8e93;font-size:11px}.range-pair{position:relative;height:42px;margin-top:10px;border-radius:9px;background:#f2f2f7}.selected-range{position:absolute;top:0;bottom:0;background:rgba(0,122,255,.16);border-block:2px solid #007aff}.range-pair input{position:absolute;inset:0;width:100%;margin:0;pointer-events:none;appearance:none;background:transparent}.range-pair input::-webkit-slider-thumb{width:14px;height:28px;border:2px solid #007aff;border-radius:6px;background:#fff;appearance:none;pointer-events:auto}.scrubber{width:100%;margin-top:12px;accent-color:#007aff}.preview-strip{margin-top:16px;padding:12px;border:1px solid #e5e5ea;border-radius:13px}.preview-strip h3{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:13px}.preview-strip h3 small{color:#8e8e93;font-size:10px;font-weight:400}.preview-strip>div{display:flex;gap:7px;overflow:auto}.preview-strip button{flex:1;min-width:62px;padding:3px;border:2px solid transparent;border-radius:9px;background:#f2f2f7}.preview-strip button:disabled{cursor:wait;opacity:.7}.preview-strip button.active{border-color:#007aff}.preview-strip button span{display:block;aspect-ratio:16/9;border-radius:5px;background:linear-gradient(135deg,#d1d1d6,#f2f2f7);background-position:center;background-size:cover}.preview-strip small{color:#8e8e93}.preview-placeholder{margin:0;padding:18px;color:#8e8e93;text-align:center}.clip-sidebar{height:max-content;padding:22px}.clip-sidebar h2{margin:0 0 18px;font-size:16px}.clip-sidebar dl{display:grid;gap:13px;margin:0}.clip-sidebar dl div{display:flex;justify-content:space-between;gap:15px;font-size:12px}.clip-sidebar dt{color:#8e8e93}.clip-sidebar dd{margin:0;text-align:right}.clip-sidebar .blue{color:#007aff}.clip-sidebar section{margin-top:22px;padding-top:18px;border-top:1px solid #e5e5ea}.clip-sidebar h3{margin:0 0 12px;font-size:13px}.clip-sidebar section>button{display:flex;justify-content:space-between;width:100%;margin-bottom:6px;padding:10px;border:1px solid #e5e5ea;border-radius:10px;background:#fff}.clip-sidebar section>button.active{border-color:#007aff;background:rgba(0,122,255,.08)}.clip-sidebar button small{color:#8e8e93}.joint{margin-top:11px}.joint p{display:flex;justify-content:space-between;margin:0 0 5px;font-size:11px}.joint p span{color:#48484a}.joint p b{font-family:ui-monospace,monospace}.joint>i{display:block;height:5px;overflow:hidden;border-radius:9px;background:#e5e5ea}.joint>i span{display:block;height:100%;border-radius:inherit;background:#007aff}.joint-empty,.clip-loading{padding:60px;color:#8e8e93;text-align:center}.clip-loading{min-height:360px}
/* Keep the primary camera compact enough that the trim controls remain above the fold.
   The tile stays 16/9 like the source video so object-fit:contain shows the full frame. */
.video-grid>div.primary { aspect-ratio: 16 / 9; max-height: 300px; }
.video-empty { min-height: 320px; }
@media(max-width:860px){.clip-page{width:calc(100% - 28px);padding-top:24px}.clip-layout{grid-template-columns:1fr}.clip-toolbar{align-items:flex-start;flex-direction:column}.clip-toolbar>div{flex-wrap:wrap}.video-grid{grid-template-columns:1fr}.video-grid>div.primary{grid-column:auto;aspect-ratio:16 / 9;max-height:220px}}
</style>
