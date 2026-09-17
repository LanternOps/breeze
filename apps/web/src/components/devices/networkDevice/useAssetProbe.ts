// "Check now" (spec §5, D2). The route waits up to 8s for the agent and then
// answers 202 `pending`; the late result is written by the command-result
// handler, so the page's job is to re-read the asset until the stamp settles.
// Every failure mode (§14) becomes an inline code the strip renders under the
// reachability cell — runAction still toasts, but a toast alone is not the
// feedback for an action whose whole point is a result line.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import type { AssetProbe } from './types';

export type ProbeErrorCode =
  | 'NO_AGENT_IN_SITE'
  | 'PROBE_IN_FLIGHT'
  | 'ASSET_NO_IP'
  | 'ASSET_NO_SITE'
  | 'REFRESH_FAILED'
  | 'PROBE_TIMED_OUT'
  | 'UNKNOWN';

export const PROBE_POLL_INTERVAL_MS = 3_000;
export const PROBE_POLL_MAX_MS = 60_000;
const MAX_POLLS = PROBE_POLL_MAX_MS / PROBE_POLL_INTERVAL_MS;

const KNOWN_CODES: ProbeErrorCode[] = ['NO_AGENT_IN_SITE', 'PROBE_IN_FLIGHT', 'ASSET_NO_IP', 'ASSET_NO_SITE'];

function toProbeErrorCode(err: unknown): ProbeErrorCode {
  if (err instanceof ActionError) {
    const raw = err.code ?? (typeof err.body === 'object' && err.body !== null
      ? (err.body as { code?: string }).code
      : undefined);
    if (raw && (KNOWN_CODES as string[]).includes(raw)) return raw as ProbeErrorCode;
  }
  return 'UNKNOWN';
}

export function useAssetProbe({
  assetId,
  probe,
  onRefresh,
}: {
  assetId: string;
  probe: AssetProbe | null | undefined;
  onRefresh: () => Promise<boolean>;
}) {
  const { t } = useTranslation('devices');
  const [checking, setChecking] = useState(false);
  const [errorCode, setErrorCode] = useState<ProbeErrorCode | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [budgetExpired, setBudgetExpired] = useState(false);

  const serverPending = probe?.state === 'pending';
  const pending = serverPending && !gaveUp;

  // Latest-ref so the interval below never re-subscribes on a new callback
  // identity (the page passes an inline `fetchAsset` wrapper).
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const checkNow = useCallback(async () => {
    setErrorCode(null);
    setChecking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${assetId}/probe`, { method: 'POST' }),
        errorFallback: t('networkDeviceDetailPage.probe.errors.unknown'),
      });
      setBudgetExpired(false);
      setGaveUp(false);
      setAttempt((value) => value + 1);
      if (!await refreshRef.current()) {
        setGaveUp(true);
        setErrorCode('REFRESH_FAILED');
      }

    } catch (err) {
      // 401 means the session expired — runAction has already handed control
      // to the auth redirect; adding an inline error line on a page that is
      // about to navigate away is noise.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.errors.unexpected') });
      }
      const code = toProbeErrorCode(err);
      setErrorCode(code);
      if (code === 'PROBE_IN_FLIGHT') await refreshRef.current();
      return;
    } finally {
      setChecking(false);
    }
  }, [assetId, t]);

  // A successful POST starts a fresh budget even if the pending stamp is
  // unchanged (e.g. no result has ever been observed). A rejected retry must
  // preserve gaveUp so an in-flight conflict cannot wedge the button.
  const pollKey = serverPending ? (probe?.observedAt ?? 'pending') : null;
  useEffect(() => {
    if (pollKey === null || gaveUp) return;
    let ticks = 0;
    let failures = 0;
    let refreshing = false;
    let cancelled = false;
    const timer = setInterval(async () => {
      ticks += 1;
      if (!refreshing) {
        refreshing = true;
        const refreshed = await refreshRef.current();
        refreshing = false;
        if (cancelled) return;
        failures = refreshed ? 0 : failures + 1;
        if (failures >= 3) {
          clearInterval(timer);
          setGaveUp(true);
          setErrorCode('REFRESH_FAILED');
          return;
        }
      }
      if (ticks >= MAX_POLLS) {
        clearInterval(timer);
        setBudgetExpired(true);
      }
    }, PROBE_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pollKey, attempt, gaveUp]);

  // Decide after React applies the final refreshed asset too: the last poll
  // can resolve the probe at the deadline, in which case there is no timeout.
  useEffect(() => {
    if (budgetExpired && serverPending) {
      setGaveUp(true);
      setErrorCode('PROBE_TIMED_OUT');
    }
  }, [budgetExpired, serverPending]);

  return { checking, pending, errorCode, checkNow };
}

/** Shared locale-key suffixes for probe errors in the stat strip and card. */
export const PROBE_ERROR_KEYS: Record<ProbeErrorCode, string> = {
  NO_AGENT_IN_SITE: 'noAgentInSite',
  PROBE_IN_FLIGHT: 'inFlight',
  ASSET_NO_IP: 'noIp',
  ASSET_NO_SITE: 'noSite',
  REFRESH_FAILED: 'refreshFailed',
  PROBE_TIMED_OUT: 'timedOut',
  UNKNOWN: 'unknown',
};
