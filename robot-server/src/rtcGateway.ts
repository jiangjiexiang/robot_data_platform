import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import type * as WrtcTypes from "@roamhq/wrtc";

type WrtcModule = typeof WrtcTypes;

// @roamhq/wrtc 是带平台二进制的原生模块。node_modules 从其他机器拷贝或平台包缺失时，
// 顶层 require 会让整个服务崩溃；改为按需加载，失败则降级为无 WebRTC。
let wrtcModule: WrtcModule | null | undefined;
function loadWrtc(): WrtcModule | null {
  if (wrtcModule !== undefined) return wrtcModule;
  try {
    wrtcModule = require("@roamhq/wrtc") as WrtcModule;
  } catch (error) {
    wrtcModule = null;
    console.warn("[RTC] 未找到 @roamhq/wrtc 原生二进制，WebRTC 已停用:", error instanceof Error ? error.message : String(error));
  }
  return wrtcModule;
}

interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

interface RtcPeer {
  id: string;
  pc: WrtcTypes.RTCPeerConnection;
  channels: Map<string, WrtcTypes.RTCDataChannel>;
  lastSequence: number;
  lastControlAt: number;
  closed: boolean;
  disconnectTimer: NodeJS.Timeout | null;
}

export type ControlLossReason = "watchdog_timeout" | "control_channel_closed" | "peer_connection_lost";

type CameraIndex = 1 | 2;

interface VideoTrackDescription {
  camera1: string;
  camera2: string;
}

export interface RtcGatewayOptions {
  enabled: boolean;
  videoEnabled?: boolean;
  iceServers?: IceServer[];
  controlTimeoutMs?: number;
  maxVideoFps?: number;
  maxVideoBitrate?: number;
  onControl: (message: Record<string, unknown>) => void;
  onSafetyStop: () => void;
  onControlLost: (reason: ControlLossReason, idleMs: number) => void;
}

/**
 * WebRTC transport for low-latency control, state and RTP video delivery.
 */
export class RtcGateway {
  private readonly peers = new Map<string, RtcPeer>();
  private readonly enabled: boolean;
  private readonly videoEnabled: boolean;
  private readonly iceServers: IceServer[];
  private readonly controlTimeoutMs: number;
  private readonly onControl: RtcGatewayOptions["onControl"];
  private readonly onSafetyStop: RtcGatewayOptions["onSafetyStop"];
  private readonly onControlLost: RtcGatewayOptions["onControlLost"];
  private controlOwner: string | null = null;
  private watchdog: NodeJS.Timeout;
  private readonly wrtc: WrtcModule | null = null;
  private readonly videoSources = new Map<CameraIndex, WrtcTypes.nonstandard.RTCVideoSource>();
  private readonly videoTracks = new Map<CameraIndex, WrtcTypes.MediaStreamTrack>();
  private readonly videoDecoders = new Map<CameraIndex, Worker>();
  private readonly decoding = new Set<CameraIndex>();
  private readonly pendingFrames = new Map<CameraIndex, Buffer>();
  private readonly lastVideoFrameAt = new Map<CameraIndex, number>();
  private readonly minVideoFrameIntervalMs: number;
  private readonly maxVideoBitrate: number;

  constructor(options: RtcGatewayOptions) {
    // 原生模块不可用时静默降级：控制与视频自动回落到 WebSocket / MJPEG。
    this.wrtc = options.enabled ? loadWrtc() : null;
    this.enabled = options.enabled && this.wrtc !== null;
    this.videoEnabled = this.enabled && options.videoEnabled === true;
    this.iceServers = options.iceServers || [];
    this.controlTimeoutMs = options.controlTimeoutMs || 750;
    this.minVideoFrameIntervalMs = 1000 / Math.max(1, options.maxVideoFps || 15);
    this.maxVideoBitrate = Math.max(100_000, options.maxVideoBitrate || 1_500_000);
    this.onControl = options.onControl;
    this.onSafetyStop = options.onSafetyStop;
    this.onControlLost = options.onControlLost;
    if (this.videoEnabled && this.wrtc) {
      const wrtc = this.wrtc;
      for (const camera of [1, 2] as const) {
        const source = new wrtc.nonstandard.RTCVideoSource();
        this.videoSources.set(camera, source);
        this.videoTracks.set(camera, source.createTrack());
      }
    }
    const compiledDecoder = path.join(__dirname, "videoFrameDecoder.js");
    const decoderPath = fs.existsSync(compiledDecoder) ? compiledDecoder : path.join(__dirname, "videoFrameDecoder.ts");
    if (this.videoEnabled) {
      for (const camera of [1, 2] as const) {
        const decoder = new Worker(
          decoderPath,
          fs.existsSync(compiledDecoder) ? undefined : { execArgv: ["-r", "ts-node/register"] },
        );
        this.videoDecoders.set(camera, decoder);
        decoder.on("message", (frame: { camera: CameraIndex; width?: number; height?: number; data?: Uint8Array }) => {
          this.decoding.delete(camera);
          if (frame.width && frame.height && frame.data) {
            this.videoSources.get(camera)?.onFrame({ width: frame.width, height: frame.height, data: frame.data });
          }
          const pending = this.pendingFrames.get(camera);
          if (pending) {
            this.pendingFrames.delete(camera);
            this.decodeVideoFrame(camera, pending);
          }
        });
        decoder.on("error", () => {
          this.decoding.delete(camera);
          this.pendingFrames.delete(camera);
        });
        decoder.unref();
      }
    }
    this.watchdog = setInterval(() => this.checkWatchdog(), 100);
    this.watchdog.unref();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isVideoEnabled(): boolean {
    return this.videoEnabled;
  }

  peerCount(): number {
    return this.peers.size;
  }

  disconnectAllPeers(): void {
    const peers = [...this.peers.values()];
    this.peers.clear();
    this.controlOwner = null;
    for (const peer of peers) {
      peer.closed = true;
      if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
      peer.pc.close();
    }
  }

  async acceptOffer(offer: { type: "offer"; sdp: string }): Promise<{ type: "answer"; sdp: string; videoMids: VideoTrackDescription }> {
    if (!this.enabled) throw new Error("WebRTC 未启用");
    const wrtc = this.wrtc;
    if (!wrtc) throw new Error("WebRTC 未启用");
    if (offer?.type !== "offer" || typeof offer.sdp !== "string" || offer.sdp.length > 1_000_000) {
      throw new Error("无效的 WebRTC offer");
    }

    const peer: RtcPeer = {
      id: crypto.randomUUID(),
      pc: new wrtc.RTCPeerConnection({ iceServers: this.iceServers }),
      channels: new Map(),
      lastSequence: -1,
      lastControlAt: 0,
      closed: false,
      disconnectTimer: null,
    };
    this.peers.set(peer.id, peer);
    peer.pc.ondatachannel = (event: { channel: WrtcTypes.RTCDataChannel }) => this.attachChannel(peer, event.channel);
    peer.pc.onconnectionstatechange = () => {
      const state = peer.pc.connectionState;
      if (state === "connected" && peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
      } else if (state === "disconnected" && !peer.disconnectTimer) {
        // ICE may briefly report disconnected while Wi-Fi changes rate/channel.
        // Give it time to recover before replacing a working DataChannel.
        peer.disconnectTimer = setTimeout(() => {
          peer.disconnectTimer = null;
          if (peer.pc.connectionState === "disconnected") {
            void this.removePeer(peer, "peer_connection_lost");
          }
        }, 3000);
        peer.disconnectTimer.unref();
      } else if (state === "failed" || state === "closed") {
        void this.removePeer(peer, "peer_connection_lost");
      }
    };

    try {
      await peer.pc.setRemoteDescription(offer);
      const videoMids = this.videoEnabled ? await this.addVideoTracks(peer.pc) : { camera1: "", camera2: "" };
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await this.waitForIceGathering(peer.pc);
      const local = peer.pc.localDescription;
      if (!local) throw new Error("WebRTC answer 创建失败");
      if (local.type !== "answer") throw new Error("WebRTC 返回了非 answer 描述");
      return { type: "answer", sdp: local.sdp, videoMids };
    } catch (error) {
      await this.removePeer(peer);
      throw error;
    }
  }

  broadcastControl(message: object): void {
    const data = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      // Telemetry is replaceable. Drop immediately when SCTP cannot keep up instead
      // of allowing hundreds of milliseconds of stale observations to accumulate.
      this.send(peer.channels.get("robot-state-v1"), data, 16 * 1024);
    }
  }

  broadcastVideoFrame(camera: CameraIndex, jpegFrame: Buffer): void {
    if (this.peers.size === 0) return;
    const now = performance.now();
    if (now - (this.lastVideoFrameAt.get(camera) || 0) < this.minVideoFrameIntervalMs) return;
    this.lastVideoFrameAt.set(camera, now);
    if (this.decoding.has(camera)) {
      // Decoder busy: replace the waiting frame. Never encode stale camera history.
      this.pendingFrames.set(camera, jpegFrame);
      return;
    }
    this.decodeVideoFrame(camera, jpegFrame);
  }

  broadcastFrame(frame: Buffer): void {
    if (frame.length < 10) return;
    const camera = frame.readUInt8(0);
    if (camera !== 1 && camera !== 2) return;
    this.broadcastVideoFrame(camera, frame.subarray(9));
  }

  async close(): Promise<void> {
    clearInterval(this.watchdog);
    this.disconnectAllPeers();
    await Promise.all([...this.videoDecoders.values()].map((decoder) => decoder.terminate()));
    this.videoDecoders.clear();
  }

  private attachChannel(peer: RtcPeer, channel: WrtcTypes.RTCDataChannel): void {
    if (!["robot-control-v1", "robot-state-v1", "robot-safety-v1"].includes(channel.label)) {
      channel.close();
      return;
    }
    peer.channels.set(channel.label, channel);
    channel.onmessage = (event: { data: unknown }) => {
      if (channel.label === "robot-control-v1") this.handleControl(peer, event.data);
      if (channel.label === "robot-safety-v1") this.handleSafety(peer, event.data);
    };
    channel.onclose = () => {
      peer.channels.delete(channel.label);
      if (channel.label === "robot-control-v1" && this.controlOwner === peer.id) {
        this.releaseControl(peer, true, "control_channel_closed");
      }
    };
  }

  private async addVideoTracks(peer: WrtcTypes.RTCPeerConnection): Promise<VideoTrackDescription> {
    const offeredVideo = peer.getTransceivers().filter(
      (transceiver: WrtcTypes.RTCRtpTransceiver) => transceiver.receiver.track.kind === "video",
    );
    if (offeredVideo.length < 2) throw new Error("WebRTC offer 必须包含两条 recvonly 视频通道");
    const mids = {} as VideoTrackDescription;
    for (const [offset, camera] of ([1, 2] as const).entries()) {
      const track = this.videoTracks.get(camera);
      if (!track) throw new Error(`摄像头 ${camera} 视频轨不可用`);
      const transceiver = offeredVideo[offset];
      await transceiver.sender.replaceTrack(track);
      try {
        const parameters = transceiver.sender.getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0].maxBitrate = this.maxVideoBitrate;
        parameters.encodings[0].maxFramerate = Math.round(1000 / this.minVideoFrameIntervalMs);
        await transceiver.sender.setParameters(parameters);
      } catch {
        // Older libwebrtc builds may reject encoding hints; latest-frame dropping still applies.
      }
      transceiver.direction = "sendonly";
      const mid = transceiver.mid;
      if (mid === null || mid === undefined) throw new Error(`摄像头 ${camera} 无法分配 WebRTC mid`);
      mids[`camera${camera}`] = mid;
    }
    return mids;
  }

  private decodeVideoFrame(camera: CameraIndex, frame: Buffer): void {
    const decoder = this.videoDecoders.get(camera);
    if (!decoder) return;
    this.decoding.add(camera);
    const jpegFrame = Uint8Array.from(frame);
    decoder.postMessage({ camera, jpeg: jpegFrame }, [jpegFrame.buffer]);
  }

  private handleControl(peer: RtcPeer, data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(this.messageText(data));
    } catch {
      return;
    }
    if (message.type !== "action" || typeof message.joints !== "object" || message.joints === null) return;
    const sequence = typeof message.seq === "number" ? message.seq : peer.lastSequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence <= peer.lastSequence) return;
    if (this.controlOwner !== null && this.controlOwner !== peer.id) {
      // A controller can vanish without a clean ICE close (for example, a
      // laptop is powered off). The next deliberate action takes control;
      // stale peers must never prevent another LAN operator from recovering.
      const previous = this.peers.get(this.controlOwner);
      if (previous) this.releaseControl(previous, false);
      else this.controlOwner = null;
    }
    this.controlOwner = peer.id;
    peer.lastSequence = sequence;
    peer.lastControlAt = Date.now();
    this.onControl(message);
  }

  private handleSafety(peer: RtcPeer, data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(this.messageText(data));
    } catch {
      return;
    }
    if (message.type === "heartbeat" && this.controlOwner === peer.id) {
      peer.lastControlAt = Date.now();
    } else if (message.type === "stop" && this.controlOwner === peer.id) {
      this.onSafetyStop();
      this.releaseControl(peer, false);
    }
  }

  private checkWatchdog(): void {
    if (!this.controlOwner) return;
    const peer = this.peers.get(this.controlOwner);
    if (!peer || Date.now() - peer.lastControlAt > this.controlTimeoutMs) {
      if (peer) this.releaseControl(peer, true, "watchdog_timeout");
      else {
        this.controlOwner = null;
        this.onControlLost("peer_connection_lost", 0);
      }
    }
  }

  private releaseControl(peer: RtcPeer, notifyLoss: boolean, reason: ControlLossReason = "peer_connection_lost"): void {
    if (this.controlOwner !== peer.id) return;
    const idleMs = peer.lastControlAt > 0 ? Date.now() - peer.lastControlAt : 0;
    this.controlOwner = null;
    peer.lastControlAt = 0;
    if (notifyLoss) this.onControlLost(reason, idleMs);
  }

  private async removePeer(peer: RtcPeer, reason: ControlLossReason = "peer_connection_lost"): Promise<void> {
    if (peer.closed) return;
    peer.closed = true;
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    peer.disconnectTimer = null;
    this.peers.delete(peer.id);
    this.releaseControl(peer, true, reason);
    peer.pc.close();
  }

  private send(channel: WrtcTypes.RTCDataChannel | undefined, data: string | Buffer, highWaterMark: number): void {
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > highWaterMark) return;
    try {
      channel.send(data);
    } catch {
      // Connection-state callbacks own cleanup; a racing close drops this sample.
    }
  }

  private messageText(data: unknown): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
    }
    throw new Error("unsupported DataChannel message");
  }

  private waitForIceGathering(peer: WrtcTypes.RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
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
}
