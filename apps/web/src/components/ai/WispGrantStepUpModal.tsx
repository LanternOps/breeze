import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/shared/Dialog';
import { showToast } from '@/components/shared/Toast';
import { useJwtClaims } from '@/lib/authScope';
import { StepUpMintError, type StepUpReauth } from '@/lib/mfaStepUp';
import { ActionError, runAction } from '@/lib/runAction';
import { discoverStepUpTier, fetchWispThread, mintWispGrantStepUp, WispPreviewError } from '@/lib/wispGrant';
import { fetchWithAuth } from '@/stores/auth';
import type { WispState } from '@/stores/aiStore';
import type { ReauthTier } from '@/components/settings/StepUpPrompt';

export type WispGrantStepUpModalProps = {
  open: boolean;
  /** The org a "This organization" grant is for (the header's selected org). */
  defaultOrgId: string | null;
  onClose(): void;
  onGranted(w: NonNullable<WispState>): void;
  /** Refresh an existing grant (same handshake, its own scope) instead of creating one. */
  refresh?: { grantId: string; orgId: string | null };
};

type GrantDto = { id: string; orgId: string | null };

const isStepUpRequired = (err: unknown): boolean =>
  err instanceof ActionError && err.status === 403 && err.code === 'STEP_UP_REQUIRED';

/**
 * Turn on (or refresh) Wisp: the grant is created with a `wisp_grant` step-up
 * bound to the server's ceiling hash (w00 A4: preview → mint → submit). A
 * `403 STEP_UP_REQUIRED` means the reach changed between preview and submit;
 * the handshake is re-run once with a fresh preview, then reported.
 */
export default function WispGrantStepUpModal({ open, defaultOrgId, onClose, onGranted, refresh }: WispGrantStepUpModalProps) {
  const { t } = useTranslation('ai');
  const claims = useJwtClaims();
  const partnerToken = claims.status === 'resolved' && claims.claims.scope === 'partner';
  const partnerId = claims.status === 'resolved' ? claims.claims.partnerId : null;

  const [scope, setScope] = useState<'org' | 'partner'>(defaultOrgId ? 'org' : 'partner');
  const [tier, setTier] = useState<ReauthTier | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setError(null);
    setTier(null);
    setScope(defaultOrgId || !partnerToken ? 'org' : 'partner');
    let cancelled = false;
    discoverStepUpTier()
      .then((next) => { if (!cancelled) setTier(next); })
      .catch(() => { if (!cancelled) setError(t('wisp.modal.stepUpUnavailable')); });
    return () => { cancelled = true; };
  }, [open, defaultOrgId, partnerToken, t]);

  const orgId = refresh ? refresh.orgId : scope === 'org' ? defaultOrgId : null;
  const missingOrg = !refresh && scope === 'org' && !defaultOrgId;
  const canConfirm =
    !busy && !!partnerId && !missingOrg && (tier === 'passkey' || (tier === 'totp' && code.length === 6));

  /** Open the grant's thread, then report "on" — never "on" for a thread that did not open. */
  const finish = async (successMessage: string) => {
    let state: NonNullable<WispState>;
    try {
      // The scope the user chose, not the response body: it is what /wisp/thread is keyed by.
      state = await fetchWispThread(orgId);
    } catch (err) {
      // The grant exists; only its thread failed to open. Re-confirming later
      // reopens it through the live-grant probe below (no second grant).
      console.error('[wisp] grant ok but its thread did not open', err);
      showToast({ type: 'error', message: t('wisp.toast.threadFailed') });
      if (live.current) onClose();
      return;
    }
    showToast({ type: 'success', message: successMessage });
    if (live.current) onGranted(state);
  };

  const submit = async () => {
    if (!canConfirm || !partnerId || !tier) return;
    setBusy(true);
    setError(null);
    const reauth: StepUpReauth = tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code };
    const errorFallback = refresh ? t('wisp.toast.refreshFailed') : t('wisp.toast.onFailed');
    const successMessage = refresh ? t('wisp.toast.refreshed') : t('wisp.toast.on');
    const attempt = async (): Promise<GrantDto> => {
      const stepUpGrantId = await mintWispGrantStepUp({ partnerId, orgId, reauth });
      return runAction<GrantDto>({
        request: () =>
          refresh
            ? fetchWithAuth(`/wisp/grants/${refresh.grantId}/refresh`, { method: 'POST', body: JSON.stringify({ stepUpGrantId }) })
            : fetchWithAuth('/wisp/grants', { method: 'POST', body: JSON.stringify({ orgId, stepUpGrantId }) }),
        errorFallback,
        // Handled below rather than toasted: a stale proof (re-verify) and an
        // already-live grant for this scope (reopen it).
        suppressErrorToast: (status, errorCode) =>
          (status === 403 && errorCode === 'STEP_UP_REQUIRED') || (status === 409 && errorCode === 'ALREADY_ACTIVE'),
      });
    };
    try {
      // One live grant per scope (W02 ONE_LIVE_PER_SCOPE_INDEX): a grant made
      // earlier (before a reload, another tab) is re-entered, not re-created —
      // entering Wisp on an existing grant needs no new proof.
      if (!refresh) {
        const existing = await fetchWispThread(orgId).then(() => true, () => false);
        if (existing) {
          await finish(successMessage);
          return;
        }
      }
      try {
        await attempt();
      } catch (err) {
        if (err instanceof ActionError && err.status === 409 && err.code === 'ALREADY_ACTIVE') {
          await finish(successMessage);
          return;
        }
        if (!isStepUpRequired(err)) throw err;
        // Reach changed between preview and submit. A TOTP code is single-use
        // (the server records its time step), so ask for a fresh one; a
        // passkey can simply run the ceremony again, once.
        if (tier !== 'passkey') {
          if (live.current) {
            setCode('');
            setError(t('wisp.modal.reverify'));
          }
          return;
        }
        await attempt();
      }
      await finish(successMessage);
    } catch (err) {
      if (!live.current) return;
      if (isStepUpRequired(err)) setError(t('wisp.modal.stepUpUnavailable'));
      else if (err instanceof StepUpMintError) {
        setError(err.code === 'invalid_factor' ? t('wisp.modal.invalidCode') : t('wisp.modal.stepUpUnavailable'));
      } else if (err instanceof WispPreviewError) setError(err.message);
      else if (err instanceof ActionError) {
        // runAction already toasted it (401 is the auth redirect's job); the modal stays open.
      } else {
        console.error('[wisp] grant step-up failed', err);
        setError(t('wisp.modal.stepUpUnavailable'));
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} title={refresh ? t('wisp.modal.refreshTitle') : t('wisp.modal.title')} maxWidth="md" className="p-5">
      <div data-testid="wisp-grant-modal" className="space-y-4">
        <h2 className="text-base font-semibold">{refresh ? t('wisp.modal.refreshTitle') : t('wisp.modal.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('wisp.modal.explain')}</p>

        {!refresh && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="text-sm font-medium">{t('wisp.modal.scopeLabel')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="wisp-scope" data-testid="wisp-scope-org" checked={scope === 'org'} onChange={() => setScope('org')} />
              {t('wisp.modal.scopeOrg')}
            </label>
            {partnerToken && (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="wisp-scope" data-testid="wisp-scope-partner" checked={scope === 'partner'} onChange={() => setScope('partner')} />
                {t('wisp.modal.scopePartner')}
              </label>
            )}
            {missingOrg && <p className="text-xs text-amber-600 dark:text-amber-400">{t('wisp.modal.noOrg')}</p>}
          </fieldset>
        )}

        {tier === 'password' ? (
          <p role="alert" className="text-sm text-destructive">{t('wisp.modal.noFactor')}</p>
        ) : tier === 'totp' ? (
          <label className="block text-sm font-medium">
            {t('wisp.modal.code')}
            <input
              data-testid="wisp-stepup-code"
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
        ) : tier === 'passkey' ? (
          <p className="text-xs text-muted-foreground">{t('wisp.modal.passkey')}</p>
        ) : null}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border px-3 py-2 text-sm" disabled={busy} onClick={onClose} data-testid="wisp-grant-cancel">
            {t('wisp.modal.cancel')}
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            disabled={!canConfirm}
            onClick={() => void submit()}
            data-testid="wisp-grant-confirm"
          >
            {busy ? t('wisp.toggle.turningOn') : t('wisp.modal.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
