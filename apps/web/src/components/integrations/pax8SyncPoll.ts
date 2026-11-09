export interface SyncSnapshot {
  lastSyncAt: string | null;
  lastSyncStatus?: string | null;
  updatedAt?: string | null;
}

export const SYNC_POLL_INTERVAL_MS = 3000;
export const SYNC_POLL_MAX_ATTEMPTS = 40;

/** A sync finished when lastSyncAt moved, or it failed and updatedAt moved. */
export function syncFinished(before: SyncSnapshot, now: SyncSnapshot): boolean {
  if ((now.lastSyncAt ?? null) !== (before.lastSyncAt ?? null)) return true;
  return now.lastSyncStatus === "failed" && (now.updatedAt ?? null) !== (before.updatedAt ?? null);
}

/**
 * Poll `read` every `intervalMs` (at most `maxAttempts` times) until the sync
 * snapshot changes. Resolves true when it finished, false on timeout or abort.
 * Read errors count as an attempt; they never reject.
 */
export async function waitForSyncCompletion(opts: {
  before: SyncSnapshot;
  read: () => Promise<SyncSnapshot | null>;
  signal: AbortSignal;
  intervalMs?: number;
  maxAttempts?: number;
}): Promise<boolean> {
  const { before, read, signal, intervalMs = SYNC_POLL_INTERVAL_MS, maxAttempts = SYNC_POLL_MAX_ATTEMPTS } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done);
    });
    if (signal.aborted) return false;
    let now: SyncSnapshot | null = null;
    try {
      now = await read();
    } catch {
      now = null;
    }
    if (signal.aborted) return false;
    if (now && syncFinished(before, now)) return true;
  }
  return false;
}
