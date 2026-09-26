"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RtcGateway = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const worker_threads_1 = require("worker_threads");
// @roamhq/wrtc 是带平台二进制的原生模块。node_modules 从其他机器拷贝或平台包缺失时，
// 顶层 require 会让整个服务崩溃；改为按需加载，失败则降级为无 WebRTC。
let wrtcModule;
function loadWrtc() {
    if (wrtcModule !== undefined)
        return wrtcModule;
    try {
        wrtcModule = require("@roamhq/wrtc");
    }
    catch (error) {
        wrtcModule = null;
        console.warn("[RTC] 未找到 @roamhq/wrtc 原生二进制，WebRTC 已停用:", error instanceof Error ? error.message : String(error));
    }
    return wrtcModule;
}
/**
 * WebRTC transport for low-latency control, state and RTP video delivery.
 */
class RtcGateway {
    constructor(options) {
        this.peers = new Map();
        this.controlOwner = null;
        this.wrtc = null;
        this.videoSources = new Map();
        this.videoTracks = new Map();
        this.videoDecoders = new Map();
        this.decoding = new Set();
        this.pendingFrames = new Map();
        this.lastVideoFrameAt = new Map();
        // 原生模块不可用时静默降级：控制与视频自动回落到 WebSocket / MJPEG。
        this.wrtc = options.enabled ? loadWrtc() : null;
        this.enabled = options.enabled && this.wrtc !== null;
        this.videoEnabled = this.enabled && options.videoEnabled === true;
        this.iceServers = options.iceServers || [];
        this.controlTimeoutMs = options.controlTimeoutMs || 750;
        this.minVideoFrameIntervalMs = 1000 / Math.max(1, options.maxVideoFps || 15);
        this.maxVideoBitrate = Math.max(100000, options.maxVideoBitrate || 1500000);
        this.onControl = options.onControl;
        this.onSafetyStop = options.onSafetyStop;
        this.onControlLost = options.onControlLost;
        if (this.videoEnabled && this.wrtc) {
            const wrtc = this.wrtc;
            for (const camera of [1, 2]) {
                const source = new wrtc.nonstandard.RTCVideoSource();
                this.videoSources.set(camera, source);
                this.videoTracks.set(camera, source.createTrack());
            }
        }
        const compiledDecoder = path_1.default.join(__dirname, "videoFrameDecoder.js");
        const decoderPath = fs_1.default.existsSync(compiledDecoder) ? compiledDecoder : path_1.default.join(__dirname, "videoFrameDecoder.ts");
        if (this.videoEnabled) {
            for (const camera of [1, 2]) {
                const decoder = new worker_threads_1.Worker(decoderPath, fs_1.default.existsSync(compiledDecoder) ? undefined : { execArgv: ["-r", "ts-node/register"] });
                this.videoDecoders.set(camera, decoder);
                decoder.on("message", (frame) => {
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
    isEnabled() {
        return this.enabled;
    }
    isVideoEnabled() {
        return this.videoEnabled;
    }
    peerCount() {
        return this.peers.size;
    }
    disconnectAllPeers() {
        const peers = [...this.peers.values()];
        this.peers.clear();
        this.controlOwner = null;
        for (const peer of peers) {
            peer.closed = true;
            if (peer.disconnectTimer)
                clearTimeout(peer.disconnectTimer);
            peer.disconnectTimer = null;
            peer.pc.close();
        }
    }
    async acceptOffer(offer) {
        if (!this.enabled)
            throw new Error("WebRTC 未启用");
        const wrtc = this.wrtc;
        if (!wrtc)
            throw new Error("WebRTC 未启用");
        if (offer?.type !== "offer" || typeof offer.sdp !== "string" || offer.sdp.length > 1000000) {
            throw new Error("无效的 WebRTC offer");
        }
        const peer = {
            id: crypto_1.default.randomUUID(),
            pc: new wrtc.RTCPeerConnection({ iceServers: this.iceServers }),
            channels: new Map(),
            lastSequence: -1,
            lastControlAt: 0,
            closed: false,
            disconnectTimer: null,
        };
        this.peers.set(peer.id, peer);
        peer.pc.ondatachannel = (event) => this.attachChannel(peer, event.channel);
        peer.pc.onconnectionstatechange = () => {
            const state = peer.pc.connectionState;
            if (state === "connected" && peer.disconnectTimer) {
                clearTimeout(peer.disconnectTimer);
                peer.disconnectTimer = null;
            }
            else if (state === "disconnected" && !peer.disconnectTimer) {
                // ICE may briefly report disconnected while Wi-Fi changes rate/channel.
                // Give it time to recover before replacing a working DataChannel.
                peer.disconnectTimer = setTimeout(() => {
                    peer.disconnectTimer = null;
                    if (peer.pc.connectionState === "disconnected") {
                        void this.removePeer(peer, "peer_connection_lost");
                    }
                }, 3000);
                peer.disconnectTimer.unref();
            }
            else if (state === "failed" || state === "closed") {
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
            if (!local)
                throw new Error("WebRTC answer 创建失败");
            if (local.type !== "answer")
                throw new Error("WebRTC 返回了非 answer 描述");
            return { type: "answer", sdp: local.sdp, videoMids };
        }
        catch (error) {
            await this.removePeer(peer);
            throw error;
        }
    }
    broadcastControl(message) {
        const data = JSON.stringify(message);
        for (const peer of this.peers.values()) {
            // Telemetry is replaceable. Drop immediately when SCTP cannot keep up instead
            // of allowing hundreds of milliseconds of stale observations to accumulate.
            this.send(peer.channels.get("robot-state-v1"), data, 16 * 1024);
        }
    }
    broadcastVideoFrame(camera, jpegFrame) {
        if (this.peers.size === 0)
            return;
        const now = performance.now();
        if (now - (this.lastVideoFrameAt.get(camera) || 0) < this.minVideoFrameIntervalMs)
            return;
        this.lastVideoFrameAt.set(camera, now);
        if (this.decoding.has(camera)) {
            // Decoder busy: replace the waiting frame. Never encode stale camera history.
            this.pendingFrames.set(camera, jpegFrame);
            return;
        }
        this.decodeVideoFrame(camera, jpegFrame);
    }
    broadcastFrame(frame) {
        if (frame.length < 10)
            return;
        const camera = frame.readUInt8(0);
        if (camera !== 1 && camera !== 2)
            return;
        this.broadcastVideoFrame(camera, frame.subarray(9));
    }
    async close() {
        clearInterval(this.watchdog);
        this.disconnectAllPeers();
        await Promise.all([...this.videoDecoders.values()].map((decoder) => decoder.terminate()));
        this.videoDecoders.clear();
    }
    attachChannel(peer, channel) {
        if (!["robot-control-v1", "robot-state-v1", "robot-safety-v1"].includes(channel.label)) {
            channel.close();
            return;
        }
        peer.channels.set(channel.label, channel);
        channel.onmessage = (event) => {
            if (channel.label === "robot-control-v1")
                this.handleControl(peer, event.data);
            if (channel.label === "robot-safety-v1")
                this.handleSafety(peer, event.data);
        };
        channel.onclose = () => {
            peer.channels.delete(channel.label);
            if (channel.label === "robot-control-v1" && this.controlOwner === peer.id) {
                this.releaseControl(peer, true, "control_channel_closed");
            }
        };
    }
    async addVideoTracks(peer) {
        const offeredVideo = peer.getTransceivers().filter((transceiver) => transceiver.receiver.track.kind === "video");
        if (offeredVideo.length < 2)
            throw new Error("WebRTC offer 必须包含两条 recvonly 视频通道");
        const mids = {};
        for (const [offset, camera] of [1, 2].entries()) {
            const track = this.videoTracks.get(camera);
            if (!track)
                throw new Error(`摄像头 ${camera} 视频轨不可用`);
            const transceiver = offeredVideo[offset];
            await transceiver.sender.replaceTrack(track);
            try {
                const parameters = transceiver.sender.getParameters();
                parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
                parameters.encodings[0].maxBitrate = this.maxVideoBitrate;
                parameters.encodings[0].maxFramerate = Math.round(1000 / this.minVideoFrameIntervalMs);
                await transceiver.sender.setParameters(parameters);
            }
            catch {
                // Older libwebrtc builds may reject encoding hints; latest-frame dropping still applies.
            }
            transceiver.direction = "sendonly";
            const mid = transceiver.mid;
            if (mid === null || mid === undefined)
                throw new Error(`摄像头 ${camera} 无法分配 WebRTC mid`);
            mids[`camera${camera}`] = mid;
        }
        return mids;
    }
    decodeVideoFrame(camera, frame) {
        const decoder = this.videoDecoders.get(camera);
        if (!decoder)
            return;
        this.decoding.add(camera);
        const jpegFrame = Uint8Array.from(frame);
        decoder.postMessage({ camera, jpeg: jpegFrame }, [jpegFrame.buffer]);
    }
    handleControl(peer, data) {
        let message;
        try {
            message = JSON.parse(this.messageText(data));
        }
        catch {
            return;
        }
        if (message.type !== "action" || typeof message.joints !== "object" || message.joints === null)
            return;
        const sequence = typeof message.seq === "number" ? message.seq : peer.lastSequence + 1;
        if (!Number.isSafeInteger(sequence) || sequence <= peer.lastSequence)
            return;
        if (this.controlOwner !== null && this.controlOwner !== peer.id) {
            // A controller can vanish without a clean ICE close (for example, a
            // laptop is powered off). The next deliberate action takes control;
            // stale peers must never prevent another LAN operator from recovering.
            const previous = this.peers.get(this.controlOwner);
            if (previous)
                this.releaseControl(previous, false);
            else
                this.controlOwner = null;
        }
        this.controlOwner = peer.id;
        peer.lastSequence = sequence;
        peer.lastControlAt = Date.now();
        this.onControl(message);
    }
    handleSafety(peer, data) {
        let message;
        try {
            message = JSON.parse(this.messageText(data));
        }
        catch {
            return;
        }
        if (message.type === "heartbeat" && this.controlOwner === peer.id) {
            peer.lastControlAt = Date.now();
        }
        else if (message.type === "stop" && this.controlOwner === peer.id) {
            this.onSafetyStop();
            this.releaseControl(peer, false);
        }
    }
    checkWatchdog() {
        if (!this.controlOwner)
            return;
        const peer = this.peers.get(this.controlOwner);
        if (!peer || Date.now() - peer.lastControlAt > this.controlTimeoutMs) {
            if (peer)
                this.releaseControl(peer, true, "watchdog_timeout");
            else {
                this.controlOwner = null;
                this.onControlLost("peer_connection_lost", 0);
            }
        }
    }
    releaseControl(peer, notifyLoss, reason = "peer_connection_lost") {
        if (this.controlOwner !== peer.id)
            return;
        const idleMs = peer.lastControlAt > 0 ? Date.now() - peer.lastControlAt : 0;
        this.controlOwner = null;
        peer.lastControlAt = 0;
        if (notifyLoss)
            this.onControlLost(reason, idleMs);
    }
    async removePeer(peer, reason = "peer_connection_lost") {
        if (peer.closed)
            return;
        peer.closed = true;
        if (peer.disconnectTimer)
            clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
        this.peers.delete(peer.id);
        this.releaseControl(peer, true, reason);
        peer.pc.close();
    }
    send(channel, data, highWaterMark) {
        if (!channel || channel.readyState !== "open" || channel.bufferedAmount > highWaterMark)
            return;
        try {
            channel.send(data);
        }
        catch {
            // Connection-state callbacks own cleanup; a racing close drops this sample.
        }
    }
    messageText(data) {
        if (typeof data === "string")
            return data;
        if (Buffer.isBuffer(data))
            return data.toString("utf-8");
        if (data instanceof ArrayBuffer)
            return Buffer.from(data).toString("utf-8");
        if (ArrayBuffer.isView(data)) {
            return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
        }
        throw new Error("unsupported DataChannel message");
    }
    waitForIceGathering(peer) {
        if (peer.iceGatheringState === "complete")
            return Promise.resolve();
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
exports.RtcGateway = RtcGateway;
