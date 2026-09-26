"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MJPEGStreamManager = void 0;
/**
 * MJPEGStreamManager - 管理 MJPEG 视频流
 * 缓存最新帧，支持多个客户端连接
 */
class MJPEGStreamManager {
    constructor() {
        this.latestFrames = new Map();
        this.boundaries = new Map();
        // 为每个流设置 boundary 标识
        this.boundaries.set("camera", "boundary_camera");
        this.boundaries.set("camera2", "boundary_camera2");
        this.boundaries.set("camera3", "boundary_camera3");
        this.boundaries.set("camera4", "boundary_camera4");
    }
    /**
     * 更新指定流的最新帧
     * @param streamName 流名称 ("camera" | "camera2")
     * @param jpegBuffer JPEG 图片的 Buffer
     */
    updateFrame(streamName, jpegBuffer) {
        this.latestFrames.set(streamName, jpegBuffer);
    }
    /**
     * 处理 MJPEG HTTP 请求，持续推送帧
     */
    handleStream(streamName, req, res) {
        const boundary = this.boundaries.get(streamName);
        if (!boundary) {
            res.status(404).send(`Stream '${streamName}' not found`);
            return;
        }
        res.writeHead(200, {
            "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        // 定期发送最新帧
        let lastSentFrame = null;
        const interval = setInterval(() => {
            const frame = this.latestFrames.get(streamName);
            if (frame && frame !== lastSentFrame) {
                const header = [
                    `--${boundary}`,
                    "Content-Type: image/jpeg",
                    `Content-Length: ${frame.length}`,
                    "",
                    "",
                ].join("\r\n");
                try {
                    res.write(header);
                    res.write(frame);
                    res.write("\r\n");
                    lastSentFrame = frame;
                }
                catch {
                    clearInterval(interval);
                }
            }
        }, 33); // ~30fps
        req.on("close", () => {
            clearInterval(interval);
        });
    }
}
exports.MJPEGStreamManager = MJPEGStreamManager;
