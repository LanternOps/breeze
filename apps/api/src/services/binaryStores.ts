import { resolve } from 'node:path';

/**
 * The staged binaries directories of a BINARY_SOURCE=local deployment, and the
 * S3 prefix each one is mirrored to — the single source of truth for both
 * sides of the local-mode S3 offload (#7515):
 *
 *   - syncBinaries() uploads every file of every store to `<prefix>/<file>`
 *     (see s3SyncTargets), and
 *   - every download path that reads a staged file from S3 derives its key
 *     with binaryS3Key(store, file) from the store the file lives in.
 *
 * A file's S3 key is therefore a function of the directory it is staged in,
 * never of the component it belongs to. The watchdog, backup, user-helper and
 * recovery-iso binaries all ship in the agent dir, so they live under `agent/`.
 * (Before #7515 their routes read `watchdog/`, `backup/`, `user-helper/` and
 * `recovery-iso/`, which sync never wrote: every download missed S3 and
 * streamed through the API process from disk, and hand-copied objects under
 * those prefixes went stale on the next deploy — the #7516 checksum loop.)
 *
 * Never hard-code an S3 prefix at a call site; add a store here instead.
 */
export type BinaryStore = 'agent' | 'viewer' | 'helper';

interface BinaryStoreDef {
  /** Env var holding the directory. */
  dirEnv: string;
  /** Used when the env var is unset: a path, or another store's directory. */
  fallback: string | { store: BinaryStore };
  s3Prefix: string;
}

// Order matters: when two stores resolve to the same directory, the earlier
// one owns it (see resolveStore). An unset HELPER_BINARY_DIR means "the agent
// dir" — wherever AGENT_BINARY_DIR points, not a cwd-relative ./agent/bin.
const STORES: Record<BinaryStore, BinaryStoreDef> = {
  agent: { dirEnv: 'AGENT_BINARY_DIR', fallback: './agent/bin', s3Prefix: 'agent' },
  viewer: { dirEnv: 'VIEWER_BINARY_DIR', fallback: './viewer/bin', s3Prefix: 'viewer' },
  helper: { dirEnv: 'HELPER_BINARY_DIR', fallback: { store: 'agent' }, s3Prefix: 'helper' },
};

const STORE_ORDER = Object.keys(STORES) as BinaryStore[];

/** Absolute directory a store's files are staged in (env-resolved per call). */
export function binaryStoreDir(store: BinaryStore): string {
  const def = STORES[store];
  const configured = process.env[def.dirEnv];
  if (configured) return resolve(configured);
  return typeof def.fallback === 'string' ? resolve(def.fallback) : binaryStoreDir(def.fallback.store);
}

/**
 * The store that owns `store`'s directory: itself, unless an earlier store
 * resolves to the same path (e.g. HELPER_BINARY_DIR unset or pointed at the
 * agent dir). A directory is synced once, under its owner's prefix, so the
 * readers of every store sharing it must use that prefix too.
 */
function resolveStore(store: BinaryStore): BinaryStore {
  const dir = binaryStoreDir(store);
  return STORE_ORDER.find((candidate) => binaryStoreDir(candidate) === dir) ?? store;
}

/** S3 key a staged file is mirrored to by syncBinaries(). */
export function binaryS3Key(store: BinaryStore, filename: string): string {
  return `${STORES[resolveStore(store)].s3Prefix}/${filename}`;
}

/** The distinct (directory, prefix) pairs syncBinaries() mirrors to S3. */
export function s3SyncTargets(): Array<{ store: BinaryStore; dir: string; s3Prefix: string }> {
  return STORE_ORDER.filter((store) => resolveStore(store) === store).map((store) => ({
    store,
    dir: binaryStoreDir(store),
    s3Prefix: STORES[store].s3Prefix,
  }));
}
