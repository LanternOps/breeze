import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalFlowRunStatus } from '@breeze/shared';
import type { FlowRunDetailDto } from '@breeze/shared';
import { getFlowRun } from './api';

const FAST_MS = 3_000;
const SLOW_MS = 15_000;
const BACKOFF_AFTER_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface FlowRunPolling {
  run: FlowRunDetailDto | null;
  /** True until the first response (or failure) arrives. */
  loading: boolean;
  /** Last HTTP status of a failed first load, e.g. 404. */
  loadError: { status: number | null } | null;
  /** Three consecutive failures: polling has stopped and the page must say so. */
  paused: boolean;
  /** Epoch ms of the last successful response. */
  lastUpdated: number | null;
  /** Resume after the paused state. */
  retry: () => void;
  /** Fetch now (e.g. after Cancel). */
  refetch: () => void;
}

/**
 * Polls the body-less run detail. One request at a time (the next poll is
 * scheduled after the previous settles), stops at a terminal status, idles
 * while the tab is hidden, backs off after five minutes, and stops with an
 * explicit paused state after three consecutive failures.
 */
export function useFlowRunPolling(runId: string, enabled = true): FlowRunPolling {
  const [run, setRun] = useState<FlowRunDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ status: number | null } | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const controls = useRef<{ retry: () => void; refetch: () => void }>({ retry: () => {}, refetch: () => {} });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let again = false;
    let terminal = false;
    let stopped = false; // paused after repeated failures
    let failures = 0;
    const startedAt = Date.now();

    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clear();
      if (disposed || terminal || stopped || document.hidden) return;
      const delay = Date.now() - startedAt > BACKOFF_AFTER_MS ? SLOW_MS : FAST_MS;
      timer = setTimeout(() => { void tick(); }, delay);
    };

    const tick = async () => {
      clear();
      if (disposed || inFlight) {
        if (inFlight) again = true;
        return;
      }
      inFlight = true;
      try {
        const next = await getFlowRun(runId);
        if (disposed) return;
        failures = 0;
        setRun(next);
        setLoadError(null);
        setLastUpdated(Date.now());
        setPaused(false);
        terminal = isTerminalFlowRunStatus(next.status);
      } catch (err) {
        if (disposed) return;
        failures += 1;
        setLoadError({ status: (err as { status?: number } | null)?.status ?? null });
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          stopped = true;
          setPaused(true);
        }
      } finally {
        inFlight = false;
        if (!disposed) setLoading(false);
      }
      if (disposed) return;
      if (again) {
        again = false;
        void tick();
        return;
      }
      schedule();
    };

    const onVisibility = () => {
      if (document.hidden) {
        clear();
      } else if (!inFlight && !terminal && !stopped) {
        void tick();
      }
    };

    controls.current = {
      retry: () => {
        failures = 0;
        stopped = false;
        setPaused(false);
        void tick();
      },
      refetch: () => {
        terminal = false;
        void tick();
      },
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) void tick();
    return () => {
      disposed = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runId, enabled]);

  const retry = useCallback(() => controls.current.retry(), []);
  const refetch = useCallback(() => controls.current.refetch(), []);
  return { run, loading, loadError, paused, lastUpdated, retry, refetch };
}
