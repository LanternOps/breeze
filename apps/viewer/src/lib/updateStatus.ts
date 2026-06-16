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
export type UpdateStatus =
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; downloaded: number; total: number | null }
  | { phase: 'installing'; version: string }
  | { phase: 'restarting'; version: string }
  | { phase: 'deferred'; version: string }
  | { phase: 'failed'; version: string };

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
};

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
  return (
    typeof record.phase === 'string' &&
    record.phase in KNOWN_PHASES &&
    typeof record.version === 'string'
  );
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
      return `Update ${status.version} failed — will retry on next launch.`;
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
      return false;
    default:
      return assertNever(status);
  }
}

/**
 * Terminal notices (deferred / failed) are informational and shouldn't linger
 * forever. In-flight phases stay pinned until the process exits or restarts.
 */
export function shouldAutoDismiss(status: UpdateStatus): boolean {
  return status.phase === 'deferred' || status.phase === 'failed';
}
