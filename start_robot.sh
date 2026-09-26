#!/usr/bin/env bash
# 轻量遥操作、数据采集与数据管理一键启动（Robot Server）
# 用法: ./start_robot.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${PYTHON_PATH:-}" ]; then
    if [ -x "/home/jiang/miniconda3/envs/lerobot/bin/python3" ]; then
        PYTHON_PATH="/home/jiang/miniconda3/envs/lerobot/bin/python3"
    elif [ -x "/home/nvidia/miniconda3/envs/lerobot/bin/python3" ]; then
        PYTHON_PATH="/home/nvidia/miniconda3/envs/lerobot/bin/python3"
    elif [ -n "${CONDA_PREFIX:-}" ] && [ -x "$CONDA_PREFIX/bin/python3" ]; then
        PYTHON_PATH="$CONDA_PREFIX/bin/python3"
    else
        PYTHON_PATH="$(command -v python3 || true)"
    fi
fi
export PYTHON_PATH
export LEROBOT_PYTHON_PATH="${LEROBOT_PYTHON_PATH:-$PYTHON_PATH}"
export PORT="${PORT:-5173}"
export ENABLE_CAMERA="${ENABLE_CAMERA:-1}"
export CAMERA_SOURCE="${CAMERA_SOURCE:-ros}"
export CAMERA_FPS="${CAMERA_FPS:-30}"
export CAMERA_WIDTH="${CAMERA_WIDTH:-1280}"
export CAMERA_HEIGHT="${CAMERA_HEIGHT:-720}"
# 远程网页预览推流使用独立低分辨率，录制数据仍用上面的 CAMERA_* 高清参数。
# 公网预览需要给 FRP 和其他在线观众留出余量；录制仍使用上方 CAMERA_* 的高清参数。
export WEB_STREAM_WIDTH="${WEB_STREAM_WIDTH:-320}"
export WEB_STREAM_HEIGHT="${WEB_STREAM_HEIGHT:-240}"
export WEB_STREAM_FPS="${WEB_STREAM_FPS:-30}"
export CONTROL_OBSERVATION_FPS="${CONTROL_OBSERVATION_FPS:-30}"
export RTC_VIDEO_FPS="${RTC_VIDEO_FPS:-30}"
export RTC_VIDEO_BITRATE="${RTC_VIDEO_BITRATE:-1500000}"
export RTC_CONTROL_TIMEOUT_MS="${RTC_CONTROL_TIMEOUT_MS:-2000}"
export ENABLE_WEBRTC="${ENABLE_WEBRTC:-1}"
export ENABLE_WEBRTC_VIDEO="${ENABLE_WEBRTC_VIDEO:-1}"
export RTC_STUN_URL="${RTC_STUN_URL:-}"
export RTC_TURN_URL="${RTC_TURN_URL:-}"
export RTC_TURN_USERNAME="${RTC_TURN_USERNAME:-}"
export RTC_TURN_CREDENTIAL="${RTC_TURN_CREDENTIAL:-}"
HTTPS_CERT="${HTTPS_CERT:-}"
HTTPS_KEY="${HTTPS_KEY:-}"
AUTO_HTTPS="${AUTO_HTTPS:-1}"
HTTPS_HOST="${HTTPS_HOST:-}"

echo "=== 通用机械臂数据平台一键启动 ==="
echo "当前设备适配器: ROS2 so101_hardware"
echo "摄像头来源: $CAMERA_SOURCE（默认 ROS 压缩话题；设置 CAMERA_SOURCE=usb 可使用低延迟直读）"
if [ "$ENABLE_WEBRTC" = "0" ] || [ "$ENABLE_WEBRTC" = "false" ]; then
    echo "WebRTC: 已关闭（控制使用 WebSocket）"
elif [ -n "$RTC_TURN_URL" ]; then
    echo "WebRTC: 已开启（TURN 中继可用）"
elif [ -n "$RTC_STUN_URL" ]; then
    echo "WebRTC: 已开启（STUN 打洞，无 TURN 中继）"
else
    echo "WebRTC: 已开启（仅主机候选，适合同一局域网）"
fi
# 清理上次异常退出后仍占用服务端口的进程。
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "错误: PORT 必须是 1-65535 之间的整数: $PORT"
    exit 1
fi

PORT_PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PORT_PIDS" ]; then
    echo "清理端口 $PORT 上的旧进程: $PORT_PIDS"
    kill $PORT_PIDS 2>/dev/null || true

    for _ in $(seq 1 20); do
        if ! lsof -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
            break
        fi
        sleep 0.1
    done

    PORT_PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$PORT_PIDS" ]; then
        echo "旧进程未正常退出，强制清理: $PORT_PIDS"
        kill -9 $PORT_PIDS 2>/dev/null || true
    fi
fi

if [ -z "$HTTPS_CERT" ] && [ -z "$HTTPS_KEY" ] && [ "$AUTO_HTTPS" != "0" ]; then
    if [ -z "$HTTPS_HOST" ]; then
        HTTPS_HOST="$(hostname -I 2>/dev/null | awk '{
            for (i = 1; i <= NF; i++) if ($i ~ /^192\.168\./) { print $i; exit }
            for (i = 1; i <= NF; i++) if ($i ~ /^172\.(1[6-9]|2[0-9]|3[01])\./) { print $i; exit }
            for (i = 1; i <= NF; i++) if ($i ~ /^10\./) { print $i; exit }
            for (i = 1; i <= NF; i++) if ($i !~ /^127\./ && $i !~ /:/) { print $i; exit }
        }')"
    fi
    if [ -z "$HTTPS_HOST" ]; then
        HTTPS_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
    fi
    if ! [[ "$HTTPS_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        echo "错误: 无法自动检测用于 HTTPS 的局域网 IPv4"
        echo "请指定地址后重试: HTTPS_HOST=192.168.1.36 ./start_robot.sh"
        echo "或临时使用 HTTP: AUTO_HTTPS=0 ./start_robot.sh"
        exit 1
    fi

    CERT_DIR="$DIR/.certs"
    HTTPS_CERT="$CERT_DIR/robot-lan.crt"
    HTTPS_KEY="$CERT_DIR/robot-lan.key"
    if [ ! -f "$HTTPS_CERT" ] || [ ! -f "$HTTPS_KEY" ] \
        || ! openssl x509 -in "$HTTPS_CERT" -noout -checkip "$HTTPS_HOST" >/dev/null 2>&1; then
        echo "正在为 $HTTPS_HOST 生成局域网 HTTPS 证书..."
        "$DIR/scripts/generate-lan-cert.sh" "$HTTPS_HOST"
    fi
fi

if [ -n "$HTTPS_CERT" ] || [ -n "$HTTPS_KEY" ]; then
    if [ ! -f "$HTTPS_CERT" ] || [ ! -f "$HTTPS_KEY" ]; then
        echo "错误: HTTPS_CERT 或 HTTPS_KEY 文件不存在"
        exit 1
    fi
    export HTTPS_CERT HTTPS_KEY
    WEB_SCHEME="https"
else
    WEB_SCHEME="http"
fi
echo ""

# 串口控制、录制与摄像头都使用项目 Python 环境。
if [ "${ROS2_ONLY:-0}" != "1" ] && [[ "$PYTHON_PATH" == */* ]]; then
    if [ ! -f "$PYTHON_PATH" ] || [ ! -x "$PYTHON_PATH" ]; then
        echo "错误: Python 可执行文件不存在或不可执行: $PYTHON_PATH"
        exit 1
    fi
elif [ "${ROS2_ONLY:-0}" != "1" ] && [ "$NEEDS_APP_PYTHON" -eq 1 ]; then
    if ! command -v "$PYTHON_PATH" >/dev/null 2>&1; then
        echo "错误: PATH 中找不到 Python 命令: $PYTHON_PATH"
        echo "当前 PATH: $PATH"
        exit 1
    fi
    PYTHON_PATH="$(command -v "$PYTHON_PATH")"
    export PYTHON_PATH
fi

if [ "$ENABLE_CAMERA" != "0" ] && [ "$CAMERA_SOURCE" = "usb" ]; then
    if ! command -v gst-launch-1.0 >/dev/null 2>&1 \
        || ! gst-inspect-1.0 v4l2src fdsink >/dev/null 2>&1; then
        echo "错误: 缺少 GStreamer 摄像头运行时或 v4l2src/fdsink 插件"
        echo "请安装: sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-good"
        exit 1
    fi
    if [ "${ROS2_ONLY:-0}" != "1" ] && ! "$PYTHON_PATH" -c "from lerobot.datasets.lerobot_dataset import LeRobotDataset" >/dev/null 2>&1; then
        echo "错误: Python 环境缺少采集数据依赖"
        echo "请安装项目与机械臂依赖后重试。"
        exit 1
    fi
fi
if [ "${ROS2_ONLY:-0}" != "1" ] && ! "$LEROBOT_PYTHON_PATH" -c "import scservo_sdk; from lerobot.motors.feetech import FeetechMotorsBus" >/dev/null 2>&1; then
    echo "错误: Python 环境缺少 Feetech 电机依赖"
    exit 1
fi

# 检查 Node.js 版本
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo "0")
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "错误: Node.js 版本过低 (v$NODE_MAJOR), 需要 v18+"
    echo "请安装新版 Node.js:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
fi

# 安装依赖
# 默认 registry 不可达时自动回退到国内镜像，避免安装直接超时失败。
npm_install() {
    npm install || npm install --registry=https://registry.npmmirror.com
}

# 原生模块检查：better-sqlite3 保存登录与权限数据，必须可用。
# wrtc 的平台二进制缺失时服务会自动降级为无 WebRTC，不阻断启动。
if ! (cd "$DIR/robot-server" && node -e "const Database = require('better-sqlite3'); new Database(':memory:');" >/dev/null 2>&1); then
    echo "错误: better-sqlite3 原生模块无法加载（常见于 node_modules 从其他架构的机器拷贝而来）"
    echo "请在本机重新编译:"
    echo "  cd $DIR/robot-server && npm rebuild better-sqlite3 --build-from-source"
    exit 1
fi

# node_modules 从其他机器拷贝过来时常丢失 .bin 软链接和执行位，先在本地修复，避免无谓联网安装。
restore_npm_bins() {
    local pkg_dir="$1"
    [ -d "$pkg_dir/node_modules" ] || return 0
    NPM_BIN_ROOT="$pkg_dir" "$PYTHON_PATH" - <<'PY' || true
import json, os, stat

nm = os.path.join(os.environ["NPM_BIN_ROOT"], "node_modules")
bin_dir = os.path.join(nm, ".bin")
os.makedirs(bin_dir, exist_ok=True)
created = 0

def iter_packages(base, prefix=""):
    for name in sorted(os.listdir(base)):
        if name == ".bin" or name.startswith("."):
            continue
        path = os.path.join(base, name)
        if not os.path.isdir(path):
            continue
        if name.startswith("@"):
            for nested in iter_packages(path, name + "/"):
                yield nested
            continue
        yield prefix + name, path

for pkg_name, pkg_dir in iter_packages(nm):
    pkg_json = os.path.join(pkg_dir, "package.json")
    if not os.path.isfile(pkg_json):
        continue
    try:
        with open(pkg_json, "r", encoding="utf-8") as handle:
            declared = json.load(handle).get("bin")
    except Exception:
        continue
    if not declared:
        continue
    entries = [(pkg_name.split("/")[-1], declared)] if isinstance(declared, str) else list(declared.items())
    for command, relative in entries:
        target = os.path.join(pkg_dir, relative)
        if not os.path.isfile(target):
            continue
        os.chmod(target, os.stat(target).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        link = os.path.join(bin_dir, command)
        if os.path.lexists(link):
            continue
        os.symlink(os.path.relpath(target, bin_dir), link)
        created += 1

# esbuild 的平台二进制由安装脚本下载，拷贝后常丢失执行位。
esbuild_root = os.path.join(nm, "@esbuild")
if os.path.isdir(esbuild_root):
    for platform in os.listdir(esbuild_root):
        binary = os.path.join(esbuild_root, platform, "bin", "esbuild")
        if os.path.isfile(binary):
            os.chmod(binary, os.stat(binary).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

if created:
    print("已补建 %d 个 .bin 软链接: %s" % (created, os.environ["NPM_BIN_ROOT"]))
PY
}
restore_npm_bins "$DIR/robot-server"
restore_npm_bins "$DIR/frontend"

if [ ! -x "$DIR/robot-server/node_modules/.bin/tsc" ]; then
    echo "安装 robot-server 依赖..."
    cd "$DIR/robot-server" && npm_install
fi
if [ ! -x "$DIR/frontend/node_modules/.bin/vite" ]; then
    echo "安装 frontend 依赖..."
    cd "$DIR/frontend" && npm_install
fi
if [ ! -x "$DIR/robot-server/node_modules/.bin/tsc" ] || [ ! -x "$DIR/frontend/node_modules/.bin/vite" ]; then
    echo "错误: 依赖安装后仍缺少构建工具（tsc / vite）"
    echo "可尝试清理后重装: rm -rf robot-server/node_modules frontend/node_modules，然后重新运行本脚本。"
    exit 1
fi

# 生产模式直接由 Robot Server 托管前端，避免 Vite 代理视频造成 CPU 和网络队列抖动。
FRONTEND_OUTPUT="$DIR/frontend/dist/index.html"
if [ ! -f "$FRONTEND_OUTPUT" ] \
    || [ "$DIR/frontend/vite.config.ts" -nt "$FRONTEND_OUTPUT" ] \
    || find "$DIR/frontend/src" -type f -newer "$FRONTEND_OUTPUT" -print -quit | grep -q .; then
    echo "前端源码有更新，正在构建生产资源..."
    cd "$DIR/frontend"
    npm run build
fi

# 日常启动直接运行编译后的服务端；仅源文件变化时重新构建。
BACKEND_OUTPUT="$DIR/robot-server/dist/index.js"
BACKEND_NEEDS_BUILD=0
if [ ! -f "$BACKEND_OUTPUT" ] \
    || [ "$DIR/robot-server/tsconfig.json" -nt "$BACKEND_OUTPUT" ] \
    || find "$DIR/robot-server/src" -type f -newer "$BACKEND_OUTPUT" -print -quit | grep -q .; then
    BACKEND_NEEDS_BUILD=1
fi
if [ "$BACKEND_NEEDS_BUILD" -eq 1 ]; then
    echo "服务端源码有更新，正在构建..."
    cd "$DIR/robot-server"
    npm run build
fi

# 后台启动 robot-server
echo "启动 robot-server (端口 $PORT)..."
node "$BACKEND_OUTPUT" &
BACKEND_PID=$!

cleanup() {
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 等待后端就绪
echo -n "      等待后端就绪"
for i in $(seq 1 80); do
    if curl --noproxy "*" --connect-timeout 0.1 --max-time 0.2 -k -s "$WEB_SCHEME://localhost:$PORT/health" > /dev/null 2>&1; then
        echo " OK"
        break
    fi
    if [ $((i % 10)) -eq 0 ]; then echo -n "."; fi
    sleep 0.05
    if [ "$i" -eq 80 ]; then
        echo " 超时"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
done

echo ""
echo "========================================"
if [ -n "$HTTPS_HOST" ]; then
    echo "  浏览器打开: $WEB_SCHEME://$HTTPS_HOST:$PORT"
else
    echo "  浏览器打开: $WEB_SCHEME://localhost:$PORT"
fi
echo "  API 服务:   $WEB_SCHEME://localhost:$PORT"
echo "  Ctrl+C 退出"
echo "========================================"
echo ""

wait "$BACKEND_PID"
