import { useCallback, useEffect, useRef } from 'react';

export const JOB_POLL_INTERVAL_MS = 3000;
/** ~60 s: past that the job is stuck or lost, and the next manual reload shows the truth. */
export const JOB_POLL_MAX_TICKS = 20;

/**
 * #12456: Verify and Refresh answer 202 and finish in a background job, and the
 * read endpoints expose no "running" flag. So after the page queues one, re-read
 * the snapshot on an interval until `marker` (a string derived from the row the
 * job rewrites) differs from its value at queue time. Bounded by a tick cap;
 * stops on unmount; idle (no timer) when nothing was queued.
 */
export function useJobPoll(marker: string, reload: () => void | Promise<void>) {
  const markerRef = useRef(marker);
  markerRef.current = marker;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) { clearInterval(timer.current); timer.current = null; }
  }, []);

  const start = useCallback(() => {
    stop();
    const baseline = markerRef.current;
    let ticks = 0;
    timer.current = setInterval(() => {
      // Compare first: the previous tick's reload has re-rendered by now.
      if (markerRef.current !== baseline || ticks >= JOB_POLL_MAX_TICKS) { stop(); return; }
      ticks += 1;
      void Promise.resolve(reloadRef.current()).catch(() => { /* the next tick retries */ });
    }, JOB_POLL_INTERVAL_MS);
  }, [stop]);

  useEffect(() => stop, [stop]);
  return start;
}
