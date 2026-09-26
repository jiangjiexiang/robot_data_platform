"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GStreamerCameraBridge = exports.JpegStreamParser = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
class JpegStreamParser {
    constructor() {
        this.buffer = Buffer.alloc(0);
    }
    push(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const frames = [];
        while (true) {
            const start = this.buffer.indexOf(JPEG_START);
            if (start < 0) {
                this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
                break;
            }
            const end = this.buffer.indexOf(JPEG_END, start + JPEG_START.length);
            if (end < 0) {
                if (start > 0)
                    this.buffer = this.buffer.subarray(start);
                break;
            }
            const frameEnd = end + JPEG_END.length;
            frames.push(this.buffer.subarray(start, frameEnd));
            this.buffer = this.buffer.subarray(frameEnd);
        }
        return frames;
    }
}
exports.JpegStreamParser = JpegStreamParser;
class GStreamerCameraBridge extends events_1.EventEmitter {
    constructor(cameraIndex, width, height, fps) {
        super();
        this.cameraIndex = cameraIndex;
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.process = null;
        this.parser = new JpegStreamParser();
        this.stopping = false;
        this.reconnectTimer = null;
        this.statusTimer = null;
        this.framesSinceStatus = 0;
        this.framesDroppedSinceStatus = 0;
        this.statusStartedAt = 0;
        this.lastFrameEmittedAt = 0;
        this.reconnects = 0;
        this.ready = false;
        this.lastError = "";
    }
    start() {
        if (this.process || this.reconnectTimer)
            return;
        this.stopping = false;
        this.startPipeline();
    }
    stop() {
        this.stopping = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.statusTimer)
            clearInterval(this.statusTimer);
        this.reconnectTimer = null;
        this.statusTimer = null;
        const child = this.process;
        this.process = null;
        if (!child || child.exitCode !== null)
            return;
        child.kill("SIGTERM");
        setTimeout(() => {
            if (child.exitCode === null)
                child.kill("SIGKILL");
        }, 1000).unref();
    }
    isRunning() {
        return this.process !== null && this.process.exitCode === null;
    }
    startPipeline() {
        this.parser = new JpegStreamParser();
        this.ready = false;
        this.framesSinceStatus = 0;
        this.framesDroppedSinceStatus = 0;
        this.statusStartedAt = Date.now();
        this.lastFrameEmittedAt = 0;
        const device = `/dev/video${this.cameraIndex}`;
        const args = [
            "-q",
            "v4l2src", `device=${device}`, "io-mode=mmap", "do-timestamp=true",
            // USB MJPEG cameras often expose each resolution at only one frame
            // rate. Let V4L2 select its supported rate instead of requesting the
            // lower web-preview rate and causing a not-negotiated restart loop.
            "!", `image/jpeg,width=${this.width},height=${this.height}`,
            "!", "queue", "leaky=downstream", "max-size-buffers=1", "max-size-bytes=0", "max-size-time=0",
            "!", "fdsink", "fd=1", "sync=false",
        ];
        const child = (0, child_process_1.spawn)("gst-launch-1.0", args, { stdio: ["ignore", "pipe", "pipe"] });
        this.process = child;
        child.stdout?.on("data", (chunk) => {
            const frames = this.parser.push(chunk);
            if (frames.length === 0)
                return;
            // Camera devices can only expose 30 FPS at a chosen MJPEG resolution.
            // The browser stream must honor the lower configured preview rate, and
            // only the newest complete JPEG is useful when frames arrive in a burst.
            this.framesDroppedSinceStatus += Math.max(0, frames.length - 1);
            const now = Date.now();
            // Date.now() is integer milliseconds. Give a small tolerance so a
            // native 30 FPS source (33 ms/34 ms alternating intervals) is not
            // accidentally reduced to every other frame.
            if (now - this.lastFrameEmittedAt < 900 / Math.max(1, this.fps)) {
                this.framesDroppedSinceStatus += 1;
                return;
            }
            const frame = frames[frames.length - 1];
            this.lastFrameEmittedAt = now;
            this.framesSinceStatus += 1;
            if (!this.ready) {
                this.ready = true;
                this.lastError = "";
                this.emitMessage({
                    type: "camera_ready",
                    camera_index: this.cameraIndex,
                    width: this.width,
                    height: this.height,
                    fps: this.fps,
                    fourcc: "MJPG-direct",
                    reconnects: this.reconnects,
                });
            }
            this.emitMessage({ type: "camera_frame", data: frame, ts: now / 1000 });
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-2000);
        });
        child.on("error", (error) => this.handleExit(child, error.message));
        child.on("exit", (code) => this.handleExit(child, stderr.trim() || `GStreamer exited with code ${code}`));
        if (this.statusTimer)
            clearInterval(this.statusTimer);
        this.statusTimer = setInterval(() => {
            const elapsedSeconds = Math.max(0.001, (Date.now() - this.statusStartedAt) / 1000);
            this.emitMessage({
                type: "camera_status",
                camera_index: this.cameraIndex,
                measured_fps: this.framesSinceStatus / elapsedSeconds,
                frames_dropped: this.framesDroppedSinceStatus,
                reconnects: this.reconnects,
            });
            this.framesSinceStatus = 0;
            this.framesDroppedSinceStatus = 0;
            this.statusStartedAt = Date.now();
        }, 2000);
        this.statusTimer.unref();
    }
    handleExit(child, reason) {
        if (this.process !== child)
            return;
        this.process = null;
        if (this.stopping || this.reconnectTimer)
            return;
        this.reconnects += 1;
        const error = `${reason || "摄像头管线退出"}，1 秒后重连`;
        if (error !== this.lastError) {
            this.lastError = error;
            this.emitMessage({
                type: "camera_error",
                camera_index: this.cameraIndex,
                error,
                recovering: true,
            });
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.stopping)
                this.startPipeline();
        }, 1000);
    }
    emitMessage(message) {
        this.emit("message", message);
    }
}
exports.GStreamerCameraBridge = GStreamerCameraBridge;
