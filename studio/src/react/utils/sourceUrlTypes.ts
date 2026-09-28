export type SourceKind =
  | 'remoteArchive'
  | 'localArchive'
  | 'directory'
  | 'sample'
  | 'manifest'
  | 'unknown';

/** Parsed `?url=` intent for restoring a previous local or remote source. */
export interface ParsedSourceUrl {
  kind: SourceKind;
  /** Decoded raw ?url= value */
  raw: string;
  /** UI hint (e.g. local label) */
  hint?: string;
  /** sample:// id */
  sampleId?: string;
  /** manifest:// 内嵌的清单接口地址 */
  manifestUrl?: string;
  /** IndexedDB has a restorable handle */
  restorable?: boolean;
}
