/**
 * 宿主平台检测：Studio 以独立页面挂在平台后端（/studio/）下时，URL 会带上
 * ?manifest=/api/datasets/:name/studio-manifest（或等价的 ?url=manifest://…）。
 * 命中同源清单就认为运行在平台宿主里，导出可以直接回传后端入库，省掉浏览器落盘
 * 再上传一趟。独立使用（本地文件、zip、远程归档）时返回 null，UI 不显示该目标。
 */

export interface HostPlatformContext {
  /** 平台 API 前缀；只在同源时为相对路径，故恒为空串。 */
  apiBase: string;
  /** 源数据集名（平台数据目录下的文件夹名）。 */
  sourceDataset: string;
}

const MANIFEST_NAME_PATTERN = /\/api\/datasets\/([^/]+)\/studio-manifest$/;

/** 平台数据集目录名规则（与服务端 cleanDatasetName 对齐）。 */
export const PLATFORM_DATASET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidPlatformDatasetName(name: string): boolean {
  return PLATFORM_DATASET_NAME_PATTERN.test((name || '').trim());
}

function decodeManifest(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed.startsWith('manifest://')) return trimmed;
  const suffix = trimmed.slice('manifest://'.length);
  try {
    return decodeURIComponent(suffix);
  } catch {
    return suffix;
  }
}

function resolveManifest(search: string): string | null {
  const params = new URLSearchParams(search);
  const manifest = params.get('manifest');
  if (manifest) return decodeManifest(manifest);
  const url = params.get('url');
  return url ? decodeManifest(url) : null;
}

function datasetNameFromManifest(manifestUrl: string): string | null {
  try {
    const parsed = new URL(manifestUrl, window.location.origin);
    // 跨源清单拿不到平台会话，无法回传，直接判定为非宿主。
    if (parsed.origin !== window.location.origin) return null;
    const match = parsed.pathname.match(MANIFEST_NAME_PATTERN);
    if (!match) return null;
    const name = decodeURIComponent(match[1]).trim();
    return isValidPlatformDatasetName(name) ? name : null;
  } catch {
    return null;
  }
}

export function detectHostPlatform(search?: string): HostPlatformContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const manifest = resolveManifest(search ?? window.location.search);
    if (!manifest) return null;
    const sourceDataset = datasetNameFromManifest(manifest);
    if (!sourceDataset) return null;
    return { apiBase: '', sourceDataset };
  } catch {
    return null;
  }
}

/** 默认目标数据集名：<source>_clean。 */
export function defaultPlatformTargetName(source: string): string {
  const base = (source || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return `${base || 'lerobot'}_clean`;
}
