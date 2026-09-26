# 上传数据集到训练主机

数据采集平台负责把本地数据集（当前为 rosbag 采集目录）通过 rsync 推送到训练主机；
rosbag → LeRobot 转换和训练都在训练主机上的独立平台执行。转换工具
`tools/rosbag_to_act/rosbag_to_lerobot.py` 随本仓库发布，训练主机也可以检出本仓库
后直接用它转换上传过来的 bag 数据集。

## 一次性准备：SSH 免密

1. 打开网页「上传训练主机」页面，右侧「本机公钥」会显示 Orin 的 SSH 公钥
   （若为空，先在 Orin 上执行 `ssh-keygen -t ed25519`）。
2. 把该公钥追加到训练主机的 `~/.ssh/authorized_keys`：

   ```bash
   # 在 Orin 上执行（替换用户名和训练主机地址）
   ssh-copy-id trainee@192.168.1.20
   ```

3. 确认训练主机装有 `rsync`，并约定一个数据根目录（如 `/data/lerobot`，
   需要当前用户可写）。

上传设置里的「传输方式」默认为 **SSH**（rsync over ssh，走上面的免密准备）。
如果不想在训练主机上配密钥，也可以切换到备选的 rsync 守护进程模式，见文末附录。

## 配置与上传

网页「上传训练主机」页面：

1. 填写主机地址、端口、用户名、数据根目录和重试次数，**保存设置**
   （配置持久化在 `<DATASET_ROOT>/.lerobot-web/upload-settings.json`）。
2. 点「测试连接」验证免密、rsync 与目录可写。
3. 「数据集」页对目标数据集点「上传」；任务进度、传输字节和日志在
   「上传任务」页查看，失败可点「重试」。
4. 打开「启用自动上传」后，每次录制保存完成会自动把该数据集入队上传。

## 传输语义

- 命令等价于
  `rsync -a --partial --exclude=.lerobot-web <DATASET_ROOT>/<dataset>/ user@host:<remoteRoot>/<dataset>/`。
- 排除 `.lerobot-web` sidecar（审核、回收站等平台元数据不交付给训练侧）。
- `--partial` 保证中断后续传；任务失败按设置的重试次数自动重新入队。
- 传输成功后再跑一次 `rsync -n --stats` 复核，远端增量必须为 0，任务才标记
  「已复核」。训练主机侧看到的目录结构与 Orin 完全一致。
- 正在录制中的数据集会拒绝上传。

## API 一览（robot-server）

| 端点 | 说明 |
| --- | --- |
| `GET/PUT /api/upload/settings` | 读取/保存上传配置 |
| `POST /api/upload/check` | SSH 连通性 + rsync + 目录可写检查 |
| `POST /api/datasets/:dataset/upload` | 数据集入队上传 |
| `GET /api/upload/tasks` | 任务列表（含进度、日志尾、复核结果） |
| `POST /api/upload/tasks/:id/retry` | 失败任务重试 |

## 与训练平台的对接约定

- 落盘路径：`<remoteRoot>/<dataset_name>/`，目录布局与 Orin 的 `DATASET_ROOT` 一致。
- rosbag 型数据集：每个 `episode_xxxx/` 是一个 MCAP ROS2 bag，附同名
  `episode_xxxx.json` sidecar（任务名、起止时间），可直接用转换工具读取。
- 转换语义与字段对齐见 [ROS bag 到 ACT](ROSBAG_TO_ACT.md)。

## 附录：rsync 守护进程模式（免密钥备选）

如果不想配 SSH 密钥，可在训练主机上跑 rsync daemon，仅局域网可达、免认证：

```bash
# 训练主机上创建 /etc/rsyncd.conf
cat > /etc/rsyncd.conf <<'EOF'
uid = train
gid = train
read only = false
use chroot = false

[lerobot]
path = /data/lerobot
comment = robot datasets
EOF

mkdir -p /data/lerobot && chown train:train /data/lerobot
rsync --daemon --config=/etc/rsyncd.conf --port=873   # 前台常驻可改用 systemd
```

然后在网页「上传训练主机」把传输方式切到「rsync 守护进程」，填主机 IP、
端口 873、模块名 `lerobot`，保存后点「测试连接」确认模块可见即可上传。
数据落盘为 `/data/lerobot/<dataset>/`（模块 path + 数据集名）。

注意：该模式传输不加密、无访问控制，只适合封闭局域网；训练主机防火墙
不要向公网暴露 873 端口。
