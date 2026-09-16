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
  | 'PROBE_TIMED_OUT'
  | 'UNKNOWN';

export const PROBE_POLL_INTERVAL_MS = 3_000;
export const PROBE_POLL_MAX_MS = 60_000;
const MAX_POLLS = PROBE_POLL_MAX_MS / PROBE_POLL_INTERVAL_MS;

const KNOWN_CODES: ProbeErrorCode[] = ['NO_AGENT_IN_SITE', 'PROBE_IN_FLIGHT', 'ASSET_NO_IP'];

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
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation('devices');
  const [checking, setChecking] = useState(false);
  const [errorCode, setErrorCode] = useState<ProbeErrorCode | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const serverPending = probe?.state === 'pending';
  const pending = serverPending && !gaveUp;

  // Latest-ref so the interval below never re-subscribes on a new callback
  // identity (the page passes an inline `fetchAsset` wrapper).
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const checkNow = useCallback(async () => {
    setErrorCode(null);
    setGaveUp(false);
    setChecking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${assetId}/probe`, { method: 'POST' }),
        errorFallback: t('networkDeviceDetailPage.probe.errors.unknown'),
      });
    } catch (err) {
      // 401 means the session expired — runAction has already handed control
      // to the auth redirect; adding an inline error line on a page that is
      // about to navigate away is noise.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.errors.unexpected') });
      }
      setErrorCode(toProbeErrorCode(err));
      return;
    } finally {
      setChecking(false);
    }
    await refreshRef.current();
  }, [assetId, t]);

  // Poll while the server says pending. Keyed on `probe.observedAt` so a NEW
  // probe restarts the budget instead of inheriting the previous one's ticks.
  const pollKey = serverPending ? (probe?.observedAt ?? 'pending') : null;
  useEffect(() => {
    if (pollKey === null) return;
    setGaveUp(false);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      void refreshRef.current();
      if (ticks >= MAX_POLLS) {
        clearInterval(timer);
        setGaveUp(true);
        setErrorCode('PROBE_TIMED_OUT');
      }
    }, PROBE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollKey]);

  return { checking, pending, errorCode, checkNow };
}
