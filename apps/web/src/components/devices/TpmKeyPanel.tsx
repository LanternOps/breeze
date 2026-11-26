import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { formatDateTime } from '@/lib/dateTimeFormat';
import type { ReauthTier } from '../settings/StepUpPrompt';
import { discoverReauthTier } from '../../lib/reauthTier';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { useCanReattachDevice } from '../../lib/reattachCapability';
import { ActionError, runAction } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import '../../lib/i18n';

/** GET /devices/:id/tpm-baseline (apps/api/src/services/tpmBaseline/index.ts TpmBaselineView). No key hash. */
export interface TpmBaselineView {
  tpmAvailable: boolean | null;
  attested: boolean;
  attestedAt: string | null;
  mismatch: { heldAt: string; version: string } | null;
}

type Action = 'accept' | 'dismiss';

const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';
const KNOWN_REFUSALS = new Set(['mismatch_changed', 'reattach_in_progress', 'org_draining', 'permission_denied', 'org_access_denied', 'MFA_REQUIRED', 'device_not_found']);
/** A minted grant is reused for a retry of the same hold while it is still live (as ReattachDeviceForm). */
const HELD_GRANT_MS = 270_000;

interface HeldGrant {
  grantId: string;
  version: string;
  mintedAt: number;
}

export function parseTpmBaselineView(data: unknown): TpmBaselineView | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.attested !== 'boolean') return null;
  const m = d.mismatch as Record<string, unknown> | null | undefined;
  return {
    tpmAvailable: typeof d.tpmAvailable === 'boolean' ? d.tpmAvailable : null,
    attested: d.attested,
    attestedAt: typeof d.attestedAt === 'string' ? d.attestedAt : null,
    mismatch: m && typeof m.heldAt === 'string' && typeof m.version === 'string'
      ? { heldAt: m.heldAt, version: m.version }
      : null,
  };
}

/**
 * The device's TPM endorsement-key baseline (#8318 wave T2, spec §12.2).
 *
 * The first key a device proves is its baseline: a later reinstall that
 * proves the same key can be reattached without typing the name. A different
 * key is held here for review and, until then, counts as no key:
 *  - Accept makes the held key the baseline. It changes what a reattach
 *    compares against, so the server may ask for a step-up (server-driven,
 *    as ForceRebootDialog: the first submit carries no grant). The grant is
 *    bound to `{ deviceId, baselineVersion }`, the version the GET returned.
 *  - Dismiss keeps the baseline; no step-up.
 * It says key continuity, never a genuine TPM: the EK certificate is not
 * checked (wave T3).
 *
 * The actions are offered only to who the POST admits (useCanReattachDevice:
 * partner scope, devices:write + devices:delete); everyone who can read the
 * device sees the state. Mount it with `key={deviceId}`: its state belongs to
 * one device.
 */
export default function TpmKeyPanel({ deviceId, timezone }: { deviceId: string; timezone?: string }) {
  const { t } = useTranslation('devices');
  const canReview = useCanReattachDevice();
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const [view, setView] = useState<TpmBaselineView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stepUp, setStepUp] = useState(false);
  const [tier, setTier] = useState<ReauthTier | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heldGrant, setHeldGrant] = useState<HeldGrant | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/tpm-baseline`);
      if (!live.current) return;
      const parsed = res.ok ? parseTpmBaselineView(await res.json()) : null;
      if (!live.current) return;
      setView(parsed);
      setLoadError(parsed === null);
    } catch {
      if (live.current) setLoadError(true);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // An idle panel drops the grant when it stops being usable, so an
  // authenticator-app user sees the code field again instead of an Accept
  // that would fail on the first click (#12641 review).
  useEffect(() => {
    if (!heldGrant) return;
    const timer = setTimeout(() => setHeldGrant(null), Math.max(0, heldGrant.mintedAt + HELD_GRANT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [heldGrant]);

  const fmt = (value: string | null) => formatDateTime(value, timezone ? { timeZone: timezone, fallback: '-' } : { fallback: '-' });

  const review = useCallback(async (action: Action) => {
    const mismatch = view?.mismatch;
    if (!mismatch || busy) return;
    setBusy(action);
    setError(null);
    try {
      let stepUpGrant: string | undefined;
      const reusable = heldGrant && heldGrant.version === mismatch.version && Date.now() - heldGrant.mintedAt < HELD_GRANT_MS
        ? heldGrant
        : null;
      if (action === 'accept' && stepUp && !reusable && heldGrant && tier !== 'passkey' && code.length !== 6) {
        // Checked again at the click: a background tab can run the expiry
        // timer late. Ask for a fresh code and send nothing.
        setHeldGrant(null);
        return;
      }
      if (action === 'accept' && stepUp && reusable) {
        // The server judges the step-up last: a refusal before it (an open
        // reattach, a network error) left this grant unspent.
        stepUpGrant = reusable.grantId;
      } else if (action === 'accept' && stepUp) {
        try {
          stepUpGrant = await mintStepUpGrant({
            operation: 'device_tpm_baseline_accept',
            // Exactly these two keys: the server schema is strict.
            resource: { deviceId, baselineVersion: mismatch.version },
            reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
          });
        } catch (err) {
          if (live.current) setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('tpmKeyPanel.genericError'));
          return;
        }
        if (!live.current) return;
        setCode('');
        setHeldGrant({ grantId: stepUpGrant, version: mismatch.version, mintedAt: Date.now() });
      }
      await runAction<{ action: Action }>({
        request: () => fetchWithAuth(`/devices/${deviceId}/tpm-baseline/mismatch`, {
          method: 'POST',
          body: JSON.stringify({ action, version: mismatch.version, ...(stepUpGrant ? { stepUpGrant } : {}) }),
        }),
        errorFallback: t('tpmKeyPanel.genericError'),
        friendly: (refusal, message) => (KNOWN_REFUSALS.has(refusal)
          ? t(/* i18n-dynamic */ `tpmKeyPanel.refusals.${refusal}`, { defaultValue: message })
          : undefined),
        // The step-up request opens the factor step; it is not a failure.
        suppressErrorToast: (status, refusal) => status === 403 && refusal === STEP_UP_REQUIRED,
        successMessage: action === 'accept' ? t('tpmKeyPanel.acceptedToast') : t('tpmKeyPanel.dismissedToast'),
      });
      if (!live.current) return;
      setStepUp(false);
      setHeldGrant(null);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('tpmKeyPanel.genericError') });
        return;
      }
      if (!live.current) return;
      if (err.status === 403 && err.code === STEP_UP_REQUIRED) {
        setHeldGrant(null);
        if (stepUp) {
          // A grant was sent and refused (spent, or the session changed).
          setError(t('tpmKeyPanel.stepUpRetry'));
          return;
        }
        if (tier === null) {
          try {
            const discovered = await discoverReauthTier();
            if (!live.current) return;
            setTier(discovered);
          } catch {
            if (live.current) setError(t('tpmKeyPanel.genericError'));
            return;
          }
        }
        setStepUp(true);
        return;
      }
      setError(err.message);
      // The hold moved under us: show what is there now.
      if (err.status === 409 && err.code === 'mismatch_changed') {
        setStepUp(false);
        setHeldGrant(null);
        void load();
      }
    } finally {
      if (live.current) setBusy(null);
    }
  }, [view, busy, stepUp, tier, code, heldGrant, deviceId, load, t]);

  const noUsableFactor = stepUp && tier === 'password';
  const grantHeld = heldGrant !== null && heldGrant.version === view?.mismatch?.version
    && Date.now() - heldGrant.mintedAt < HELD_GRANT_MS;
  const canAccept = !busy && !noUsableFactor && (!stepUp || tier === 'passkey' || grantHeld || code.length === 6);

  return (
    <section data-testid="tpm-key-panel" className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{t('tpmKeyPanel.title')}</h3>
      </div>

      {loading && !view && (
        <p className="text-sm text-muted-foreground" data-testid="tpm-key-loading">{t('tpmKeyPanel.loading')}</p>
      )}
      {!loading && loadError && (
        <p className="text-sm text-muted-foreground" data-testid="tpm-key-load-error">{t('tpmKeyPanel.loadError')}</p>
      )}

      {view && (
        <>
          <p className="text-sm" data-testid="tpm-key-status">
            {view.attested
              ? t('tpmKeyPanel.attested', { time: fmt(view.attestedAt) })
              : view.tpmAvailable === false
                ? t('tpmKeyPanel.noTpm')
                : t('tpmKeyPanel.notAttested')}
          </p>
          <p className="text-xs text-muted-foreground">{t('tpmKeyPanel.explainer')}</p>

          {view.mismatch && (
            <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3" data-testid="tpm-key-mismatch">
              <p className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span>{t('tpmKeyPanel.mismatch', { time: fmt(view.mismatch.heldAt) })}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {canReview ? t('tpmKeyPanel.mismatchHelp') : t('tpmKeyPanel.reviewNeedsAccess')}
              </p>

              {canReview && stepUp && !grantHeld && (
                noUsableFactor ? (
                  <p className="text-sm" data-testid="tpm-key-no-factor">{t('tpmKeyPanel.noStepUpFactor')}</p>
                ) : tier === 'passkey' ? (
                  <p className="text-xs text-muted-foreground" data-testid="tpm-key-stepup-passkey">{t('tpmKeyPanel.stepUpPasskeyNote')}</p>
                ) : (
                  <label className="block text-sm">
                    <span className="font-medium">{t('tpmKeyPanel.stepUpCodeLabel')}</span>
                    <input
                      data-testid="tpm-key-stepup-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      disabled={busy !== null}
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                    />
                  </label>
                )
              )}

              {canReview && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="tpm-key-accept"
                  onClick={() => void review('accept')}
                  disabled={!canAccept}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy === 'accept' ? t('tpmKeyPanel.working') : stepUp ? t('tpmKeyPanel.acceptStepUp') : t('tpmKeyPanel.accept')}
                </button>
                <button
                  type="button"
                  data-testid="tpm-key-dismiss"
                  onClick={() => void review('dismiss')}
                  disabled={busy !== null}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {busy === 'dismiss' ? t('tpmKeyPanel.working') : t('tpmKeyPanel.dismiss')}
                </button>
              </div>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="tpm-key-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
