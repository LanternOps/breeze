import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../lib/runAction';
import { mintStepUpGrant } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';

/** Extra body fields a restore request carries once the operator confirmed it. */
export type UnattestedRestoreExtras = { stepUpGrant?: string; confirmUnattestedRestore?: boolean };

type StepUpDetails = {
  method: 'mfa' | 'confirm' | 'typed';
  reason: string;
  /** Exactly the resource the server digests for the grant; sent back verbatim. */
  resource: unknown;
  /** For `typed`: the device name to type, and the org the restore belongs to. */
  confirmation?: { phrase: string; orgId: string };
};

function typedConfirmation(stepUp: Record<string, unknown>): StepUpDetails['confirmation'] {
  const raw = stepUp.confirmation && typeof stepUp.confirmation === 'object' ? stepUp.confirmation as Record<string, unknown> : null;
  if (!raw || typeof raw.phrase !== 'string' || !raw.phrase || typeof raw.orgId !== 'string' || !raw.orgId) return undefined;
  return { phrase: raw.phrase, orgId: raw.orgId };
}

/** Same comparison as the server: case-insensitive, surrounding whitespace ignored. */
function phraseMatches(phrase: string, typed: string): boolean {
  return typed.trim().toLowerCase() === phrase.trim().toLowerCase();
}

/**
 * Mints the typed-confirmation grant (POST /backup/restore-confirmations) for
 * the resource the server named, in the restore's own org. Throws with the
 * server's message on refusal.
 */
async function mintTypedConfirmation(details: StepUpDetails, typed: string): Promise<string> {
  const response = await fetchWithAuth('/backup/restore-confirmations', {
    method: 'POST',
    body: JSON.stringify({ ...(details.resource as Record<string, unknown>), confirmationText: typed }),
    orgIdOverride: details.confirmation!.orgId,
  });
  const data = await response.json().catch(() => null) as { stepUpGrant?: unknown; error?: unknown } | null;
  if (!response.ok || typeof data?.stepUpGrant !== 'string') {
    throw new Error(typeof data?.error === 'string' ? data.error : '');
  }
  return data.stepUpGrant;
}

const OPERATION = 'backup_unattested_restore';

function stepUpDetails(err: unknown): StepUpDetails | null {
  if (!(err instanceof ActionError) || err.status !== 403 || err.code !== 'STEP_UP_REQUIRED') return null;
  const body = err.body && typeof err.body === 'object' ? err.body as Record<string, unknown> : {};
  const stepUp = body.stepUp && typeof body.stepUp === 'object' ? body.stepUp as Record<string, unknown> : null;
  if (!stepUp || stepUp.operation !== OPERATION) return null;
  const confirmation = stepUp.method === 'typed' ? typedConfirmation(stepUp) : undefined;
  return {
    // A typed confirmation without a usable phrase falls back to two-factor;
    // the server then refuses the grant and asks again.
    method: stepUp.method === 'confirm' ? 'confirm' : confirmation ? 'typed' : 'mfa',
    reason: typeof stepUp.reason === 'string' ? stepUp.reason : 'unattested',
    resource: stepUp.resource,
    ...(confirmation ? { confirmation } : {}),
  };
}

/**
 * For runAction's `suppressErrorToast`: a restore answered with a step-up
 * request is not a failure — it opens the confirmation prompt instead.
 */
export function suppressUnattestedRestoreStepUpToast(status: number, code: string | undefined): boolean {
  return status === 403 && code === 'STEP_UP_REQUIRED';
}

/** True for the step-up request this hook handles; callers rethrow it instead of showing it as an error. */
export function isUnattestedRestoreStepUp(err: unknown): boolean {
  return stepUpDetails(err) !== null;
}

async function discoverTier(): Promise<ReauthTier> {
  const [user, passkeys] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
  if (!user.ok || !passkeys.ok) throw new Error('factor discovery failed');
  const me = await user.json() as { mfaMethod?: string | null } | null;
  const keys = await passkeys.json() as unknown;
  const list = Array.isArray(keys) ? keys : (keys as { passkeys?: unknown[] } | null)?.passkeys;
  if (!me || !Array.isArray(list)) throw new Error('factor discovery failed');
  return pickReauthTier(list.length, me.mfaMethod ?? null);
}

type Pending = {
  submit: (extras: UnattestedRestoreExtras) => Promise<void>;
  details: StepUpDetails;
  tier: ReauthTier | null;
};

/**
 * Server-driven confirmation for restoring a backup without a usable
 * integrity attestation (same contract as the topology arm and maintenance
 * step-ups): the first submit carries nothing extra, and only a
 * `403 STEP_UP_REQUIRED` for operation `backup_unattested_restore` reveals the
 * prompt. With two-factor authentication on, a grant is minted for the exact
 * resource the server named and the request is resubmitted with
 * `stepUpGrant`. A user without a second factor restoring a backup taken
 * before attestations existed is asked (`method: 'typed'`) to type the device
 * name instead; POST /backup/restore-confirmations mints the grant and the
 * request is resubmitted with it the same way. On a deployment without
 * two-factor authentication, an explicit confirmation resubmits with
 * `confirmUnattestedRestore: true`. The server stays the only
 * enforcer.
 *
 * `submit` must call runAction with `suppressErrorToast:
 * suppressUnattestedRestoreStepUpToast` and let the step-up ActionError reach
 * `run` (rethrow it from its own catch). Any other failure is the caller's to
 * surface; `run` rethrows it.
 */
export function useUnattestedRestoreStepUp(): {
  run: (submit: (extras: UnattestedRestoreExtras) => Promise<void>) => Promise<void>;
  prompt: ReactNode;
} {
  const { t } = useTranslation('backup');
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const run = useCallback(async (submit: (extras: UnattestedRestoreExtras) => Promise<void>) => {
    try {
      await submit({});
    } catch (cause) {
      const details = stepUpDetails(cause);
      if (!details) throw cause;
      let tier: ReauthTier | null = null;
      if (details.method === 'mfa') {
        try {
          tier = await discoverTier();
        } catch {
          if (live.current) setError(t('unattestedRestoreStepUp.unavailable'));
          return;
        }
      }
      if (!live.current) return;
      setCode('');
      setError(undefined);
      setPending({ submit, details, tier });
    }
  }, [t]);

  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      let extras: UnattestedRestoreExtras;
      if (pending.details.method === 'confirm') {
        extras = { confirmUnattestedRestore: true };
      } else if (pending.details.method === 'typed') {
        try {
          extras = { stepUpGrant: await mintTypedConfirmation(pending.details, code) };
        } catch (cause) {
          if (live.current) setError(cause instanceof Error && cause.message ? cause.message : t('unattestedRestoreStepUp.failed'));
          return;
        }
      } else {
        try {
          const stepUpGrant = await mintStepUpGrant({
            operation: OPERATION,
            resource: pending.details.resource,
            reauth: pending.tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
          });
          extras = { stepUpGrant };
        } catch (cause) {
          if (live.current) setError(cause instanceof Error ? cause.message : t('unattestedRestoreStepUp.failed'));
          return;
        }
      }
      if (!live.current) return;
      try {
        await pending.submit(extras);
        if (live.current) setPending(null);
      } catch (cause) {
        // A refused grant comes back as another step-up request; anything
        // else was already surfaced by the caller's own handling.
        if (live.current) {
          setError(stepUpDetails(cause) ? t('unattestedRestoreStepUp.failed') : (cause instanceof Error ? cause.message : t('unattestedRestoreStepUp.failed')));
        }
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  if (!pending) {
    return { run, prompt: error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null };
  }

  const { details, tier } = pending;
  const needsCode = details.method === 'mfa' && tier === 'totp';
  const typed = details.method === 'typed' ? details.confirmation! : null;
  const noFactor = details.method === 'mfa' && tier === 'password';
  const prompt = (
    <div
      data-testid="unattested-restore-stepup"
      role="group"
      aria-labelledby="unattested-restore-stepup-heading"
      className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
    >
      <p id="unattested-restore-stepup-heading" className="text-sm font-medium">{t('unattestedRestoreStepUp.heading')}</p>
      <p className="text-sm text-muted-foreground">
        {details.reason === 'producer_only_other_target'
          ? t('unattestedRestoreStepUp.introProducerOnly')
          : t('unattestedRestoreStepUp.introUnattested')}
      </p>
      <p className="text-xs text-muted-foreground">
        {details.method === 'confirm'
          ? t('unattestedRestoreStepUp.confirmOnly')
          : typed
            ? t('unattestedRestoreStepUp.typedIntro')
            : t('unattestedRestoreStepUp.twoFactor')}
      </p>
      {typed ? (
        <label className="block text-sm">
          {t('unattestedRestoreStepUp.typedLabel', { phrase: typed.phrase })}
          <input
            data-testid="unattested-restore-stepup-phrase"
            className="mt-1 h-10 w-full rounded border bg-background px-3"
            autoComplete="off"
            spellCheck={false}
            maxLength={255}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
          />
        </label>
      ) : noFactor ? <p role="alert" className="text-sm text-destructive">{t('unattestedRestoreStepUp.noFactor')}</p>
        : needsCode ? (
          <label className="block text-sm">{t('unattestedRestoreStepUp.code')}
            <input
              data-testid="unattested-restore-stepup-code"
              className="mt-1 h-10 w-full rounded border bg-background px-3"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              disabled={busy}
            />
          </label>
        ) : details.method === 'mfa' ? <p className="text-xs text-muted-foreground">{t('unattestedRestoreStepUp.passkey')}</p> : null}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="unattested-restore-stepup-confirm"
          className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          disabled={busy || noFactor || (needsCode && code.length !== 6) || (typed !== null && !phraseMatches(typed.phrase, code))}
          onClick={() => void confirm()}
        >
          {t('unattestedRestoreStepUp.confirm')}
        </button>
        <button
          type="button"
          data-testid="unattested-restore-stepup-cancel"
          className="rounded border px-3 py-2 text-sm"
          disabled={busy}
          onClick={() => { setPending(null); setError(undefined); }}
        >
          {t('unattestedRestoreStepUp.cancel')}
        </button>
      </div>
    </div>
  );
  return { run, prompt };
}
