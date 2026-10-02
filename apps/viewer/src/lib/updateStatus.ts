/**
 * Update lifecycle status broadcast from the Rust auto-updater.
 *
 * The viewer's updater is otherwise silent (see `src-tauri/src/lib.rs`
 * `auto_update`). Without a visible indicator, the window disappearing
 * (Windows installer) or restarting (macOS/Linux) reads as a crash. These
 * events drive a small banner so the user knows an update — not a crash —
 * is happening.
 *
 * The shape mirrors the serde-tagged `UpdateStatus` enum emitted on the
 * `update-status` event. `phase` is the serde tag. The Rust side has a
 * `serialize_*` contract test (`src-tauri/src/lib.rs`) that locks these tag
 * names and field shapes so the two definitions can't silently drift.
 */
/**
 * Where a failed update died (#7681). Mirrors `UpdateFailStage` in
 * `src-tauri/src/update_diagnostics.rs`: `download` = fetching the bundle,
 * `verify` = its signature check, `extract` = unpacking the installer from the
 * bundle, `install` = launching the installer / swapping the binary.
 */
export type UpdateFailureStage = 'download' | 'verify' | 'extract' | 'install';

export type UpdateStatus =
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; downloaded: number; total: number | null }
  | { phase: 'installing'; version: string }
  | { phase: 'restarting'; version: string }
  | { phase: 'deferred'; version: string }
  | {
      phase: 'failed';
      version: string;
      stage: UpdateFailureStage;
      /** The updater's own error text, e.g. "unsupported Zip archive: …". */
      error: string;
      /** Updater log with the full attempt; null when Rust has no log dir. */
      logPath: string | null;
    }
  | { phase: 'ready'; version: string };

/** Compile-time exhaustiveness guard: a new phase that isn't handled becomes a type error. */
function assertNever(value: never): never {
  throw new Error(`Unhandled update phase: ${JSON.stringify(value)}`);
}

/**
 * Every known phase, keyed by the union's `phase` discriminant. Typed as
 * `Record<UpdateStatus['phase'], true>` so adding a phase to the union without
 * listing it here is a compile error — this stays in sync automatically.
 */
const KNOWN_PHASES: Record<UpdateStatus['phase'], true> = {
  available: true,
  downloading: true,
  installing: true,
  restarting: true,
  deferred: true,
  failed: true,
  ready: true,
};

/** Wording for "failed while …", keyed by stage (also the set of known stages). */
const FAILURE_STAGE_LABELS: Record<UpdateFailureStage, string> = {
  download: 'downloading',
  verify: 'verifying its signature',
  extract: 'unpacking the installer',
  install: 'installing',
};

function isFailureStage(value: unknown): value is UpdateFailureStage {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_STAGE_LABELS, value)
  );
}

/**
 * Validate an inbound `update-status` payload at the IPC trust boundary.
 *
 * Tauri's `listen` payload is `any`, so a drifted/renamed Rust variant would
 * otherwise flow straight into the UI. Rejecting an unrecognized payload here
 * degrades gracefully (the banner just doesn't show) rather than crashing the
 * render on an unhandled phase.
 */
export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.phase !== 'string' ||
    !(record.phase in KNOWN_PHASES) ||
    typeof record.version !== 'string'
  ) {
    return false;
  }
  if (record.phase === 'failed') {
    return (
      isFailureStage(record.stage) &&
      typeof record.error === 'string' &&
      (record.logPath === null || typeof record.logPath === 'string')
    );
  }
  return true;
}

/**
 * Download progress as a whole-number percent (0-100), or null when the
 * total size is unknown or the phase isn't a download.
 */
export function updateProgressPercent(status: UpdateStatus): number | null {
  if (status.phase !== 'downloading') return null;
  const { downloaded, total } = status;
  if (total == null || total <= 0) return null;
  const pct = Math.round((downloaded / total) * 100);
  // Clamp to guard against a final chunk overshooting the reported total.
  return Math.max(0, Math.min(100, pct));
}

/** Human-readable, single-line message for the indicator. */
export function updateStatusMessage(status: UpdateStatus): string {
  switch (status.phase) {
    case 'available':
      return `Update ${status.version} available — downloading…`;
    case 'downloading': {
      const pct = updateProgressPercent(status);
      return pct == null
        ? `Downloading update ${status.version}…`
        : `Downloading update ${status.version}… ${pct}%`;
    }
    case 'installing':
      return `Installing update ${status.version}…`;
    case 'restarting':
      return `Update ${status.version} installed — restarting…`;
    case 'deferred':
      return `Update ${status.version} ready — applies when this session ends.`;
    case 'failed':
      return `Update ${status.version} failed while ${FAILURE_STAGE_LABELS[status.stage]} — will retry on next launch.`;
    case 'ready':
      // Rust emits `ready` only after download() returned, and download()
      // returns only once the signature verified.
      return `Update ${status.version} downloaded and verified`;
    default:
      return assertNever(status);
  }
}

/**
 * Whether the indicator should show an animated/in-progress affordance
 * (the determinate progress bar or indeterminate pulse). Only the in-flight
 * phases qualify — `deferred` and `failed` are terminal notices.
 */
export function isUpdateActive(status: UpdateStatus): boolean {
  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'installing':
    case 'restarting':
      return true;
    case 'deferred':
    case 'failed':
    case 'ready':
      return false;
    default:
      return assertNever(status);
  }
}

/**
 * How long a terminal notice stays up before auto-dismissing, or null to stay
 * pinned. In-flight phases stay pinned until the process exits or restarts,
 * and `ready` until the user picks a button. A failure lingers longer than a
 * deferral because it carries an error and a log path to read.
 */
export function autoDismissMs(status: UpdateStatus): number | null {
  switch (status.phase) {
    case 'deferred':
      return 10_000;
    case 'failed':
      return 30_000;
    default:
      return null;
  }
}

/**
 * The status to show when the `apply_pending_update` command rejects. Rust
 * normally emits a detailed `failed` event (stage, error, log path) for the
 * same version before rejecting, so keep that rather than overwrite it with
 * the bare rejection string. Only a rejection Rust did not report (e.g.
 * "no pending update to apply") gets a status built here.
 */
export function statusAfterApplyRejected(
  current: UpdateStatus | null,
  version: string,
  err: unknown,
): UpdateStatus {
  if (current?.phase === 'failed' && current.version === version) return current;
  return {
    phase: 'failed',
    version,
    stage: 'install',
    error: err instanceof Error ? err.message : String(err),
    logPath: null,
  };
}
