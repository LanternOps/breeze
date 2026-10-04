import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchWithAuth } from '../../stores/auth';
import { isActiveResearch, type ResearchStatusDto } from './suggestionGroups';

export const RESEARCH_POLL_MS = 4_000;
export const RESEARCH_POLL_CAP_MS = 5 * 60_000;

const P = 'longTail.remediation.RemediationSuggestionsPanel';

export type ResearchOutcome =
  | { status: 'started' | 'already_running' | 'already_done'; runId: string; depth: 'quick' | 'deep' }
  | { status: 'denied'; code: string; message: string };

// Denial codes whose API message is a raw skip reason rather than copy a technician can act on.
const FRIENDLY_DENIALS: Record<string, string> = {
  compute_credits_exhausted: `${P}.research.denial.credits`,
  agent_daily_budget_exceeded: `${P}.research.denial.dailyBudget`,
  org_budget_exceeded: `${P}.research.denial.orgBudget`,
  auto_cap: `${P}.research.denial.autoCap`,
  research_auto_cap: `${P}.research.denial.autoCap`,
  max_concurrent_research_runs: `${P}.research.denial.busy`,
  research_rate: `${P}.research.denial.busy`,
  permission: `${P}.research.denial.permission`,
  research_unavailable: `${P}.research.denial.unavailable`,
  model_unavailable: `${P}.research.denial.modelUnavailable`,
  research_baseline_not_system_provisioned: `${P}.research.denial.notProvisioned`,
};

export function denialMessage(code: string, apiMessage: string, t: (key: string) => string): string {
  const key = FRIENDLY_DENIALS[code];
  return key ? t(/* i18n-dynamic */ key) : apiMessage;
}

/**
 * Research run state for one source: the latest run, the last denial, and a poll loop.
 * Polls every 4 s while a run is active; stops on a terminal status, on unmount, and after
 * 5 minutes (`stalled`). `restartPolling` (Refresh/Retry) starts a fresh 5-minute window.
 */
export function useResearchStatus(query: string, onTerminal: () => void) {
  const { t } = useTranslation('common');
  const [status, setStatus] = useState<ResearchStatusDto | null>(null);
  const [denial, setDenial] = useState<{ code: string; message: string } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const active = isActiveResearch(status?.status);
  useEffect(() => {
    if (!active) {
      setStalled(false);
      return;
    }
    const startedAt = Date.now();
    let inFlight = false;
    let cancelled = false;
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= RESEARCH_POLL_CAP_MS) {
        clearInterval(timer);
        setStalled(true);
        return;
      }
      if (inFlight) return; // a slow GET must not overlap the next tick
      inFlight = true;
      void fetchWithAuth(`/remediation-suggestions/research?${queryRef.current}`)
        .then(async (r) => (r.ok ? ((await r.json())?.data as ResearchStatusDto | null) : null))
        .then((next) => {
          if (cancelled || !next) return;
          setStatus(next);
          if (!isActiveResearch(next.status)) onTerminalRef.current();
        })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    }, RESEARCH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, epoch]);

  const restartPolling = useCallback(() => {
    setStalled(false);
    setEpoch((value) => value + 1);
  }, []);

  /** A loaded status (non-null only: a failed/empty read never erases a state already on screen). */
  const applyLoaded = useCallback((next: ResearchStatusDto | null) => {
    if (next) setStatus(next);
  }, []);

  const noteOutcome = useCallback((outcome: ResearchOutcome | null | undefined) => {
    if (!outcome) return;
    if (outcome.status === 'denied') {
      setDenial({ code: outcome.code, message: denialMessage(outcome.code, outcome.message, t) });
      return;
    }
    if (outcome.status === 'started' || outcome.status === 'already_running') {
      setStatus({ runId: outcome.runId, depth: outcome.depth, status: 'queued', errorCode: null, noSafeFix: false, finishedAt: null });
      restartPolling();
    }
  }, [t, restartPolling]);

  const denyFromError = useCallback((code: string, message: string) => {
    setDenial({ code, message: denialMessage(code, message, t) });
  }, [t]);

  return { status, denial, stalled, applyLoaded, noteOutcome, denyFromError, clearDenial: () => setDenial(null), restartPolling };
}
