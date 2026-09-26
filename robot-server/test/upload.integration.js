// 上传训练主机链路的集成测试：用 PATH 里的 stub ssh/rsync 验证
// 设置持久化、连接检查、上传任务状态机、失败后手动重试与复核结果。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "../..");
const port = 45000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "robot-upload-test-"));
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-upload-stub-"));
const failMarker = path.join(stubDir, "fail");
const slowMarker = path.join(stubDir, "slow");
const logs = [];

fs.writeFileSync(path.join(stubDir, "ssh"), [
  "#!/bin/bash",
  // 最后一个参数是远端命令；模拟“已装 rsync、目录可写、df 有余量”。
  "echo WRITABLE",
  "echo '/dev/sda1 1000000 500000 450000 53% /data'",
  "exit 0",
].join("\n"), { mode: 0o755 });

fs.writeFileSync(path.join(stubDir, "rsync"), [
  "#!/bin/bash",
  "for a in \"$@\"; do",
  "  if [ \"$a\" = \"-n\" ]; then echo 'Number of files transferred: 0'; exit 0; fi",
  "done",
  "for a in \"$@\"; do",
  "  if [ \"$a\" = \"--list-only\" ]; then echo lerobot; exit 0; fi",
  "done",
  "if [ -f \"" + failMarker + "\" ]; then echo 'rsync: stub failure' >&2; exit 23; fi",
  "if [ -f \"" + slowMarker + "\" ]; then sleep 4; fi",
  "echo ' 10%   1.00MB    1.00MB/s    0:00:01 (xfr#1, ir-chk=1002/1003)' >&2",
  "echo '100%  10.00MB    5.00MB/s    0:00:02 (xfr#3, to-chk=0/1003)' >&2",
  "exit 0",
].join("\n"), { mode: 0o755 });

async function request(route, options = {}, cookie = "") {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${route}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${body.error || response.status}`);
  return { body, response };
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error("condition timeout");
}

async function main() {
  const server = spawn(process.execPath, ["robot-server/dist/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      PORT: String(port),
      DATASET_ROOT: datasetRoot,
      ENABLE_CAMERA: "0",
      ENABLE_WEBRTC: "0",
      CONTROL_BACKEND: "ros2",
      ROS2_DRIVER: "external",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitFor(async () => (await fetch(`${baseUrl}/health`)).ok);

    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@robot.local", password: "admin" }),
    });
    assert.ok(signIn.ok, `登录失败: ${signIn.status}`);
    const cookie = (signIn.headers.getSetCookie?.() || [])
      .map((line) => line.split(";")[0]).filter(Boolean).join("; ");
    assert.ok(cookie, "没有拿到会话 Cookie");

    // 1) 设置校验与持久化
    await assert.rejects(request("/api/upload/settings", {
      method: "PUT", body: JSON.stringify({ host: "127.0.0.1", user: "trainee", remoteRoot: "data/lerobot" }),
    }, cookie), /绝对路径/);
    await request("/api/upload/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: false, host: "127.0.0.1", port: 22, user: "trainee", remoteRoot: "/data/lerobot", retries: 0 }),
    }, cookie);
    const settings = await request("/api/upload/settings", {}, cookie);
    assert.strictEqual(settings.body.settings.host, "127.0.0.1");
    assert.strictEqual(settings.body.settings.user, "trainee");

    // 2) 连接检查（stub ssh 报 WRITABLE）
    const check = await request("/api/upload/check", { method: "POST", body: "{}" }, cookie);
    assert.ok(check.body.ok && check.body.writable, `连接检查失败: ${JSON.stringify(check.body)}`);

    // 3) 上传任务成功 + 复核通过
    const bagDir = path.join(datasetRoot, "bag_ds", "episode_0000");
    fs.mkdirSync(bagDir, { recursive: true });
    fs.writeFileSync(path.join(datasetRoot, "bag_ds", "episode_0000", "metadata.yaml"), "rosbag2_storage: mcap\n");
    fs.writeFileSync(path.join(bagDir, "demo.mcap"), "x".repeat(64));
    await request("/api/datasets/bag_ds/upload", { method: "POST", body: "{}" }, cookie);
    const successTask = await waitFor(async () => {
      const list = await request("/api/upload/tasks", {}, cookie);
      const task = list.body.tasks.find((item) => item.dataset === "bag_ds");
      return task && task.state === "success" ? task : null;
    });
    assert.strictEqual(successTask.progress, 100);
    assert.ok(successTask.verifiedAt, "复核通过应写 verifiedAt");

    // 4) 失败 → 状态记录 exitCode；删除故障标记后手动重试成功
    fs.writeFileSync(failMarker, "1");
    await request("/api/datasets/bag_ds/upload", { method: "POST", body: "{}" }, cookie);
    const failedTask = await waitFor(async () => {
      const list = await request("/api/upload/tasks", {}, cookie);
      const task = list.body.tasks.find((item) => item.id !== successTask.id && item.dataset === "bag_ds");
      return task && task.state === "failed" ? task : null;
    });
    assert.strictEqual(failedTask.exitCode, 23);
    assert.strictEqual(failedTask.attempts, 1, "retries=0 时不应自动重试");
    fs.rmSync(failMarker);
    await request(`/api/upload/tasks/${failedTask.id}/retry`, { method: "POST", body: "{}" }, cookie);
    const retried = await waitFor(async () => {
      const list = await request("/api/upload/tasks", {}, cookie);
      const task = list.body.tasks.find((item) => item.id === failedTask.id);
      return task && task.state === "success" ? task : null;
    });
    assert.strictEqual(retried.attempts, 2);

    // 5) 同一数据集在队列中时拒绝重复入队
    fs.writeFileSync(slowMarker, "1");
    await request("/api/datasets/bag_ds/upload", { method: "POST", body: "{}" }, cookie);
    await waitFor(async () => {
      const list = await request("/api/upload/tasks", {}, cookie);
      return list.body.tasks.some((item) => item.dataset === "bag_ds" && (item.state === "running" || item.state === "queued"));
    });
    await assert.rejects(request("/api/datasets/bag_ds/upload", { method: "POST", body: "{}" }, cookie), /排队或进行中/);
    fs.rmSync(slowMarker);
    const thirdTask = await waitFor(async () => {
      const list = await request("/api/upload/tasks", {}, cookie);
      const task = list.body.tasks.find((item) => item.finishedAt && item.finishedAt > retried.finishedAt);
      return task && task.state === "success" ? task : null;
    }, 30000);
    assert.ok(thirdTask.verifiedAt);

    // 6) rsync 守护进程模式（局域网免密钥备选）：配置、模块检查与上传
    await assert.rejects(request("/api/upload/settings", {
      method: "PUT", body: JSON.stringify({ method: "rsyncd", host: "127.0.0.1", port: 873, module: "bad module" }),
    }, cookie), /模块名无效/);
    await request("/api/upload/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: false, method: "rsyncd", host: "127.0.0.1", port: 873, module: "lerobot", retries: 0 }),
    }, cookie);
    const daemonCheck = await request("/api/upload/check", { method: "POST", body: "{}" }, cookie);
    assert.ok(daemonCheck.body.ok && daemonCheck.body.modules.includes("lerobot"), JSON.stringify(daemonCheck.body));
    await request("/api/datasets/bag_ds/upload", { method: "POST", body: "{}" }, cookie);
    const rsyncdTask = await waitFor(async () => {
      const list = await request("/api/upload/tasks", {}, cookie);
      const task = list.body.tasks.find((item) => item.finishedAt && item.finishedAt > thirdTask.finishedAt);
      return task && task.state === "success" ? task : null;
    }, 20000);
    assert.ok(rsyncdTask.verifiedAt);
    assert.ok(rsyncdTask.logs.some((line) => line.includes("rsync://127.0.0.1:873/lerobot/bag_ds/")), "上传目标应为 rsync:// URL");

    console.log("Upload-to-training-host integration: OK (ssh + rsyncd)");
  } finally {
    server.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(datasetRoot, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
    if (process.exitCode) console.error(logs.slice(-40).join(""));
  }
}

main().catch((error) => {
  console.error(error);
  console.error(logs.join(""));
  process.exitCode = 1;
});
