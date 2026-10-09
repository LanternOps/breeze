import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../lib/runAction';
import { mintStepUpGrant } from '../../lib/mfaStepUp';
import { fetchWithAuth, restoreAccessTokenFromCookie } from '../../stores/auth';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';

/** Extra body fields a restore request carries once the operator confirmed it. */
export type UnattestedRestoreExtras = { stepUpGrant?: string; confirmUnattestedRestore?: boolean };

/**
 * Sends the restore request. Resolves true when the server accepted it (the
 * restore started), false when it failed and the caller already surfaced the
 * failure. Throws only the step-up answers this hook handles.
 */
export type UnattestedRestoreSubmit = (extras: UnattestedRestoreExtras) => Promise<boolean>;

type StepUpDetails = {
  /** `enroll`: the user has no second factor and must set one up first. */
  method: 'mfa' | 'confirm' | 'enroll';
  reason: string;
  /** Exactly the resource the server digests for the grant; sent back verbatim. */
  resource: unknown;
};

const OPERATION = 'backup_unattested_restore';
const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';
const MFA_ENROLLMENT_REQUIRED = 'MFA_ENROLLMENT_REQUIRED';
/** Where a user sets up an authenticator app or a passkey. */
const ENROLL_HREF = '/settings/profile';

function stepUpDetails(err: unknown): StepUpDetails | null {
  if (!(err instanceof ActionError) || err.status !== 403) return null;
  if (err.code !== STEP_UP_REQUIRED && err.code !== MFA_ENROLLMENT_REQUIRED) return null;
  const body = err.body && typeof err.body === 'object' ? err.body as Record<string, unknown> : {};
  const stepUp = body.stepUp && typeof body.stepUp === 'object' ? body.stepUp as Record<string, unknown> : null;
  if (!stepUp || stepUp.operation !== OPERATION) return null;
  return {
    method: err.code === MFA_ENROLLMENT_REQUIRED ? 'enroll' : stepUp.method === 'confirm' ? 'confirm' : 'mfa',
    reason: typeof stepUp.reason === 'string' ? stepUp.reason : 'unattested',
    resource: stepUp.resource,
  };
}

/**
 * For runAction's `suppressErrorToast`: a restore answered with a step-up
 * request (or a request to enroll a second factor first) is not a failure —
 * it opens the confirmation prompt instead.
 */
export function suppressUnattestedRestoreStepUpToast(status: number, code: string | undefined): boolean {
  return status === 403 && (code === STEP_UP_REQUIRED || code === MFA_ENROLLMENT_REQUIRED);
}

/** True for the step-up request this hook handles; callers rethrow it instead of showing it as an error. */
export function isUnattestedRestoreStepUp(err: unknown): boolean {
  return stepUpDetails(err) !== null;
}

/**
 * The factor this prompt can confirm with. `smsOnly`: the account's only
 * factor is text-message codes, which this prompt cannot use.
 */
async function discoverFactors(): Promise<{ tier: ReauthTier; smsOnly: boolean }> {
  const [user, passkeys] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
  if (!user.ok || !passkeys.ok) throw new Error('factor discovery failed');
  const me = await user.json() as { mfaEnabled?: boolean | null; mfaMethod?: string | null } | null;
  const keys = await passkeys.json() as unknown;
  const list = Array.isArray(keys) ? keys : (keys as { passkeys?: unknown[] } | null)?.passkeys;
  if (!me || !Array.isArray(list)) throw new Error('factor discovery failed');
  return {
    tier: pickReauthTier(list.length, me.mfaMethod ?? null),
    smsOnly: list.length === 0 && me.mfaEnabled === true && me.mfaMethod === 'sms',
  };
}

/**
 * What the prompt asks for: set up a second factor first (the server said so,
 * or the account has no factor this prompt can use), a TOTP code, a passkey,
 * or an explicit confirmation (two-factor authentication disabled).
 */
type PromptMode = 'enroll' | 'code' | 'passkey' | 'confirm';

function modeForTier(tier: ReauthTier): PromptMode {
  if (tier === 'passkey') return 'passkey';
  if (tier === 'totp') return 'code';
  return 'enroll';
}

type Pending = {
  submit: UnattestedRestoreSubmit;
  details: StepUpDetails;
  mode: PromptMode;
  /** With mode `enroll`: the account has text-message codes but no factor this prompt can use. */
  smsOnly: boolean;
};

/**
 * Server-driven confirmation for restoring a backup without a usable
 * integrity attestation (same contract as the topology arm and maintenance
 * step-ups): the first submit carries nothing extra, and only a
 * `403 STEP_UP_REQUIRED` for operation `backup_unattested_restore` reveals the
 * prompt. With two-factor authentication on, a grant is minted for the exact
 * resource the server named and the request is resubmitted with
 * `stepUpGrant`. A user without a second factor gets
 * `403 MFA_ENROLLMENT_REQUIRED` instead: the prompt links to the profile page
 * to set one up, and Retry refreshes the session (setting up a factor ends
 * the old one) and resubmits the request, which then asks for the two-factor
 * step-up. On a deployment without two-factor authentication, an explicit
 * confirmation resubmits with `confirmUnattestedRestore: true`. The server
 * stays the only enforcer.
 *
 * `submit` (UnattestedRestoreSubmit) must call runAction with
 * `suppressErrorToast: suppressUnattestedRestoreStepUpToast`, let the step-up
 * ActionError reach the hook (rethrow it from its own catch), surface any
 * other failure itself and resolve false for it, and resolve true only when
 * the restore was accepted. The prompt stays open until a resubmit resolves
 * true.
 */
export function useUnattestedRestoreStepUp(): {
  run: (submit: UnattestedRestoreSubmit) => Promise<void>;
  prompt: ReactNode;
} {
  const { t } = useTranslation('backup');
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /** Shows the prompt for a step-up answer; null when the factor discovery failed. */
  const present = useCallback(async (
    submit: UnattestedRestoreSubmit,
    details: StepUpDetails,
  ): Promise<Pending | null> => {
    let mode: PromptMode;
    let smsOnly = false;
    if (details.method === 'mfa') {
      try {
        const factors = await discoverFactors();
        mode = modeForTier(factors.tier);
        smsOnly = factors.smsOnly;
      } catch {
        if (live.current) setError(t('unattestedRestoreStepUp.unavailable'));
        return null;
      }
    } else {
      mode = details.method;
    }
    if (!live.current) return null;
    const next: Pending = { submit, details, mode, smsOnly };
    setCode('');
    setError(undefined);
    setPending(next);
    return next;
  }, [t]);

  const run = useCallback(async (submit: UnattestedRestoreSubmit) => {
    try {
      await submit({});
    } catch (cause) {
      const details = stepUpDetails(cause);
      if (!details) throw cause;
      await present(submit, details);
    }
  }, [present]);

  // After the user set up a factor (in another tab), resubmit the restore as
  // it was first sent: the server now asks for the two-factor step-up. The
  // prompt stays open unless the caller reports the restore started (a
  // failure was already surfaced by the caller).
  const retry = async () => {
    if (!pending || busy) return;
    const { submit } = pending;
    setBusy(true);
    setError(undefined);
    try {
      // Setting up a factor ends this tab's session tokens: refresh first so
      // the resubmit carries a current token. If the refresh fails, the
      // request's own unauthorized handling decides.
      await restoreAccessTokenFromCookie();
      if (await submit({}) && live.current) setPending(null);
    } catch (cause) {
      // submit throws only the step-up answers.
      const details = stepUpDetails(cause);
      if (!details || !live.current) return;
      const next = await present(submit, details);
      if (next?.mode === 'enroll' && live.current) {
        setError(next.smsOnly
          ? t('unattestedRestoreStepUp.enrollStillRequiredSmsOnly')
          : t('unattestedRestoreStepUp.enrollStillRequired'));
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending || busy || pending.mode === 'enroll') return;
    setBusy(true);
    setError(undefined);
    try {
      let extras: UnattestedRestoreExtras;
      if (pending.mode === 'confirm') {
        extras = { confirmUnattestedRestore: true };
      } else {
        try {
          const stepUpGrant = await mintStepUpGrant({
            operation: OPERATION,
            resource: pending.details.resource,
            reauth: pending.mode === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
          });
          extras = { stepUpGrant };
        } catch (cause) {
          if (live.current) setError(cause instanceof Error ? cause.message : t('unattestedRestoreStepUp.failed'));
          return;
        }
      }
      if (!live.current) return;
      try {
        if (await pending.submit(extras) && live.current) setPending(null);
      } catch {
        // submit throws only the step-up answers: the grant was refused.
        if (live.current) setError(t('unattestedRestoreStepUp.failed'));
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  if (!pending) {
    return { run, prompt: error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null };
  }

  const { details, mode, smsOnly } = pending;
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
      {mode === 'enroll' ? (
        <>
          <p className="text-xs text-muted-foreground">
            {smsOnly ? t('unattestedRestoreStepUp.enrollIntroSmsOnly') : t('unattestedRestoreStepUp.enrollIntro')}
          </p>
          <a
            data-testid="unattested-restore-stepup-enroll"
            href={ENROLL_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm font-medium underline underline-offset-4"
          >
            {t('unattestedRestoreStepUp.enrollLink')}
          </a>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {mode === 'confirm'
            ? t('unattestedRestoreStepUp.confirmOnly')
            : t('unattestedRestoreStepUp.twoFactor')}
        </p>
      )}
      {mode === 'code' && (
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
      )}
      {mode === 'passkey' && <p className="text-xs text-muted-foreground">{t('unattestedRestoreStepUp.passkey')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        {mode === 'enroll' ? (
          <button
            type="button"
            data-testid="unattested-restore-stepup-retry"
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => void retry()}
          >
            {t('common:actions.retry')}
          </button>
        ) : (
          <button
            type="button"
            data-testid="unattested-restore-stepup-confirm"
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            disabled={busy || (mode === 'code' && code.length !== 6)}
            onClick={() => void confirm()}
          >
            {t('unattestedRestoreStepUp.confirm')}
          </button>
        )}
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
