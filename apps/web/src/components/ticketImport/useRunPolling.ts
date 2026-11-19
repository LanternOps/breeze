import { useEffect, useRef, useState } from 'react';
import { ImportReadError, isRunActive, readImport, type ImportRun } from './ticketImportApi';

/** How often a queued or running run is read again (spec 2026-10-19 §5.11: every 5 s). */
export const RUN_POLL_MS = 5_000;

/**
 * Follows one run (#8313 W6): reads it at once, then every RUN_POLL_MS while
 * it is queued or running, and stops on a terminal state, on a 404, on a
 * change of `runId` and on unmount. A failed read keeps the last good run and
 * tries again on the next tick. `onFinished` fires once, when a run this hook
 * saw active reaches a terminal state, so the caller can refresh its lists.
 */
export function useRunPolling(
  runId: string | null,
  onFinished?: (run: ImportRun) => void,
): { run: ImportRun | null; missing: boolean; readFailed: boolean } {
  const [run, setRun] = useState<ImportRun | null>(null);
  const [missing, setMissing] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    setRun(null);
    setMissing(false);
    setReadFailed(false);
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sawActive = false;

    const tick = async () => {
      timer = null;
      try {
        const { data } = await readImport<ImportRun>(`/ticket-imports/runs/${runId}`);
        if (stopped) return;
        setRun(data);
        setReadFailed(false);
        if (isRunActive(data.state)) {
          sawActive = true;
        } else {
          if (sawActive) finished.current?.(data);
          return;
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof ImportReadError && error.status === 404) {
          setMissing(true);
          return;
        }
        setReadFailed(true);
      }
      if (!stopped) timer = setTimeout(() => void tick(), RUN_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { run, missing, readFailed };
}
