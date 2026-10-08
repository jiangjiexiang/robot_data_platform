"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BagRecorderProcess = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
/**
 * BagRecorderProcess - 管理 `ros2 bag record` 子进程。
 * 与 RobotBridge 不同，rosbag2 没有 stdin JSON 协议，只能靠信号控制生命周期：
 * SIGINT 让 rosbag2 正常 flush 并关闭 mcap 文件，SIGKILL 仅作超时兜底。
 */
class BagRecorderProcess extends events_1.EventEmitter {
    constructor(outputDir, topics) {
        super();
        this.outputDir = outputDir;
        this.topics = topics;
        this.process = null;
        this.outputBuffer = "";
        this.readyEmitted = false;
        this.readyTimer = null;
        this.qosOverridesPath = null;
        this.storageConfigPath = null;
    }
    start() {
        const configuredCacheSize = Number(process.env.ROSBAG_MAX_CACHE_SIZE);
        const cacheSize = Number.isSafeInteger(configuredCacheSize) && configuredCacheSize > 0
            ? configuredCacheSize
            : 256 * 1024 * 1024;
        this.qosOverridesPath = `${this.outputDir}.qos.yaml`;
        fs_1.default.writeFileSync(this.qosOverridesPath, [
            "/camera1/image_raw:",
            "  history: keep_last",
            "  depth: 30",
            "  reliability: best_effort",
            "  durability: volatile",
            "/camera2/image_raw:",
            "  history: keep_last",
            "  depth: 30",
            "  reliability: best_effort",
            "  durability: volatile",
            "",
        ].join("\n"));
        this.storageConfigPath = `${this.outputDir}.mcap.yaml`;
        fs_1.default.writeFileSync(this.storageConfigPath, [
            "noChunking: false",
            "noChunkCRC: false",
            "noMessageIndex: false",
            "noSummary: false",
            "chunkSize: 16777216",
            'compression: "None"',
            "",
        ].join("\n"));
        const args = [
            "bag", "record", "-o", this.outputDir, "-s", "mcap",
            "--storage-config-file", this.storageConfigPath,
            "--max-cache-size", String(cacheSize),
            "--qos-profile-overrides-path", this.qosOverridesPath,
            ...this.topics,
        ];
        this.emit("log", {
            level: "info",
            message: `rosbag2 参数：MCAP 16 MiB 分块、保留索引和校验、无压缩，缓存 ${(cacheSize / 1024 / 1024).toFixed(0)} MiB，相机 QoS best_effort/depth=30，录制话题 ${this.topics.join(", ")}`,
        });
        this.process = (0, child_process_1.spawn)("ros2", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
        });
        this.process.stdout?.on("data", (data) => this.handleOutputChunk(data));
        this.process.stderr?.on("data", (data) => this.handleOutputChunk(data));
        // rosbag2 通常几百毫秒内打印 "Recording..."；找不到也不能卡死状态机。
        this.readyTimer = setTimeout(() => this.markReady(), 1500).unref();
        this.process.on("exit", (code, signal) => {
            if (this.readyTimer) {
                clearTimeout(this.readyTimer);
                this.readyTimer = null;
            }
            if (this.outputBuffer.trim())
                this.handleLine(this.outputBuffer);
            this.outputBuffer = "";
            this.cleanupQosOverrides();
            this.emit("exit", code, signal);
        });
        this.process.on("error", (err) => {
            if (this.readyTimer) {
                clearTimeout(this.readyTimer);
                this.readyTimer = null;
            }
            this.cleanupQosOverrides();
            this.emit("error", err);
        });
    }
    /** 发送 SIGINT，等待进程退出；超时后升级 SIGKILL。 */
    stop() {
        return new Promise((resolve) => {
            const child = this.process;
            if (!child || (child.exitCode !== null || child.signalCode !== null)) {
                resolve({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
                return;
            }
            const killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill("SIGKILL");
            }, 8000);
            child.once("exit", (code, signal) => {
                clearTimeout(killTimer);
                resolve({ code, signal });
            });
            child.kill("SIGINT");
        });
    }
    isRunning() {
        return this.process !== null && this.process.exitCode === null && this.process.signalCode === null;
    }
    getOutputDir() {
        return this.outputDir;
    }
    cleanupQosOverrides() {
        for (const file of [this.qosOverridesPath, this.storageConfigPath]) {
            if (file) {
                try {
                    fs_1.default.unlinkSync(file);
                }
                catch { /* best effort */ }
            }
        }
        this.qosOverridesPath = null;
        this.storageConfigPath = null;
    }
    handleOutputChunk(data) {
        this.outputBuffer += data.toString();
        const lines = this.outputBuffer.split(/\r?\n/);
        this.outputBuffer = lines.pop() || "";
        for (const line of lines)
            this.handleLine(line);
    }
    handleLine(line) {
        const message = line.trim();
        if (!message)
            return;
        if (!this.readyEmitted && /Recording\.\.\./.test(message))
            this.markReady();
        const level = /traceback|exception|\berror\b|failed/i.test(message)
            ? "error"
            : /warn/i.test(message)
                ? "warn"
                : "info";
        this.emit("log", { level, message });
    }
    markReady() {
        if (this.readyEmitted)
            return;
        this.readyEmitted = true;
        if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
        }
        this.emit("ready");
    }
}
exports.BagRecorderProcess = BagRecorderProcess;
