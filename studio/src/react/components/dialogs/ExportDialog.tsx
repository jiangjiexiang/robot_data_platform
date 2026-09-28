import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui';
import { Button, Input } from '@/ui';
import {
  useLeRobotData,
  useLeRobotSelection,
  useLeRobotSubtask,
} from '../../contexts/LeRobotContext';
import {
  canUseFileSystemAccess,
  defaultPlatformTargetName,
  detectHostPlatform,
  detectPlatformCapabilities,
  ExportService,
  isValidPlatformDatasetName,
  RemoteExportAdapter,
  WebExportAdapter,
} from '@/platform';
import type { RemoteUploadProgress } from '@/platform';
import type { ExportFormat } from '@/core';
import type { ExportProgress } from '@/core';
import { SubtaskCoverageError } from '@/core';

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 || unit === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

export const ExportDialog: React.FC<ExportDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { dataLoader, info, tasks, subtasks } = useLeRobotData();
  const { episodesForExport, modifiedEpisodes, deletedEpisodes, trimRanges } =
    useLeRobotSelection();
  const { overlay } = useLeRobotSubtask();

  const capabilities = useMemo(() => detectPlatformCapabilities(), []);
  /** 平台宿主（/studio/?manifest=…）里才能直接把清洗结果回传入库。 */
  const hostPlatform = useMemo(() => detectHostPlatform(), []);
  const versionCapability = dataLoader?.getVersionCapability() ?? null;

  const defaultTargetVersion = useMemo((): 'v2.1' | 'v3.0' => {
    if (versionCapability?.adapterVersion === 'v3.0') return 'v3.0';
    return 'v2.1';
  }, [versionCapability?.adapterVersion]);

  const [format, setFormat] = useState<ExportFormat>('zip');
  const [destination, setDestination] = useState<'local' | 'platform'>('local');
  const [platformTarget, setPlatformTarget] = useState('');
  const [platformOverwrite, setPlatformOverwrite] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<RemoteUploadProgress | null>(null);
  const [savedDataset, setSavedDataset] = useState<string | null>(null);
  const [targetVersion, setTargetVersion] = useState<'v2.1' | 'v3.0'>(defaultTargetVersion);
  const [includeSubtasks, setIncludeSubtasks] = useState(false);
  const [compactVideos, setCompactVideos] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTargetVersion(defaultTargetVersion);
  }, [defaultTargetVersion]);

  useEffect(() => {
    if (!open) return;
    setIncludeSubtasks(false);
    setExportError(null);
    setUploadProgress(null);
    setSavedDataset(null);
    if (hostPlatform) {
      setPlatformTarget(
        (current) => current || defaultPlatformTargetName(hostPlatform.sourceDataset),
      );
      setPlatformOverwrite(false);
    }
  }, [open, hostPlatform]);

  const handleExport = useCallback(async () => {
    if (!dataLoader || !info) {
      setExportError(t('export.noData', 'No dataset loaded.'));
      return;
    }
    if (versionCapability?.status !== 'supported') {
      setExportError(
        t(
          'export.versionReadOnly',
          'This dataset version is not supported for export and can only be viewed.',
        ),
      );
      return;
    }
    setExportError(null);
    const usePlatform = destination === 'platform' && hostPlatform !== null;
    const platformName = platformTarget.trim();
    if (usePlatform) {
      if (!isValidPlatformDatasetName(platformName)) {
        setExportError(
          t(
            'export.platformNameInvalid',
            'Dataset names may only contain letters, numbers, dots, underscores and dashes.',
          ),
        );
        return;
      }
      if (platformName === hostPlatform.sourceDataset) {
        setExportError(
          t(
            'export.platformNameSameAsSource',
            'The target name must differ from the source dataset.',
          ),
        );
        return;
      }
    }
    let directoryHandle: FileSystemDirectoryHandle | null = null;
    if (!usePlatform && format === 'directory') {
      if (!canUseFileSystemAccess()) {
        setExportError(
          t(
            'source.insecureOriginExportDirectory',
            'Exporting to a folder requires HTTPS or localhost.',
          ),
        );
        return;
      }
      try {
        directoryHandle = await (
          window as Window & {
            showDirectoryPicker: (o?: {
              mode?: 'read' | 'readwrite';
            }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          return;
        }
        setExportError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    setUploadProgress(null);
    setProgress({
      phase: 'metadata',
      current: 0,
      total: 1,
      message: t('export.preparing', 'Preparing...'),
      cancelable: true,
      percent: 0,
    });
    const safeSetProgress = (p: ExportProgress) => {
      try {
        setProgress(p);
      } catch {
        // Ignore if component unmounted or React update fails
      }
    };
    try {
      const adapter =
        usePlatform && hostPlatform
          ? new RemoteExportAdapter({
              source: hostPlatform.sourceDataset,
              target: platformName,
              apiBase: hostPlatform.apiBase,
              overwrite: platformOverwrite,
              signal,
              onProgress: (upload) => {
                try {
                  setUploadProgress(upload);
                } catch {
                  // Ignore if the dialog unmounted mid-upload.
                }
              },
            })
          : new WebExportAdapter(directoryHandle ? { directoryHandle } : undefined);
      const service = new ExportService(dataLoader, adapter);
      try {
        await service.exportWithData(info, episodesForExport, tasks, {
          format: usePlatform ? 'directory' : format,
          targetVersion,
          onProgress: safeSetProgress,
          includeData: true,
          includeVideos: true,
          compactVideos,
          trimRanges,
          includeSubtasks: targetVersion === 'v3.0' && includeSubtasks,
          signal,
          subtaskOverlay: overlay,
          sourceSubtasks: subtasks,
        });
        abortControllerRef.current = null;
        setProgress(null);
        setUploadProgress(null);
        if (usePlatform) {
          // 保持对话框打开，让用户看到入库结果再关闭。
          setSavedDataset(platformName);
        } else {
          onOpenChange(false);
        }
      } catch (innerErr) {
        // Always release any in-memory files staged by the adapter so cancelled
        // or failed exports don't leave megabytes of data held in the closure.
        try {
          adapter.clear();
        } catch {
          /* ignore */
        }
        throw innerErr;
      }
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === 'AbortError';
      try {
        if (isAbort) {
          setExportError(t('export.cancelled', 'Export cancelled.'));
        } else if (e instanceof SubtaskCoverageError) {
          setExportError(
            e.coverage.labeledFrames === 0
              ? t('export.subtaskCoverageMissing', 'Episode #{{index}} has no subtask labels.', {
                  index: e.episodeIndex,
                })
              : t(
                  'export.subtaskCoverageIncomplete',
                  'Episode #{{index}} is missing labels ({{labeled}}/{{total}}).',
                  {
                    index: e.episodeIndex,
                    labeled: e.coverage.labeledFrames,
                    total: e.coverage.totalFrames,
                  },
                ),
          );
        } else {
          const msg =
            e instanceof Error
              ? e.message
              : typeof e === 'string'
                ? e
                : String(e ?? t('export.errorUnknown', 'Export failed'));
          setExportError(msg);
        }
      } finally {
        abortControllerRef.current = null;
        setProgress(null);
      }
    }
  }, [
    dataLoader,
    info,
    versionCapability?.status,
    episodesForExport,
    tasks,
    subtasks,
    overlay,
    format,
    destination,
    hostPlatform,
    platformTarget,
    platformOverwrite,
    targetVersion,
    includeSubtasks,
    compactVideos,
    trimRanges,
    onOpenChange,
    t,
  ]);

  const handleClose = useCallback(() => {
    if (!progress) onOpenChange(false);
  }, [progress, onOpenChange]);

  const isExporting = progress !== null;
  const canExport =
    info && dataLoader && versionCapability?.status === 'supported' && episodesForExport.length > 0;

  const progressPercent = useMemo(() => {
    return (
      progress?.percent ??
      (progress && progress.total > 0 ? (progress.current / progress.total) * 100 : 0)
    );
  }, [progress]);

  const displayPercent = useMemo(() => {
    return Math.min(100, Math.max(0, progressPercent));
  }, [progressPercent]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('export.title', 'Export Dataset')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              'export.a11yDescription',
              'Choose export format and target dataset version, then export to a file or folder.',
            )}
          </DialogDescription>
        </DialogHeader>
        {!isExporting ? (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t('export.format', 'Export Format')}
              </span>
              <div className="flex flex-wrap gap-2">
                {capabilities.supportedExportFormats.includes('zip') && (
                  <Button
                    variant={destination === 'local' && format === 'zip' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setDestination('local');
                      setFormat('zip');
                    }}
                  >
                    ZIP
                  </Button>
                )}
                {capabilities.supportedExportFormats.includes('directory') && (
                  <Button
                    variant={
                      destination === 'local' && format === 'directory' ? 'default' : 'outline'
                    }
                    size="sm"
                    onClick={() => {
                      setDestination('local');
                      setFormat('directory');
                    }}
                  >
                    {t('export.directory', 'Local Directory')}
                  </Button>
                )}
                {hostPlatform && (
                  <Button
                    variant={destination === 'platform' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setDestination('platform')}
                  >
                    {t('export.platform', 'Platform Dataset')}
                  </Button>
                )}
              </div>
            </div>
            {destination === 'platform' && hostPlatform ? (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <label className="text-sm font-medium" htmlFor="export-platform-target">
                  {t('export.platformTarget', 'Target dataset name')}
                </label>
                <Input
                  id="export-platform-target"
                  value={platformTarget}
                  onChange={(event) => setPlatformTarget(event.target.value)}
                  className="font-mono text-sm"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    'export.platformTargetHint',
                    'The cleaned result is uploaded to the platform dataset directory as a new dataset. The source dataset stays untouched.',
                  )}
                </p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
                    checked={platformOverwrite}
                    onChange={(event) => setPlatformOverwrite(event.target.checked)}
                  />
                  <span>
                    {t(
                      'export.platformOverwrite',
                      'Replace an existing dataset with the same name (moved to trash)',
                    )}
                  </span>
                </label>
              </div>
            ) : null}
            <div className="space-y-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t('export.targetVersion', 'Target Version')}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={targetVersion === 'v2.1' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setTargetVersion('v2.1');
                    setIncludeSubtasks(false);
                  }}
                >
                  v2.1
                </Button>
                <Button
                  variant={targetVersion === 'v3.0' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTargetVersion('v3.0')}
                >
                  v3.0
                </Button>
              </div>
            </div>
            {targetVersion === 'v3.0' ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                  checked={includeSubtasks}
                  onChange={(event) => setIncludeSubtasks(event.target.checked)}
                />
                <span>{t('export.includeSubtasks', 'Include subtasks')}</span>
              </label>
            ) : null}
            {targetVersion === 'v3.0' && versionCapability?.adapterVersion === 'v3.0' ? (
              <div className="space-y-1 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
                    checked={compactVideos}
                    onChange={(event) => setCompactVideos(event.target.checked)}
                  />
                  <span>{t('export.compactVideos', 'Remove unused video segments (slower)')}</span>
                </label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'export.sharedVideoHint',
                    'Fast export copies shared videos without re-encoding. Deleted episodes and trimmed frames are excluded from the exported data, but their footage may remain in shared files. Enable this option to physically remove unused segments.',
                  )}
                </p>
              </div>
            ) : null}
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="font-medium mb-1">
                {t('export.changesSummary', 'Changes Summary')}
              </div>
              <ul className="space-y-0.5 text-muted-foreground">
                <li>
                  {t('export.modifiedCount', 'Modified')}: {modifiedEpisodes.size}
                </li>
                <li>
                  {t('export.deletedCount', 'Deleted')}: {deletedEpisodes.size}
                </li>
                <li>
                  {t('export.subtaskEpisodes', 'Subtask episodes')}: {overlay.size}
                </li>
                <li>
                  {t('export.totalEpisodes', 'Total episodes')}: {episodesForExport.length}
                </li>
              </ul>
              {targetVersion === 'v3.0' && includeSubtasks ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('export.subtaskCoverageHint', 'Every exported episode must be fully labeled.')}
                </p>
              ) : null}
            </div>
            {episodesForExport.some((episode) => trimRanges?.has(episode.episode_index)) ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t('trim.exportSummary', {
                  original: episodesForExport.reduce((sum, episode) => sum + episode.length, 0),
                  kept: episodesForExport.reduce((sum, episode) => {
                    const range = trimRanges?.get(episode.episode_index);
                    return sum + (range ? range.endFrame - range.startFrame + 1 : episode.length);
                  }, 0),
                })}
              </p>
            ) : null}
            {exportError && <p className="text-sm text-destructive">{exportError}</p>}
            {savedDataset && (
              <p
                className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm"
                role="status"
              >
                {t('export.platformCommitted', 'Saved to platform dataset: {{target}}', {
                  target: savedDataset,
                })}
              </p>
            )}
            {versionCapability && versionCapability.status !== 'supported' && !exportError && (
              <p className="text-sm text-muted-foreground">
                {t(
                  'export.versionReadOnly',
                  'This dataset version is not supported for export and can only be viewed.',
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3 py-2 min-w-0 overflow-hidden">
            <p className="text-sm font-medium break-words min-w-0">{progress?.message}</p>
            <div className="space-y-1.5 min-w-0">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${displayPercent}%` }}
                  role="progressbar"
                  aria-valuenow={Math.round(displayPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {progress?.percent != null
                  ? t('export.percentDone', '{{percent}}%', {
                      percent: Math.round(progress.percent),
                    })
                  : `${progress?.current ?? 0} / ${progress?.total ?? 0}`}
              </p>
              {uploadProgress ? (
                <p className="text-xs text-muted-foreground" role="status">
                  {t('export.platformUploaded', 'Uploaded {{bytes}} · {{files}} files', {
                    bytes: formatBytes(uploadProgress.uploadedBytes),
                    files: uploadProgress.fileCount,
                  })}
                </p>
              ) : null}
            </div>
          </div>
        )}
        <DialogFooter>
          {!isExporting ? (
            savedDataset ? (
              <>
                <Button variant="outline" onClick={() => setSavedDataset(null)}>
                  {t('export.keepEditing', 'Keep editing')}
                </Button>
                <Button onClick={() => onOpenChange(false)}>{t('export.done', 'Done')}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button onClick={handleExport} disabled={!canExport}>
                  {t('export.export', 'Export')}
                </Button>
              </>
            )
          ) : (
            <>
              <Button variant="outline" onClick={() => abortControllerRef.current?.abort()}>
                {t('export.cancelExport', 'Cancel export')}
              </Button>
              <span className="text-sm text-muted-foreground self-center">
                {t('export.exporting', 'Exporting...')}
              </span>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
