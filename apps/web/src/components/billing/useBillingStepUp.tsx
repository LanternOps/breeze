import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../lib/runAction';
import { mintStepUpGrant } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';

/** Billing actions the API confirms with a second factor (apps/api/src/routes/billingStepUp.ts). */
export const BILLING_STEP_UP_OPERATIONS = ['autopay_charge_now', 'partner_payment_settings_update', 'org_payment_settings_update', 'autopay_request_recipient'] as const;
export type BillingStepUpOperation = typeof BILLING_STEP_UP_OPERATIONS[number];

/** Sends the request; `stepUpGrant` is set only on the resubmit after a confirmation. */
export type BillingStepUpSubmit<T> = (stepUpGrant?: string) => Promise<T>;
/** `confirmed: false`: the user closed the prompt, or it could not be shown (an error was shown instead). */
export type BillingStepUpOutcome<T> = { confirmed: true; value: T } | { confirmed: false };

type Details = { operation: BillingStepUpOperation; resource: unknown };
type Pending = {
  details: Details;
  tier: ReauthTier;
  /** With tier `password`: the account's only factor is text-message codes, which cannot confirm here. */
  smsOnly: boolean;
  /** A resubmit with a minted grant is in flight: only its own result may settle the caller. */
  submitting: boolean;
  submit: BillingStepUpSubmit<unknown>;
  resolve: (outcome: BillingStepUpOutcome<unknown>) => void;
  reject: (cause: unknown) => void;
};

const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';
/** Where a user adds an authenticator app or a passkey. */
const ENROLL_HREF = '/settings/profile';

function stepUpDetails(err: unknown): Details | null {
  if (!(err instanceof ActionError) || err.status !== 403 || err.code !== STEP_UP_REQUIRED) return null;
  const body = err.body && typeof err.body === 'object' ? err.body as Record<string, unknown> : {};
  const stepUp = body.stepUp && typeof body.stepUp === 'object' ? body.stepUp as Record<string, unknown> : null;
  const operation = stepUp?.operation;
  if (typeof operation !== 'string' || !(BILLING_STEP_UP_OPERATIONS as readonly string[]).includes(operation)) return null;
  return { operation: operation as BillingStepUpOperation, resource: stepUp!.resource };
}

/**
 * For runAction's `suppressErrorToast`: a step-up request is not a failure,
 * it opens the confirmation prompt instead.
 */
export function suppressBillingStepUpToast(status: number, code: string | undefined): boolean {
  return status === 403 && code === STEP_UP_REQUIRED;
}

async function discoverTier(): Promise<{ tier: ReauthTier; smsOnly: boolean }> {
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
 * Server-driven second-factor confirmation for charging a client now, saving
 * partner or organization payment settings and sending an authorization
 * request to another address (same contract as the topology arm and unattested-restore
 * step-ups). The first submit carries no grant; only a `403 STEP_UP_REQUIRED`
 * naming one of the operations above reveals the prompt. The grant is minted
 * for exactly the resource the server named and the request is resubmitted
 * with it. On a deployment without two-factor authentication the server never
 * asks, so the first submit simply succeeds. The server stays the only
 * enforcer.
 *
 * `submit` must call runAction with `suppressErrorToast: suppressBillingStepUpToast`
 * (combined with any of its own) so the step-up answer is not toasted. `run`
 * resolves once the action succeeded (`confirmed: true`) or the user closed
 * the prompt (`confirmed: false`), and rejects with any other failure of the
 * first submit or the resubmit, which runAction already surfaced.
 */
export function useBillingStepUp(): {
  run: <T>(submit: BillingStepUpSubmit<T>) => Promise<BillingStepUpOutcome<T>>;
  prompt: ReactNode;
  pending: boolean;
} {
  const { t } = useTranslation('billing');
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const current = useRef<Pending | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      // An unmounted prompt can never be confirmed: settle the caller's await,
      // unless a confirmed resubmit is in flight (it settles the caller itself,
      // so a charge that may have happened is never read as a cancel).
      if (current.current && !current.current.submitting) current.current.resolve({ confirmed: false });
      current.current = null;
    };
  }, []);

  const show = (next: Pending | null) => { current.current = next; setPending(next); };

  const run = useCallback(async <T,>(submit: BillingStepUpSubmit<T>): Promise<BillingStepUpOutcome<T>> => {
    setError(undefined);
    try {
      return { confirmed: true, value: await submit() };
    } catch (cause) {
      const details = stepUpDetails(cause);
      if (!details) {
        // runAction does not toast a step-up answer (suppressBillingStepUpToast);
        // one for an operation this prompt does not know must not end in silence.
        if (cause instanceof ActionError && suppressBillingStepUpToast(cause.status, cause.code)) {
          showToast({ type: 'error', message: t('autopay.stepUp.unavailable') });
        }
        throw cause;
      }
      let factors: { tier: ReauthTier; smsOnly: boolean };
      try {
        factors = await discoverTier();
      } catch {
        // A toast, not an inline error: the caller may close the view that renders the prompt.
        showToast({ type: 'error', message: t('autopay.stepUp.unavailable') });
        return { confirmed: false };
      }
      if (!live.current) return { confirmed: false };
      return new Promise<BillingStepUpOutcome<T>>((resolve, reject) => {
        setCode('');
        setError(undefined);
        show({ details, ...factors, submitting: false, submit: submit as BillingStepUpSubmit<unknown>,
          resolve: resolve as Pending['resolve'], reject });
      });
    }
  }, [t]);

  const confirm = async () => {
    const active = current.current;
    if (!active || busy || active.tier === 'password') return;
    setBusy(true);
    setError(undefined);
    try {
      let grant: string;
      try {
        grant = await mintStepUpGrant({
          operation: active.details.operation,
          resource: active.details.resource,
          reauth: active.tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
      } catch (cause) {
        if (live.current) setError(cause instanceof Error ? cause.message : t('autopay.stepUp.failed'));
        return;
      }
      if (!live.current) return;
      active.submitting = true;
      try {
        const value = await active.submit(grant);
        if (current.current === active) show(null);
        active.resolve({ confirmed: true, value });
      } catch (cause) {
        active.submitting = false;
        if (stepUpDetails(cause) && live.current) {
          // The grant was refused (expired, or the values changed): ask again.
          setCode(''); setError(t('autopay.stepUp.failed'));
          return;
        }
        if (current.current === active) show(null);
        active.reject(cause);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const cancel = () => {
    const active = current.current;
    show(null);
    setError(undefined);
    active?.resolve({ confirmed: false });
  };

  if (!pending) {
    return { run, pending: false, prompt: error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null };
  }
  const { tier, details, smsOnly } = pending;
  const prompt = (
    <div data-testid="billing-stepup" role="group" aria-labelledby="billing-stepup-heading"
      className="space-y-2 rounded-md border border-primary/40 bg-card p-3">
      <p id="billing-stepup-heading" className="text-sm font-medium">{t('autopay.stepUp.heading')}</p>
      <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `autopay.stepUp.intro.${details.operation}`)}</p>
      {tier === 'password' ? (
        <p role="alert" className="text-sm text-destructive">
          {smsOnly ? t('autopay.stepUp.noFactorSmsOnly') : t('autopay.stepUp.noFactor')}{' '}
          <a data-testid="billing-stepup-enroll" href={ENROLL_HREF} target="_blank" rel="noopener noreferrer"
            className="font-medium underline underline-offset-4">{t('autopay.stepUp.enrollLink')}</a>
        </p>
      ) : tier === 'totp' ? (
        <label className="block text-sm">{t('autopay.stepUp.code')}
          <input data-testid="billing-stepup-code" className="mt-1 h-10 w-full rounded border bg-background px-3"
            inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g, ''))} disabled={busy} />
        </label>
      ) : <p className="text-xs text-muted-foreground">{t('autopay.stepUp.passkey')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="billing-stepup-confirm"
          className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          disabled={busy || tier === 'password' || (tier === 'totp' && code.length !== 6)}
          onClick={() => void confirm()}>{t('autopay.stepUp.confirm')}</button>
        <button type="button" data-testid="billing-stepup-cancel" className="rounded border px-3 py-2 text-sm"
          disabled={busy} onClick={cancel}>{t('autopay.cancel')}</button>
      </div>
    </div>
  );
  return { run, prompt, pending: true };
}
