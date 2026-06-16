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
 * `update-status` event. `phase` is the serde tag.
 */
export type UpdateStatus =
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; downloaded: number; total: number | null }
  | { phase: 'installing'; version: string }
  | { phase: 'restarting'; version: string }
  | { phase: 'deferred'; version: string };

/** Phases that represent in-flight work (animated spinner appropriate). */
const ACTIVE_PHASES: ReadonlySet<UpdateStatus['phase']> = new Set([
  'available',
  'downloading',
  'installing',
  'restarting',
]);

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
  }
}

/** Whether the indicator should show an animated/in-progress affordance. */
export function isUpdateActive(status: UpdateStatus): boolean {
  return ACTIVE_PHASES.has(status.phase);
}

/**
 * Deferred updates are informational and shouldn't linger forever. All other
 * phases stay pinned until the process exits or restarts.
 */
export function shouldAutoDismiss(status: UpdateStatus): boolean {
  return status.phase === 'deferred';
}
