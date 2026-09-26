"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RobotBridge = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
/**
 * RobotBridge - 管理 stdio JSON bridge 子进程。
 */
class RobotBridge extends events_1.EventEmitter {
    constructor(bridgePath, args, pythonPath = "python3", direct = false) {
        super();
        this.process = null;
        this.buffer = "";
        this.stderrTail = [];
        this.stderrBuffer = "";
        this.maxLogLength = 1000;
        this.bridgePath = bridgePath;
        this.args = args;
        this.pythonPath = pythonPath;
        this.direct = direct;
    }
    start() {
        const command = this.direct ? this.bridgePath : this.pythonPath;
        const commandArgs = this.direct ? this.args : [this.bridgePath, ...this.args];
        this.writeLog("info", `启动 ${this.direct ? "ROS2" : "Python"} 桥接: ${command} ${commandArgs.join(" ")}`);
        this.process = (0, child_process_1.spawn)(command, commandArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        // Python 初始化失败或退出后，网页仍可能短暂发送动作。监听 stdin 错误，
        // 防止 EPIPE 作为未处理错误杀死整个 robot-server。
        this.process.stdin?.on("error", (err) => {
            if (err.code !== "EPIPE") {
                console.error(`[RobotBridge] stdin 错误:`, err.message);
            }
        });
        this.process.stdout?.on("data", (data) => {
            this.buffer += data.toString();
            const lines = this.buffer.split("\n");
            // 最后一个元素可能是不完整的行，保留在 buffer 中
            this.buffer = lines.pop() || "";
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const msg = JSON.parse(line);
                        this.emit("message", msg);
                    }
                    catch {
                        this.writeLog("warn", `忽略无法解析的 bridge 输出: ${this.sanitizeLog(line)}`);
                    }
                }
            }
        });
        this.process.stderr?.on("data", (data) => {
            this.stderrBuffer += data.toString();
            const lines = this.stderrBuffer.split(/\r?\n/);
            this.stderrBuffer = lines.pop() || "";
            for (const line of lines)
                this.handleStderrLine(line);
        });
        this.process.on("exit", (code, signal) => {
            if (this.stderrBuffer.trim())
                this.handleStderrLine(this.stderrBuffer);
            this.stderrBuffer = "";
            const exitDetail = signal ? `signal=${signal}` : `code=${code}`;
            this.writeLog(code === 0 ? "info" : "error", `${this.direct ? "ROS2" : "Python"} bridge 进程退出 (${exitDetail})`);
            this.emit("exit", code, code && code !== 0 ? this.lastErrorLine() : null);
        });
        this.process.on("error", (err) => {
            console.error(`[RobotBridge] Python 进程错误:`, err);
            this.emit("error", err);
        });
    }
    send(msg) {
        const child = this.process;
        const stdin = child?.stdin;
        if (!child || child.exitCode !== null || !stdin?.writable || stdin.destroyed)
            return;
        try {
            stdin.write(JSON.stringify(msg) + "\n", (err) => {
                if (err && err.code !== "EPIPE") {
                    console.error(`[RobotBridge] 动作写入失败:`, err.message);
                }
            });
        }
        catch (err) {
            // 子进程退出和网页动作之间存在竞争条件；忽略该动作，等待状态广播。
            if (err.code !== "EPIPE") {
                console.error(`[RobotBridge] 动作写入异常:`, err);
            }
        }
    }
    stop() {
        const child = this.process;
        if (!child || child.exitCode !== null)
            return;
        child.kill("SIGTERM");
        // 串口驱动偶尔会阻塞在原生调用中；超过 2 秒仍未退出则强制回收。
        setTimeout(() => {
            if (child.exitCode === null)
                child.kill("SIGKILL");
        }, 2000).unref();
    }
    isRunning() {
        return this.process !== null && this.process.exitCode === null;
    }
    // Python Traceback 的最后一行通常是 "XxxError: 具体原因"，优先取这一行；
    // 找不到则退化为 stderr 最后一行非空文本。
    lastErrorLine() {
        const errorLine = [...this.stderrTail].reverse().find((line) => /Error[:\s]/.test(line));
        if (errorLine)
            return errorLine.trim();
        return this.stderrTail.length > 0 ? this.stderrTail[this.stderrTail.length - 1].trim() : null;
    }
    sanitizeLog(value) {
        const text = value.trim();
        if (text.length <= this.maxLogLength)
            return text;
        return `${text.slice(0, this.maxLogLength)}… [已截断 ${text.length - this.maxLogLength} 字符]`;
    }
    handleStderrLine(line) {
        const message = this.sanitizeLog(line);
        if (!message)
            return;
        // 保留最后若干行，用于进程异常退出时向前端展示原因。
        this.stderrTail.push(message);
        if (this.stderrTail.length > 20)
            this.stderrTail = this.stderrTail.slice(-20);
        if (!this.shouldSuppressStderr(message)) {
            this.writeLog(this.classifyStderr(message), message);
        }
    }
    shouldSuppressStderr(message) {
        return (/^\[libx264\b/.test(message)
            || /^\[Teleop\] 已运行 \d+ 帧$/.test(message)
            || /^frame=\s*\d+/.test(message));
    }
    classifyStderr(message) {
        if (/^\[Teleop\] 收到信号 \d+/.test(message)
            || /^\[Teleop\]/.test(message)
            || /^\[(?:INFO|DEBUG)\]/i.test(message))
            return "info";
        if (/warning|warn|警告/i.test(message))
            return "warn";
        if (/traceback|exception|\berror\b|failed|失败|异常/i.test(message))
            return "error";
        return "info";
    }
    writeLog(level, message) {
        const prefix = "[RobotBridge]";
        const output = `${prefix} ${message}`;
        if (level === "error")
            console.error(output);
        else if (level === "warn")
            console.warn(output);
        else
            console.log(output);
        this.emit("log", { level, message });
    }
}
exports.RobotBridge = RobotBridge;
