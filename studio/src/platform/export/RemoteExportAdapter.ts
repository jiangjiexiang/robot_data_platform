import type { ExportAdapter, ExportFormat } from '@/core';

/**
 * 导出回传适配器：把清洗结果按分片直接上传到平台后端，由服务端落进数据集目录。
 *
 * 与 WebExportAdapter 的区别是不在浏览器落盘，也不把全部产物留在内存里：
 * 每个文件按 path 串行、全局有界并发地流到服务端暂存区，finalize() 等所有
 * 上传收尾后再请求 commit，服务端校验元数据并改名成正式数据集。
 *
 * 会话是懒建的（第一个字节才 POST）。ExportService 在开始写入前会调用一次
 * clear()，此时没有会话，clear() 天然是空操作；只有导出失败时（ExportDialog
 * 的 catch 再调一次 clear()）才会真正删除服务端会话。
 */

export interface RemoteExportAdapterOptions {
  /** 源数据集名（平台侧目录名），服务端会校验它存在。 */
  source: string;
  /** 目标数据集名，清洗结果以这个名字入库。 */
  target: string;
  /** 平台 API 前缀；同源部署留空即可。 */
  apiBase?: string;
  /** 目标已存在时是否覆盖（服务端会把旧数据集移入回收目录）。 */
  overwrite?: boolean;
  /** 写入平台审计日志的操作者。 */
  actor?: string;
  /** 服务端下发的分片大小，作为默认值；实际以建会话响应为准。 */
  chunkSizeBytes?: number;
  /** 同时进行中的分片请求数。 */
  concurrency?: number;
  /** 上传进度（已提交字节数 / 已完成文件数）。 */
  onProgress?: (progress: RemoteUploadProgress) => void;
  /** 取消信号；中止后 fetch 抛出 AbortError，finalize 会把它透传给调用方。 */
  signal?: AbortSignal;
}

export interface RemoteUploadProgress {
  uploadedBytes: number;
  fileCount: number;
}

interface RemoteExportSession {
  sessionId: string;
  target: string;
  chunkSizeBytes: number;
}

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;

function normalizeExportPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serverError(
  payload: Record<string, unknown> | null,
  response: Response,
  fallback: string,
): Error {
  const message = typeof payload?.error === 'string' ? payload.error : '';
  return new Error(message || `${fallback}（HTTP ${response.status}）`);
}

export class RemoteExportAdapter implements ExportAdapter {
  private readonly source: string;
  private readonly target: string;
  private readonly apiBase: string;
  private readonly overwrite: boolean;
  private readonly actor: string;
  private readonly concurrency: number;
  private readonly onProgress?: (progress: RemoteUploadProgress) => void;
  private readonly signal?: AbortSignal;
  private preferredChunkBytes: number;

  /** 每个 path 一条串行链：分片必须按 offset 连续上传。 */
  private chains = new Map<string, Promise<void>>();
  private pending = new Set<Promise<void>>();
  private sizes = new Map<string, number>();
  private sessionPromise: Promise<RemoteExportSession> | null = null;
  private session: RemoteExportSession | null = null;
  private firstError: unknown = null;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private uploadedBytes = 0;
  private committed = false;

  constructor(options: RemoteExportAdapterOptions) {
    this.source = options.source.trim();
    this.target = options.target.trim();
    this.apiBase = (options.apiBase ?? '').replace(/\/+$/, '');
    this.overwrite = options.overwrite === true;
    this.actor = options.actor ?? '通用机械臂数据平台';
    this.preferredChunkBytes =
      Number.isFinite(options.chunkSizeBytes) && (options.chunkSizeBytes ?? 0) > 0
        ? (options.chunkSizeBytes as number)
        : DEFAULT_CHUNK_BYTES;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.onProgress = options.onProgress;
    this.signal = options.signal;
    if (!this.source || !this.target) {
      throw new Error('RemoteExportAdapter 需要 source 与 target 数据集名');
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const relative = normalizeExportPath(path);
    if (!relative) throw new Error(`导出文件路径无效: ${path}`);
    this.sizes.set(relative, content.length);
    const previous = this.chains.get(relative) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.firstError) return;
      await this.acquireSlot();
      try {
        await this.uploadFile(relative, content);
      } catch (error) {
        if (this.firstError === null) this.firstError = error;
      } finally {
        this.releaseSlot();
      }
    });
    this.chains.set(relative, next);
    this.pending.add(next);
    void next.finally(() => {
      this.pending.delete(next);
      if (this.chains.get(relative) === next) this.chains.delete(relative);
    });
    // 对 await 本方法的调用方形成背压：上传没排空前不要继续生成下一个大文件。
    await next;
  }

  readFile(path: string): Promise<Uint8Array> {
    return Promise.reject(new Error(`RemoteExportAdapter 直接流式上传，不支持读回文件: ${path}`));
  }

  async createDirectory(path: string): Promise<void> {
    void path; // 服务端按文件路径自动建目录
  }

  hasFile(path: string): boolean {
    return this.sizes.has(normalizeExportPath(path));
  }

  listFiles(): string[] {
    return Array.from(this.sizes.keys());
  }

  clear(): void {
    const session = this.session;
    this.chains.clear();
    this.pending.clear();
    this.sizes.clear();
    this.session = null;
    this.sessionPromise = null;
    this.firstError = null;
    if (session && !this.committed) {
      void this.deleteSession(session.sessionId);
    }
  }

  async finalize(format: ExportFormat): Promise<void> {
    void format;
    // 先等所有链跑完；链内部会派生新链（不会，但保险起见循环等待 pending 清空）。
    while (this.pending.size > 0) {
      await Promise.all(Array.from(this.pending));
    }
    if (this.firstError) throw this.firstError;
    if (this.committed) return;
    if (this.sizes.size === 0) throw new Error('没有可上传的导出文件');
    const session = await this.ensureSession();
    const response = await fetch(
      `${this.apiBase}/api/studio-export/sessions/${encodeURIComponent(session.sessionId)}/commit`,
      { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } },
    );
    const payload = await readJson(response);
    if (!response.ok || payload?.ok !== true) {
      throw serverError(payload, response, '保存数据集失败');
    }
    this.committed = true;
  }

  /** 已提交的数据集名（commit 之后可用）。 */
  committedDataset(): string | null {
    return this.committed ? this.target : null;
  }

  private async uploadFile(relative: string, content: Uint8Array): Promise<void> {
    const session = await this.ensureSession();
    const chunkSize = Math.max(64 * 1024, Math.floor(session.chunkSizeBytes));
    let offset = 0;
    // 空文件也要发一次请求，服务端才知道它的存在（size 0）。
    do {
      const start = offset;
      const end = Math.min(offset + chunkSize, content.length);
      const chunk = content.subarray(offset, end);
      const url =
        `${this.apiBase}/api/studio-export/sessions/${encodeURIComponent(session.sessionId)}/file` +
        `?path=${encodeURIComponent(relative)}&offset=${offset}`;
      const response = await fetch(url, {
        method: 'PUT',
        credentials: 'same-origin',
        signal: this.signal,
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-size': String(content.length),
        },
        body: chunk as unknown as BodyInit,
      });
      const payload = await readJson(response);
      if (!response.ok || payload?.ok !== true) {
        throw serverError(payload, response, `上传 ${relative} 失败`);
      }
      const reported = Number(payload.size);
      offset = Number.isFinite(reported) && reported > offset ? reported : end;
      this.uploadedBytes += offset - start;
      this.onProgress?.({ uploadedBytes: this.uploadedBytes, fileCount: this.sizes.size });
    } while (offset < content.length);
  }

  private ensureSession(): Promise<RemoteExportSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().catch((error: unknown) => {
        this.sessionPromise = null;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  private async createSession(): Promise<RemoteExportSession> {
    const response = await fetch(`${this.apiBase}/api/studio-export/sessions`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        source: this.source,
        target: this.target,
        overwrite: this.overwrite,
        actor: this.actor,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok || payload?.ok !== true) {
      throw serverError(payload, response, '创建导出会话失败');
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) throw new Error('导出会话响应缺少 sessionId');
    const chunk = Number(payload.chunkSizeBytes);
    const session: RemoteExportSession = {
      sessionId,
      target: typeof payload.target === 'string' ? payload.target : this.target,
      chunkSizeBytes: Number.isFinite(chunk) && chunk > 0 ? chunk : this.preferredChunkBytes,
    };
    this.session = session;
    return session;
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.apiBase}/api/studio-export/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    } catch {
      /* 服务端有 TTL 兜底，删除失败不用打扰用户 */
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
