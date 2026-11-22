import { useCallback, useEffect, useRef } from 'react';
import type { AiModelsSnapshotDto } from '@breeze/shared';

export const JOB_POLL_INTERVAL_MS = 3000;
/** ~60 s: past that the job is stuck or lost, and the next manual reload shows the truth. */
export const JOB_POLL_MAX_TICKS = 20;

/**
 * What a Verify / Refresh job rewrites: every connection's discovery stamps and
 * every offering's verification record. (Verify on a non-gateway connection only
 * re-runs discovery, so the offering record alone would never change.)
 */
export function jobFingerprint(snapshot: AiModelsSnapshotDto): string {
  return JSON.stringify([
    snapshot.connections.map((c) => [c.id, c.lastDiscoveredAt, c.discoveryError, c.verifiedAt]),
    snapshot.offerings.map((o) => [o.id, o.verification]),
  ]);
}

/**
 * #12456: Verify and Refresh answer 202 and finish in a background job, and the
 * read endpoints expose no "running" flag. So after the page queues one, re-read
 * the snapshot until `marker` differs from its value at queue time. Own it in a
 * component that outlives the drawer. Bounded by a tick cap; one read in flight
 * at a time; stops on unmount; idle (no timer) when nothing was queued.
 */
export function useJobPoll(marker: string, reload: () => void | Promise<void>) {
  const markerRef = useRef(marker);
  markerRef.current = marker;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef(0); // generation: a stale in-flight read must not reschedule

  const stop = useCallback(() => {
    run.current += 1;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const start = useCallback(() => {
    stop();
    const gen = run.current;
    const baseline = markerRef.current;
    let ticks = 0;
    const schedule = () => {
      timer.current = setTimeout(async () => {
        timer.current = null;
        // Compare first: the previous tick's reload has re-rendered by now.
        if (gen !== run.current || markerRef.current !== baseline || ticks >= JOB_POLL_MAX_TICKS) return;
        ticks += 1;
        try { await reloadRef.current(); } catch { /* the next tick retries */ }
        if (gen === run.current) schedule();
      }, JOB_POLL_INTERVAL_MS);
    };
    schedule();
  }, [stop]);

  useEffect(() => stop, [stop]);
  return start;
}
