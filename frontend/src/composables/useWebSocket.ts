import { ref, onMounted, onUnmounted } from "vue";

export type JointData = Record<string, number>;

export interface WSMessage {
  type: string;
  leader?: JointData;
  follower?: JointData;
  running?: boolean;
  data?: string;
  ts?: number;
  error?: string | null;
  [key: string]: unknown;
}

export interface DebugMetrics {
  controlFps: number;
  controlLatency: number | null;
  cameraFps: number;
  cameraLatency: number | null;
  cameraDropped: number;
  camera2Fps: number;
  camera2Latency: number | null;
  camera2Dropped: number;
  camera3Fps: number;
  camera3Latency: number | null;
  camera3Dropped: number;
  camera4Fps: number;
  camera4Latency: number | null;
  averageCameraLatency: number | null;
  camera4Dropped: number;
  streamConnected: boolean;
  rtcConnected: boolean;
  rtcStatus: "connecting" | "connected" | "disabled" | "failed" | "fallback";
}

export interface RecordingStatus {
  state: "idle" | "preparing" | "recording" | "saving" | "error";
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

export function useWebSocket() {
  const connected = ref(false);
  const running = ref(false);
  const leaderJoints = ref<JointData | null>(null);
  const followerJoints = ref<JointData | null>(null);
  const cameraFrame = ref<string | null>(null);
  const camera2Frame = ref<string | null>(null);
  const camera3Frame = ref<string | null>(null);
  const camera4Frame = ref<string | null>(null);
  const cameraStream = ref<MediaStream | null>(null);
  const camera2Stream = ref<MediaStream | null>(null);
  const camera3Stream = ref<MediaStream | null>(null);
  const camera4Stream = ref<MediaStream | null>(null);
  const logs = ref<string[]>([]);
  const fatalError = ref<string | null>(null);
  const recording = ref<RecordingStatus>({
    state: "idle", dataset: null, task: null, startedAt: null,
    episode: null, path: null, error: null, plannedEpisodes: 10, episodeTime: 20, resetTime: 5, resume: false,
    lastResult: null,
  });
  const metrics = ref<DebugMetrics>({
    controlFps: 0, controlLatency: null,
    cameraFps: 0, cameraLatency: null, cameraDropped: 0,
    camera2Fps: 0, camera2Latency: null, camera2Dropped: 0,
    camera3Fps: 0, camera3Latency: null, camera3Dropped: 0,
    camera4Fps: 0, camera4Latency: null, camera4Dropped: 0, averageCameraLatency: null,
    streamConnected: false, rtcConnected: false, rtcStatus: "connecting",
  });

  let ws: WebSocket | null = null;
  let streamWs: WebSocket | null = null;
  let rtcPeer: RTCPeerConnection | null = null;
  let rtcControl: RTCDataChannel | null = null;
  let rtcState: RTCDataChannel | null = null;
  let rtcSafety: RTCDataChannel | null = null;
  let rtcStateOpen = false;
  let rtcVideoOpen = false;
  let rtcSequence = 0;
  const controlSentAt = new Map<number, number>();
  const controlLatencyTimeoutMs = 2_000;
  let lastControlLatencyAt: number | null = null;
  let reconnectTimer: number | null = null;
  let streamReconnectTimer: number | null = null;
  let rtcReconnectTimer: number | null = null;
  let rtcDisconnectTimer: number | null = null;
  let frameAnimation: number | null = null;
  let pendingCameraFrame: Blob | null = null;
  let pendingCamera2Frame: Blob | null = null;
  let pendingCamera3Frame: Blob | null = null;
  let pendingCamera4Frame: Blob | null = null;
  let pendingCameraTs: number | undefined;
  let pendingCamera2Ts: number | undefined;
  let pendingCamera3Ts: number | undefined;
  let pendingCamera4Ts: number | undefined;
  let cameraFrameUrl: string | null = null;
  let camera2FrameUrl: string | null = null;
  let camera3FrameUrl: string | null = null;
  let camera4FrameUrl: string | null = null;
  let metricsTimer: number | null = null;
  let controlFrames = 0;
  let cameraFrames = 0;
  let camera2Frames = 0;
  let camera3Frames = 0;
  let camera4Frames = 0;
  let cameraDropped = 0;
  let camera2Dropped = 0;
  let camera3Dropped = 0;
  let camera4Dropped = 0;
  let disposed = false;
  let pingTimer: number | null = null;
  let rtcHeartbeatTimer: number | null = null;
  let lastLogMessage = "";
  let lastLogAt = 0;
  // 机器人上位机时钟与浏览器时钟不同步（无 NTP），直接用两台设备的时间戳相减会得到
  // 无意义甚至负数的延迟，被 Math.max(0, ...) 钳制后就一直显示 0ms。
  // 用控制 WebSocket 做一次简易 NTP 式估算：clockOffset = 机器人时钟 - 浏览器时钟。
  let clockOffset = 0;
  let videoLatencyTotal = 0;
  let videoLatencySamples = 0;
  let rtcStatsBusy = false;
  const rtcVideoStats = new Map<string, { jitterDelay: number; emitted: number; frames: number; timestamp: number }>();

  function recordVideoLatency(value: number | null): void {
    if (value === null || !Number.isFinite(value)) return;
    videoLatencyTotal += value;
    videoLatencySamples += 1;
  }

  function sendPing() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  }

  function handlePong(msg: WSMessage) {
    const clientTs = msg.clientTs as number | undefined;
    const serverTs = msg.serverTs as number | undefined;
    if (typeof clientTs !== "number" || typeof serverTs !== "number") return;
    const rtt = Date.now() - clientTs;
    // 假设上下行延迟对称，服务端处理时刻约为 clientTs + rtt/2。
    clockOffset = serverTs - (clientTs + rtt / 2);
  }

  function latency(ts?: number): number | null {
    if (typeof ts !== "number") return null;
    const robotNow = Date.now() + clockOffset;
    return Math.max(0, Math.round(robotNow - ts * 1000));
  }

  function reportLatencyMetrics(current: DebugMetrics) {
    if (current.controlLatency === null && current.cameraLatency === null && current.camera2Latency === null) return;
    void fetch("/api/logs/latency", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        controlLatencyMs: current.controlLatency,
        cameraLatencyMs: current.cameraLatency,
        camera2LatencyMs: current.camera2Latency,
        controlFps: current.controlFps,
        cameraFps: current.cameraFps,
        camera2Fps: current.camera2Fps,
      }),
    }).catch(() => undefined);
  }

  // WebRTC video does not carry the robot capture timestamp through the RTP
  // track. Estimate display-path latency from the browser's receive jitter
  // buffer plus half the measured network RTT. This is intentionally separate
  // from the JPEG timestamp metric used by the WebSocket fallback.
  async function updateRtcVideoLatency(): Promise<void> {
    if (!rtcPeer || !rtcVideoOpen || rtcStatsBusy) return;
    rtcStatsBusy = true;
    try {
      const reports = await rtcPeer.getStats();
      let rttMs: number | null = null;
      reports.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && typeof report.currentRoundTripTime === "number") {
          const value = report.currentRoundTripTime * 500;
          if (rttMs === null || value < rttMs) rttMs = value;
        }
      });
      const videoReports = [...reports.values()].filter((report) => report.type === "inbound-rtp" && report.kind === "video") as Array<Record<string, unknown>>;
      const fps: number[] = [];
      const latencies = videoReports.slice(0, 2).map((report) => {
        const id = String(report.id);
        const jitterDelay = typeof report.jitterBufferDelay === "number" ? report.jitterBufferDelay : 0;
        const emitted = typeof report.jitterBufferEmittedCount === "number" ? report.jitterBufferEmittedCount : 0;
        const frames = typeof report.framesDecoded === "number" ? report.framesDecoded : 0;
        const timestamp = typeof report.timestamp === "number" ? report.timestamp : performance.now();
        const previous = rtcVideoStats.get(id);
        const emittedDelta = previous ? emitted - previous.emitted : emitted;
        const jitterDelta = previous ? jitterDelay - previous.jitterDelay : jitterDelay;
        const elapsed = previous ? timestamp - previous.timestamp : 0;
        const frameDelta = previous ? frames - previous.frames : 0;
        const currentJitterMs = emittedDelta > 0 ? jitterDelta * 1000 / emittedDelta : 0;
        fps.push(elapsed > 0 ? Math.max(0, Math.round(frameDelta * 1000 / elapsed)) : 0);
        rtcVideoStats.set(id, { jitterDelay, emitted, frames, timestamp });
        return Math.max(0, Math.round(currentJitterMs + (rttMs || 0)));
      });
      if (latencies[0] !== undefined) metrics.value.cameraLatency = latencies[0];
      if (latencies[1] !== undefined) metrics.value.camera2Latency = latencies[1];
      if (fps[0] !== undefined && fps[0] > 0) metrics.value.cameraFps = fps[0];
      if (fps[1] !== undefined && fps[1] > 0) metrics.value.camera2Fps = fps[1];
      metrics.value.averageCameraLatency = latencies.length
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null;
    } catch {
      // Stats are best-effort and unavailable while the peer is negotiating.
    } finally {
      rtcStatsBusy = false;
    }
  }

  function updateMetrics() {
    const now = performance.now();
    for (const [sequence, sentAt] of controlSentAt) {
      if (now - sentAt > controlLatencyTimeoutMs) controlSentAt.delete(sequence);
    }
    if (lastControlLatencyAt !== null && now - lastControlLatencyAt > controlLatencyTimeoutMs) {
      metrics.value.controlLatency = null;
      lastControlLatencyAt = null;
    }
    const updated = {
      ...metrics.value,
      averageCameraLatency: rtcVideoOpen
        ? metrics.value.averageCameraLatency
        : videoLatencySamples ? Math.round(videoLatencyTotal / videoLatencySamples) : null,
      controlFps: controlFrames,
      cameraFps: rtcVideoOpen ? metrics.value.cameraFps : cameraFrames,
      cameraDropped,
      camera2Fps: rtcVideoOpen ? metrics.value.camera2Fps : camera2Frames,
      camera2Dropped,
      camera3Fps: camera3Frames,
      camera3Dropped,
      camera4Fps: camera4Frames,
      camera4Dropped,
    };
    metrics.value = updated;
    void updateRtcVideoLatency();
    reportLatencyMetrics(updated);
    controlFrames = cameraFrames = camera2Frames = camera3Frames = camera4Frames = 0;
    cameraDropped = camera2Dropped = camera3Dropped = camera4Dropped = 0;
    videoLatencyTotal = 0;
    videoLatencySamples = 0;
  }

  function scheduleFrames() {
    if (frameAnimation !== null) return;
    frameAnimation = requestAnimationFrame(() => {
      frameAnimation = null;
      if (pendingCameraFrame !== null) {
        const url = URL.createObjectURL(pendingCameraFrame);
        if (cameraFrameUrl) URL.revokeObjectURL(cameraFrameUrl);
        cameraFrameUrl = url;
        cameraFrame.value = url;
        metrics.value.cameraLatency = latency(pendingCameraTs);
        recordVideoLatency(metrics.value.cameraLatency);
        pendingCameraFrame = null;
      }
      if (pendingCamera2Frame !== null) {
        const url = URL.createObjectURL(pendingCamera2Frame);
        if (camera2FrameUrl) URL.revokeObjectURL(camera2FrameUrl);
        camera2FrameUrl = url;
        camera2Frame.value = url;
        metrics.value.camera2Latency = latency(pendingCamera2Ts);
        recordVideoLatency(metrics.value.camera2Latency);
        pendingCamera2Frame = null;
      }
      if (pendingCamera3Frame !== null) {
        const url = URL.createObjectURL(pendingCamera3Frame);
        if (camera3FrameUrl) URL.revokeObjectURL(camera3FrameUrl);
        camera3FrameUrl = url;
        camera3Frame.value = url;
        metrics.value.camera3Latency = latency(pendingCamera3Ts);
        recordVideoLatency(metrics.value.camera3Latency);
        pendingCamera3Frame = null;
      }
      if (pendingCamera4Frame !== null) {
        const url = URL.createObjectURL(pendingCamera4Frame);
        if (camera4FrameUrl) URL.revokeObjectURL(camera4FrameUrl);
        camera4FrameUrl = url;
        camera4Frame.value = url;
        metrics.value.camera4Latency = latency(pendingCamera4Ts);
        recordVideoLatency(metrics.value.camera4Latency);
        pendingCamera4Frame = null;
      }
    });
  }

  function handleBinaryFrame(buffer: ArrayBuffer) {
    // 帧格式: [1 字节类型][8 字节 timestamp(float64, 秒)][JPEG 字节]，见 robot-server broadcastBinaryFrame。
    if (buffer.byteLength < 9) return;
    const view = new DataView(buffer);
    const streamType = view.getUint8(0);
    const ts = view.getFloat64(1, true);
    const jpeg = new Blob([buffer.slice(9)], { type: "image/jpeg" });
    // Keep at most one unacknowledged frame per camera in the FRP/TCP path.
    // This prevents a slow viewer from building a stale video queue.
    if (streamWs?.readyState === WebSocket.OPEN && streamType >= 1 && streamType <= 4) {
      streamWs.send(JSON.stringify({ type: "frame_ack", camera: streamType }));
    }
    if (streamType === 1) {
      cameraFrames += 1;
      if (pendingCameraFrame !== null) cameraDropped += 1;
      pendingCameraFrame = jpeg;
      pendingCameraTs = ts;
      scheduleFrames();
    } else if (streamType === 2) {
      camera2Frames += 1;
      if (pendingCamera2Frame !== null) camera2Dropped += 1;
      pendingCamera2Frame = jpeg;
      pendingCamera2Ts = ts;
      scheduleFrames();
    } else if (streamType === 3) {
      camera3Frames += 1;
      if (pendingCamera3Frame !== null) camera3Dropped += 1;
      pendingCamera3Frame = jpeg;
      pendingCamera3Ts = ts;
      scheduleFrames();
    } else if (streamType === 4) {
      camera4Frames += 1;
      if (pendingCamera4Frame !== null) camera4Dropped += 1;
      pendingCamera4Frame = jpeg;
      pendingCamera4Ts = ts;
      scheduleFrames();
    }
  }

  function log(msg: string) {
    const now = Date.now();
    // 控制状态会同时走 WebSocket 与 WebRTC；合并紧邻的同一事件。
    if (msg === lastLogMessage && now - lastLogAt < 1000) return;
    lastLogMessage = msg;
    lastLogAt = now;
    const t = new Date().toLocaleTimeString();
    logs.value.unshift(`[${t}] ${msg}`);
    if (logs.value.length > 500) logs.value.length = 500;
  }

  function clearLogs() {
    logs.value = [];
    lastLogMessage = "";
    lastLogAt = 0;
  }

  function connect() {
    if (disposed || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/control`);

    ws.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connected.value = true;
      log("WebSocket 已连接");
      sendPing();
    };

    ws.onclose = (event) => {
      ws = null;
      connected.value = false;
      if (event.code === 1008) {
        // Another device logged in with this account. Reloading refreshes the
        // auth session and returns this browser to the login screen.
        window.location.reload();
        return;
      }
      log("WebSocket 断开，3秒后重连...");
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 3000);
      }
    };

    ws.onerror = () => log("WebSocket 错误");

    ws.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data);
        if (rtcStateOpen && msg.type === "teleop_observation") return;
        handleMessage(msg);
      } catch {
        // 忽略非 JSON
      }
    };
  }

  function connectStream() {
    if (disposed || (streamWs && (streamWs.readyState === WebSocket.CONNECTING || streamWs.readyState === WebSocket.OPEN))) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    streamWs = new WebSocket(`${proto}://${location.host}/ws/stream`);
    streamWs.binaryType = "arraybuffer";
    streamWs.onopen = () => { metrics.value = { ...metrics.value, streamConnected: true }; };
    streamWs.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleBinaryFrame(ev.data);
      } else {
        try { handleMessage(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
      }
    };
    streamWs.onclose = () => {
      metrics.value = { ...metrics.value, streamConnected: false };
      streamWs = null;
      if (!disposed && !rtcVideoOpen && streamReconnectTimer === null) {
        streamReconnectTimer = window.setTimeout(() => {
          streamReconnectTimer = null;
          connectStream();
        }, 3000);
      }
    };
  }

  function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 5000);
      const listener = () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", listener);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", listener);
    });
  }

  function scheduleRtcReconnect() {
    if (disposed || rtcReconnectTimer !== null) return;
    rtcReconnectTimer = window.setTimeout(() => {
      rtcReconnectTimer = null;
      void connectRtc();
    }, 3000);
  }

  function closeRtc(scheduleReconnect = false) {
    if (rtcDisconnectTimer !== null) {
      clearTimeout(rtcDisconnectTimer);
      rtcDisconnectTimer = null;
    }
    rtcStateOpen = false;
    const hadVideo = rtcVideoOpen;
    rtcVideoOpen = false;
    metrics.value = {
      ...metrics.value,
      rtcConnected: false,
      rtcStatus: scheduleReconnect && metrics.value.rtcStatus === "connected" ? "fallback" : metrics.value.rtcStatus,
    };
    rtcControl = rtcState = rtcSafety = null;
    rtcVideoStats.clear();
    cameraStream.value = null;
    camera2Stream.value = null;
    const peer = rtcPeer;
    rtcPeer = null;
    peer?.close();
    if (hadVideo && !disposed) connectStream();
    if (scheduleReconnect) scheduleRtcReconnect();
  }

  async function connectRtc() {
    if (disposed || rtcPeer) return;
    let stage = "读取服务配置";
    try {
      metrics.value = { ...metrics.value, rtcStatus: "connecting" };
      const configResponse = await fetch("/api/rtc/config");
      const config = await configResponse.json();
      if (!configResponse.ok) throw new Error(`RTC 配置请求失败，状态码 ${configResponse.status}`);
      if (!config.enabled) {
        metrics.value = { ...metrics.value, rtcStatus: "disabled" };
        log("WebRTC 已被机器人服务端禁用，使用 WebSocket 控制");
        return;
      }
      stage = "创建连接";
      const peer = new RTCPeerConnection({ iceServers: config.iceServers || [] });
      rtcPeer = peer;
      rtcControl = peer.createDataChannel("robot-control-v1", { ordered: false, maxRetransmits: 0 });
      // State is real-time telemetry: an old sample is useless, so never retransmit or preserve ordering.
      rtcState = peer.createDataChannel("robot-state-v1", { ordered: false, maxRetransmits: 0 });
      rtcSafety = peer.createDataChannel("robot-safety-v1", { ordered: true });
      const rtcVideoEnabled = config.videoEnabled === true;
      if (rtcVideoEnabled) {
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.addTransceiver("video", { direction: "recvonly" });
      }

      rtcState.onopen = () => {
        rtcStateOpen = true;
        metrics.value = { ...metrics.value, rtcConnected: true, rtcStatus: "connected" };
        log("WebRTC 状态通道已连接");
      };
      rtcState.onclose = () => { rtcStateOpen = false; };
      rtcState.onmessage = (event) => {
        try { handleMessage(JSON.parse(String(event.data))); } catch { /* ignore malformed state */ }
      };
      const pendingTracks = new Map<string, MediaStreamTrack>();
      let videoMids: { camera1: string; camera2: string } | null = null;
      const activeVideoMids = new Set<string>();
      const activateRtcVideo = (mid: string, track: MediaStreamTrack) => {
        if (!videoMids) return;
        if (mid === videoMids.camera1) cameraStream.value = new MediaStream([track]);
        if (mid === videoMids.camera2) camera2Stream.value = new MediaStream([track]);
        activeVideoMids.add(mid);
        rtcVideoOpen = true;
        if (activeVideoMids.size === 2) {
          if (streamReconnectTimer) { clearTimeout(streamReconnectTimer); streamReconnectTimer = null; }
          streamWs?.close();
        }
      };
      const installTrack = (mid: string, track: MediaStreamTrack) => {
        if (!videoMids) { pendingTracks.set(mid, track); return; }
        track.onunmute = () => activateRtcVideo(mid, track);
        track.onended = () => {
          activeVideoMids.delete(mid);
          if (mid === videoMids?.camera1) cameraStream.value = null;
          if (mid === videoMids?.camera2) camera2Stream.value = null;
          rtcVideoOpen = activeVideoMids.size > 0;
          if (!disposed) connectStream();
        };
        if (!track.muted) activateRtcVideo(mid, track);
      };
      peer.ontrack = (event) => {
        const mid = event.transceiver.mid;
        const receiver = event.receiver as RTCRtpReceiver & {
          playoutDelayHint?: number;
          jitterBufferTarget?: number;
        };
        try {
          receiver.playoutDelayHint = 0;
          receiver.jitterBufferTarget = 0;
        } catch {
          // Experimental low-latency hints are not available in every browser.
        }
        if (mid !== null) installTrack(mid, event.track);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected" && rtcDisconnectTimer !== null) {
          clearTimeout(rtcDisconnectTimer);
          rtcDisconnectTimer = null;
        } else if (peer.connectionState === "disconnected" && rtcDisconnectTimer === null) {
          rtcDisconnectTimer = window.setTimeout(() => {
            rtcDisconnectTimer = null;
            if (rtcPeer === peer && peer.connectionState === "disconnected") closeRtc(!disposed);
          }, 3000);
        } else if (["failed", "closed"].includes(peer.connectionState)) {
          if (peer.connectionState === "failed") log(`WebRTC 连接失败（ICE: ${peer.iceConnectionState}），正在回退到 WebSocket`);
          closeRtc(!disposed);
        }
      };

      stage = "创建 Offer";
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      stage = "收集 ICE 候选";
      await waitForIceGathering(peer);
      stage = "提交 Offer";
      const response = await fetch("/api/rtc/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(peer.localDescription),
      });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer.error || "WebRTC signaling 失败");
      videoMids = answer.videoMids;
      stage = "应用 Answer";
      await peer.setRemoteDescription(answer);
      for (const [mid, track] of pendingTracks) installTrack(mid, track);
    } catch (cause) {
      metrics.value = { ...metrics.value, rtcConnected: false, rtcStatus: "failed" };
      log(`WebRTC ${stage}失败，继续使用 WebSocket: ${cause instanceof Error ? cause.message : String(cause)}`);
      closeRtc(!disposed);
    }
  }

  function handleMessage(msg: WSMessage) {
    switch (msg.type) {
      case "pong":
        handlePong(msg);
        break;
      case "status":
        running.value = msg.running ?? false;
        break;
      case "stopped":
        running.value = false;
        if (msg.error) {
          log(`遥操作进程异常退出: ${msg.error}`);
          fatalError.value = msg.error;
        } else {
          log("遥操作进程已退出");
        }
        break;
      case "teleop_observation":
        controlFrames += 1;
        if (typeof msg.applied_seq === "number") {
          const sentAt = controlSentAt.get(msg.applied_seq);
          if (sentAt !== undefined) {
            metrics.value.controlLatency = Math.round(performance.now() - sentAt);
            lastControlLatencyAt = performance.now();
            for (const sequence of controlSentAt.keys()) {
              if (sequence <= msg.applied_seq) controlSentAt.delete(sequence);
            }
          }
        } else {
          metrics.value.controlLatency = latency(msg.ts);
        }
        if (msg.leader) {
          leaderJoints.value = msg.leader;
        }
        if (msg.follower) followerJoints.value = msg.follower;
        break;
      case "safety_reject": {
        const joint = typeof msg.joint === "string" ? msg.joint : "未知关节";
        const value = typeof msg.value === "number" ? msg.value.toFixed(2) : "无效值";
        const min = typeof msg.min === "number" ? msg.min.toFixed(2) : "-";
        const max = typeof msg.max === "number" ? msg.max.toFixed(2) : "-";
        log(`安全限制：已拒绝 ${joint}=${value}，允许范围 ${min} 到 ${max}`);
        break;
      }
      case "recording_status":
        recording.value = {
          state: msg.state as RecordingStatus["state"],
          dataset: typeof msg.dataset === "string" ? msg.dataset : null,
          task: typeof msg.task === "string" ? msg.task : null,
          startedAt: typeof msg.startedAt === "number" ? msg.startedAt : null,
          episode: typeof msg.episode === "number" ? msg.episode : null,
          path: typeof msg.path === "string" ? msg.path : null,
          error: typeof msg.error === "string" ? msg.error : null,
          plannedEpisodes: typeof msg.plannedEpisodes === "number" ? msg.plannedEpisodes : 10,
          episodeTime: typeof msg.episodeTime === "number" ? msg.episodeTime : 20,
          resetTime: typeof msg.resetTime === "number" ? msg.resetTime : 5,
          resume: msg.resume === true,
          lastResult: msg.lastResult === "saved" || msg.lastResult === "discarded" ? msg.lastResult : null,
        };
        break;
      case "bridge_log": {
        const source = msg.source === "recorder" ? "录制" : "遥操作";
        const level = msg.level === "error" || msg.level === "stderr" ? "错误" : msg.level === "warn" ? "警告" : "信息";
        const message = typeof msg.message === "string" ? msg.message : "未知日志";
        log(`[${source}/${level}] ${message}`);
        break;
      }
    }
  }

  function send(msg: object) {
    let payload = msg;
    if ((msg as WSMessage).type === "action") {
      const sequence = ++rtcSequence;
      payload = { ...msg, seq: sequence, sent_at_ms: Date.now() };
      controlSentAt.set(sequence, performance.now());
      metrics.value.controlLatency = null;
      lastControlLatencyAt = null;
      if (controlSentAt.size > 240) controlSentAt.delete(controlSentAt.keys().next().value!);
    }
    const encoded = JSON.stringify(payload);
    // Prefer the unordered, no-retransmission WebRTC control channel. TCP
    // fallback shares FRP's queue with video and can turn packet loss into
    // multi-second control latency.
    if (rtcControl?.readyState === "open") {
      try {
        if (rtcControl.bufferedAmount <= 16 * 1024) rtcControl.send(encoded);
        return;
      } catch {
        // Fall through to the WebSocket transport while RTC reconnects.
      }
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoded);
  }

  onMounted(() => {
    connect();
    connectStream();
    void connectRtc();
    metricsTimer = window.setInterval(updateMetrics, 1000);
    // 定期重新估算时钟偏差，避免长时间运行后（时钟漂移、网络路径变化）产生的误差累积。
    pingTimer = window.setInterval(sendPing, 5000);
    rtcHeartbeatTimer = window.setInterval(() => {
      if (rtcSafety?.readyState === "open") {
        rtcSafety.send(JSON.stringify({ type: "heartbeat", ts_ms: Date.now() }));
      }
    }, 250);
  });
  onUnmounted(() => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (streamReconnectTimer) clearTimeout(streamReconnectTimer);
    if (rtcReconnectTimer) clearTimeout(rtcReconnectTimer);
    if (rtcDisconnectTimer) clearTimeout(rtcDisconnectTimer);
    if (frameAnimation !== null) cancelAnimationFrame(frameAnimation);
    if (metricsTimer !== null) clearInterval(metricsTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    if (rtcHeartbeatTimer !== null) clearInterval(rtcHeartbeatTimer);
    if (ws) ws.close();
    if (streamWs) streamWs.close();
    closeRtc(false);
    if (cameraFrameUrl) URL.revokeObjectURL(cameraFrameUrl);
    if (camera2FrameUrl) URL.revokeObjectURL(camera2FrameUrl);
    if (camera3FrameUrl) URL.revokeObjectURL(camera3FrameUrl);
    if (camera4FrameUrl) URL.revokeObjectURL(camera4FrameUrl);
  });

  return {
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
  };
}
