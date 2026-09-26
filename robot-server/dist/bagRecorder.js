"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BagRecorderProcess = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
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
    }
    start() {
        const args = ["bag", "record", "-o", this.outputDir, "-s", "mcap", ...this.topics];
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
            this.emit("exit", code, signal);
        });
        this.process.on("error", (err) => {
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
