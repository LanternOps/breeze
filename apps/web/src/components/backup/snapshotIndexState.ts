import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '@/lib/runAction';

/**
 * What the browse endpoint says about a snapshot's file list (#11026), and the
 * state machine both the snapshot browser and the restore wizard use to follow
 * it. A person is only ever shown a list the server may trust: otherwise they
 * are told it is being prepared, or why it cannot be read, never an empty tree.
 *
 * Copied from apps/api/src/services/backupSnapshotIndexView.ts; `failure` is a
 * plain string here so a new server code still reads as unavailable.
 */
export type SnapshotIndexView =
  | { state: 'ready' }
  | { state: 'building' }
  | { state: 'unavailable'; failure: string; retryable: boolean; deviceLocal: boolean };

/** Reads the view from a browse response. Null when the response says nothing about the index. */
export function parseSnapshotIndexView(payload: unknown): SnapshotIndexView | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { index?: unknown; manifestUnavailable?: unknown };
  const index = body.index as { state?: unknown; failure?: unknown; retryable?: unknown; deviceLocal?: unknown } | null | undefined;
  if (index && typeof index === 'object') {
    if (index.state === 'ready') return { state: 'ready' };
    if (index.state === 'building') return { state: 'building' };
    if (index.state === 'unavailable') {
      return {
        state: 'unavailable',
        failure: typeof index.failure === 'string' ? index.failure : 'never_indexed',
        retryable: index.retryable === true,
        deviceLocal: index.deviceLocal === true,
      };
    }
    return null;
  }
  // An API that predates `index`.
  return body.manifestUnavailable === true
    ? { state: 'unavailable', failure: 'never_indexed', retryable: false, deviceLocal: false }
    : null;
}

const INTEGRITY_FAILURES: ReadonlySet<string> = new Set(['attestation_failed', 'manifest_differs_from_attestation']);

export type IndexNotice = {
  message: 'building' | 'integrity' | 'deviceLocal' | 'unavailable';
  canRetry: boolean;
};

/** Which notice a view reads as, or null when there is nothing to say. */
export function indexNoticeKind(view: SnapshotIndexView | null): IndexNotice | null {
  if (!view || view.state === 'ready') return null;
  if (view.state === 'building') return { message: 'building', canRetry: false };
  if (INTEGRITY_FAILURES.has(view.failure)) return { message: 'integrity', canRetry: false };
  if (view.deviceLocal && view.failure === 'manifest_missing') return { message: 'deviceLocal', canRetry: false };
  return { message: 'unavailable', canRetry: view.retryable };
}

const POLL_FIRST_DELAY_MS = 5_000;
const POLL_MAX_DELAY_MS = 30_000;
export const POLL_GIVE_UP_MS = 10 * 60 * 1000;

/** Delay before poll number `attempt` (from 0), or null once it is time to stop asking. */
export function nextPollDelay(attempt: number, elapsedMs: number): number | null {
  const remaining = POLL_GIVE_UP_MS - elapsedMs;
  if (remaining <= 0) return null;
  const backedOff = Math.min(POLL_FIRST_DELAY_MS * 2 ** attempt, POLL_MAX_DELAY_MS);
  return Math.min(backedOff, remaining);
}

export function useSnapshotIndexState({ snapshotId, onReady }: { snapshotId: string; onReady: () => void }) {
  // Kept with the snapshot it describes, so a new snapshot starts with no view
  // instead of showing the previous one's until its first answer.
  const [current, setCurrent] = useState<{ snapshotId: string; view: SnapshotIndexView | null }>({ snapshotId, view: null });
  const [retrying, setRetrying] = useState(false);
  const view = current.snapshotId === snapshotId ? current.view : null;

  const latest = useRef({ snapshotId, onReady });
  latest.current = { snapshotId, onReady };

  const reportView = useCallback((next: SnapshotIndexView | null) => {
    setCurrent({ snapshotId: latest.current.snapshotId, view: next });
  }, []);

  const building = view?.state === 'building';
  useEffect(() => {
    if (!building || !snapshotId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let attempt = 0;

    const schedule = () => {
      const delay = nextPollDelay(attempt, Date.now() - startedAt);
      attempt += 1;
      // Out of time: the building message stays, and a person can reload.
      if (delay === null) return;
      timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      let next: SnapshotIndexView | null = null;
      try {
        const response = await fetchWithAuth(`/backup/snapshots/${snapshotId}/browse?limit=1`);
        if (response.ok) next = parseSnapshotIndexView(await response.json());
      } catch {
        // A poll that fails is not news: the state is unchanged, ask again.
      }
      if (stopped) return;
      if (!next || next.state === 'building') {
        schedule();
        return;
      }
      setCurrent({ snapshotId, view: next });
      if (next.state === 'ready') latest.current.onReady();
    };

    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [building, snapshotId]);

  const retry = useCallback(async () => {
    const id = latest.current.snapshotId;
    if (!id) return;
    setRetrying(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/backup/snapshots/${id}/file-index/rebuild`, { method: 'POST' }),
        errorFallback: "Couldn't start rebuilding the file list",
        // The cooldown 429 says why and for how long; the generic localized
        // RATE_LIMITED headline would replace that (#11280).
        friendly: (code, _message, body) => {
          if (code !== 'RATE_LIMITED' || !body || typeof body !== 'object') return undefined;
          const reason = (body as Record<string, unknown>).error;
          return typeof reason === 'string' && reason.trim() ? reason : undefined;
        },
      });
      if (latest.current.snapshotId === id) setCurrent({ snapshotId: id, view: { state: 'building' } });
    } catch (err) {
      handleActionError(err, "Couldn't start rebuilding the file list");
    } finally {
      setRetrying(false);
    }
  }, []);

  return { view, reportView, retry, retrying };
}
