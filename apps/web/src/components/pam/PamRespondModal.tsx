import '@/lib/i18n';
import { useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { getApprovalAssertion } from '../../stores/authenticator';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { type ElevationRequest, FLOW_ICONS, FLOW_LABELS, requestTarget } from './types';
import { DialogHeader, ErrorAlert, btnGhostClass, inputClass } from './ui';
import { RegisterApproverDeviceLink } from '../approvals/RegisterApproverDeviceLink';

/**
 * True when the assertion ceremony failed because the technician has no
 * registered approver device (the challenge carried no allowCredentials), which
 * is a graceful fallback to an L1 approval rather than an error. A genuine
 * user-cancelled/timed-out ceremony surfaces a WebAuthn `NotAllowedError` and
 * must NOT be treated as this case — it aborts the submit instead.
 */
function isNoApproverDeviceError(err: unknown): boolean {
  if (err instanceof DOMException) return false; // browser WebAuthn failure (e.g. cancel)
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoApproverDeviceError';
}

/** `elevation_requests.risk_tier` value the server maps to `'critical'` (L4). */
const CRITICAL_RISK_TIER = 4;

/**
 * 401 bodies the respond route returns for a factor the approver supplied in
 * THIS request: a rejected re-auth password/TOTP code (`invalid_credentials`,
 * from requireCurrentPasswordStepUp / requireFreshMfaStepUp), a critical
 * approve with no re-auth (`reauth_required`), or a rejected WebAuthn assertion
 * (`assertion_failed`). None of them mean the session expired, so none may
 * bounce the approver to /login. Any other 401 still does.
 */
const FACTOR_REJECTION_TOKENS = new Set(['invalid_credentials', 'reauth_required', 'assertion_failed']);

function rejectionToken(body: unknown): string | undefined {
  const b = body as { code?: unknown; error?: unknown } | null | undefined;
  if (typeof b?.code === 'string') return b.code;
  return typeof b?.error === 'string' ? b.error : undefined;
}

function isFactorRejection(body: unknown): boolean {
  const token = rejectionToken(body);
  return token !== undefined && FACTOR_REJECTION_TOKENS.has(token);
}

type ReauthMode = 'password' | 'totp';

export default function PamRespondModal({
  request,
  onClose,
  onActioned,
  onCreateRule,
}: {
  request: ElevationRequest;
  onClose: () => void;
  onActioned: () => void;
  onCreateRule?: () => void;
}) {
  const { t } = useTranslation('security');
  const [decision, setDecision] = useState<'approve' | 'deny'>('approve');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('15');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server refused the approve for want of an approver device,
  // so the error also offers the register-device action.
  const [needsApproverDevice, setNeedsApproverDevice] = useState(false);
  const reasonId = useId();
  const durationId = useId();
  const titleId = useId();
  const reauthId = useId();
  const reauthHelpId = useId();

  // #4052: a critical-tier (L4) approval needs a fresh account
  // re-authentication on top of the approver-device assertion: the account
  // password, or for an SSO-only account the login TOTP code (server:
  // routes/pam.ts respondSchema `reauthPassword` / `reauthMfaCode`). This only
  // collects what the server already requires; its L4 rules are unchanged.
  //
  // `hasPassword` is tri-state (absent = unknown on an older persisted
  // session): only an explicit `false` means passwordless, so unknown keeps
  // the password field, which is right for the vast majority of accounts.
  const user = useAuthStore((s) => s.user);
  const passwordless = user?.hasPassword === false;
  // Passwordless AND no login MFA: neither re-auth path can succeed. A passkey
  // alone cannot satisfy L4 today (#4051; the server's MFA fallback accepts
  // TOTP only), so say so rather than render a field that can never work.
  const noReauthFactor = passwordless && user?.mfaEnabled === false;
  const [reauthMode, setReauthMode] = useState<ReauthMode>(passwordless ? 'totp' : 'password');
  const [reauthSecret, setReauthSecret] = useState('');
  // Set when the server answers `reauth_required` for a request we did not
  // know was critical (riskTier absent or stale), so the fields show on retry.
  const [reauthRequested, setReauthRequested] = useState(false);
  const isCritical = request.riskTier === CRITICAL_RISK_TIER;
  const showReauth = decision === 'approve' && (isCritical || reauthRequested);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setNeedsApproverDevice(false);

    // Take the re-auth secret into a local and clear the field at once: it is
    // sent in exactly one request below and never retained, logged or replayed.
    const collectReauth = showReauth && !noReauthFactor;
    const secret = collectReauth ? reauthSecret.trim() : '';
    if (collectReauth && !secret) {
      setError(
        reauthMode === 'totp'
          ? t('pamPamRespondModal.reauth.errors.codeRequired', {
              defaultValue: 'Enter the code from your authenticator app to approve this critical request.',
            })
          : t('pamPamRespondModal.reauth.errors.passwordRequired', {
              defaultValue: 'Enter your account password to approve this critical request.',
            }),
      );
      setSubmitting(false);
      return;
    }
    setReauthSecret('');

    const body: Record<string, unknown> = { decision };
    if (reason.trim()) body.reason = reason.trim();
    if (secret) {
      if (reauthMode === 'totp') body.reauthMfaCode = secret;
      else body.reauthPassword = secret;
    }
    if (decision === 'approve') {
      const mins = Number.parseInt(duration, 10);
      if (Number.isFinite(mins) && mins >= 1) body.durationMinutes = mins;

      // Breeze Authenticator Phase 2 — opt-in Windows Hello / Touch ID step-up.
      // Run the approval-scoped assertion ceremony before submitting. A returned
      // proof upgrades the recorded approval to L2 (webauthn_platform); a
      // cancelled/failed ceremony aborts the submit (we never silently downgrade
      // a presented-but-failed assertion). Technicians with no registered
      // approver device fall back to an L1 (session-tap) approval — P2 is opt-in,
      // not required (enforcement is Phase 4), so a missing-device case must not
      // block the approve.
      try {
        const proof = await getApprovalAssertion('/pam/elevation-requests', request.id);
        body.proof = proof;
      } catch (err) {
        // No registered approver device → the challenge carries no
        // allowCredentials and the ceremony can't run; submit without proof
        // (records L1). Any other ceremony failure (user cancelled, timeout) is
        // a real error: surface it and abort rather than downgrade.
        if (!isNoApproverDeviceError(err)) {
          setError(
            err instanceof Error
              ? err.message
              : t('pamPamRespondModal.errors.windowsHello', {
                  defaultValue: 'Windows Hello verification failed',
                }),
          );
          setSubmitting(false);
          return;
        }
      }
    }

    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/pam/elevation-requests/${request.id}/respond`, {
            method: 'POST',
            body: JSON.stringify(body),
            // An approve body is single-use: the WebAuthn assertion is consumed
            // server-side, and a re-auth password/code must never be re-sent
            // (a replay double-counts against the step-up rate limit, and a
            // TOTP step is consumed once). The assertion-challenge fetch just
            // before this has already refreshed an expiring access token.
            ...(decision === 'approve' ? { skipUnauthorizedRetry: true } : {}),
          }),
        errorFallback: t('pamPamRespondModal.errors.actionFailed', {
          defaultValue: 'Failed to {{decision}} request',
          decision,
        }),
        successMessage:
          decision === 'approve'
            ? t('pamPamRespondModal.toasts.approved', { defaultValue: 'Elevation approved' })
            : t('pamPamRespondModal.toasts.denied', { defaultValue: 'Elevation denied' }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
        // On approve a 401 is usually a rejected factor (wrong password/code,
        // missing re-auth, failed assertion), not an expired session: surface
        // those as errors. Any other 401 keeps the silent /login redirect.
        treatUnauthorizedAsError: decision === 'approve' ? isFactorRejection : false,
        friendly: (token) => {
          switch (token) {
            case 'invalid_credentials':
              return t('pamPamRespondModal.reauth.errors.invalid', {
                defaultValue: 'That password or code was not accepted. Check it and try again.',
              });
            case 'reauth_required':
              return t('pamPamRespondModal.reauth.errors.required', {
                defaultValue:
                  'This is a critical request. Re-enter your password (or authenticator code) and approve again.',
              });
            case 'assertion_failed':
              return t('pamPamRespondModal.reauth.errors.assertionFailed', {
                defaultValue: 'Your approver-device verification was not accepted. Try again.',
              });
            case 'step_up_required':
              // Same copy (and, below, the same action) as the approvals inbox.
              return t('approvals:errors.noApproverDevice');
            default:
              return undefined;
          }
        },
      });
      onActioned();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) {
          // Session expiry: onUnauthorized already redirected, no body.
          if (!isFactorRejection(err.body)) return;
          if (rejectionToken(err.body) === 'reauth_required') setReauthRequested(true);
          setError(err.message);
          return;
        }
        if (err.status === 409) {
          // CAS race: someone else (or a reaper) actioned it first. runAction
          // already toasted the server message (e.g. "Request is not pending")
          // — just refresh the list, no extra toast.
          onActioned();
          return;
        }
        if (err.status === 403 && rejectionToken(err.body) === 'step_up_required') {
          setNeedsApproverDevice(true);
        }
        setError(err.message);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : t('pamPamRespondModal.errors.network', { defaultValue: 'Network error' }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const modalTitle = t('pamPamRespondModal.title', {
    defaultValue: 'Respond to elevation request',
  });
  const FlowIcon = FLOW_ICONS[request.flowType];

  return (
    <Dialog open onClose={onClose} title={modalTitle} labelledBy={titleId} maxWidth="lg">
      <DialogHeader id={titleId} title={modalTitle} />
      <form onSubmit={handleSubmit} className="space-y-4 p-6">
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <FlowIcon className="h-4.5 w-4.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 text-sm">
            <div className="truncate font-medium" title={requestTarget(request)}>
              {requestTarget(request)}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {request.deviceHostname ?? request.deviceId} · {request.subjectUsername} ·{' '}
              {FLOW_LABELS[request.flowType]}
            </div>
            {request.reason && (
              <div className="mt-1 text-xs text-muted-foreground">
                {t('pamPamRespondModal.summary.reason', {
                  defaultValue: 'Reason: {{reason}}',
                  reason: request.reason,
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDecision('approve')}
            aria-pressed={decision === 'approve'}
            data-testid="pam-respond-approve-toggle"
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              decision === 'approve'
                ? 'border-green-500 bg-green-500/10 text-green-600 dark:text-green-400'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {t('pamPamRespondModal.decisions.approve', { defaultValue: 'Approve' })}
          </button>
          <button
            type="button"
            onClick={() => setDecision('deny')}
            aria-pressed={decision === 'deny'}
            data-testid="pam-respond-deny-toggle"
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              decision === 'deny'
                ? 'border-red-500 bg-red-500/10 text-red-600 dark:text-red-400'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {t('pamPamRespondModal.decisions.deny', { defaultValue: 'Deny' })}
          </button>
        </div>

        {decision === 'approve' && (
          <div>
            <label htmlFor={durationId} className="mb-1 block text-sm font-medium">
              {t('pamPamRespondModal.form.approvalWindow', {
                defaultValue: 'Approval window (minutes)',
              })}
            </label>
            <input
              id={durationId}
              type="number"
              min={1}
              max={1440}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              data-testid="pam-respond-duration"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('pamPamRespondModal.form.durationHelp', {
                defaultValue: '1 to 1440 minutes (24h max).',
              })}
            </p>
          </div>
        )}

        {showReauth && (
          <div
            data-testid="pam-respond-reauth"
            className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
          >
            <p className="text-sm font-medium">
              {t('pamPamRespondModal.reauth.title', {
                defaultValue: 'Critical request: confirm it is you',
              })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('pamPamRespondModal.reauth.why', {
                defaultValue:
                  'Approving a critical-tier elevation requires fresh re-authentication in addition to your approver device. It is checked once and never stored.',
              })}
            </p>
            {noReauthFactor ? (
              <p
                data-testid="pam-respond-reauth-unavailable"
                className="mt-3 text-xs text-amber-700 dark:text-amber-400"
              >
                {t('pamPamRespondModal.reauth.unavailable', {
                  defaultValue:
                    'Your account signs in without a password and has no authenticator app, so it cannot re-authenticate for critical approvals. Passkeys are not accepted for this step yet. Set up an authenticator app under Profile → Security, or ask an approver who has a password.',
                })}
              </p>
            ) : (
              <div className="mt-3">
                <label htmlFor={reauthId} className="mb-1 block text-sm font-medium">
                  {reauthMode === 'totp'
                    ? t('pamPamRespondModal.reauth.codeLabel', {
                        defaultValue: 'Authenticator app code',
                      })
                    : t('pamPamRespondModal.reauth.passwordLabel', {
                        defaultValue: 'Account password',
                      })}
                </label>
                <input
                  id={reauthId}
                  // Keyed by mode so a typed password never carries into the
                  // code field (or the reverse) when the approver switches.
                  key={reauthMode}
                  type={reauthMode === 'totp' ? 'text' : 'password'}
                  inputMode={reauthMode === 'totp' ? 'numeric' : undefined}
                  autoComplete={reauthMode === 'totp' ? 'one-time-code' : 'current-password'}
                  maxLength={reauthMode === 'totp' ? 16 : 256}
                  value={reauthSecret}
                  onChange={(e) => setReauthSecret(e.target.value)}
                  aria-describedby={reauthHelpId}
                  data-testid="pam-respond-reauth-input"
                  className={inputClass}
                />
                <p id={reauthHelpId} className="mt-1 text-xs text-muted-foreground">
                  {reauthMode === 'totp'
                    ? t('pamPamRespondModal.reauth.codeHelp', {
                        defaultValue:
                          'The 6-digit code from the authenticator app you sign in with. Passkeys and SMS codes are not accepted for this step yet.',
                      })
                    : t('pamPamRespondModal.reauth.passwordHelp', {
                        defaultValue: 'The password you use to sign in to Breeze.',
                      })}
                </p>
                {/* Offer the switch only when both factors can exist: a
                    passwordless account has no password, and an account with
                    MFA explicitly off has no authenticator code. */}
                {!passwordless && user?.mfaEnabled !== false && (
                  <button
                    type="button"
                    onClick={() => {
                      setReauthSecret('');
                      setReauthMode((m) => (m === 'password' ? 'totp' : 'password'));
                    }}
                    data-testid="pam-respond-reauth-mode-toggle"
                    className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    {reauthMode === 'password'
                      ? t('pamPamRespondModal.reauth.useCode', {
                          defaultValue: 'Use an authenticator app code instead',
                        })
                      : t('pamPamRespondModal.reauth.usePassword', {
                          defaultValue: 'Use my password instead',
                        })}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <label htmlFor={reasonId} className="mb-1 block text-sm font-medium">
            {decision === 'deny'
              ? t('pamPamRespondModal.form.reasonRecommended', {
                  defaultValue: 'Reason (recommended)',
                })
              : t('pamPamRespondModal.form.reasonOptional', { defaultValue: 'Reason (optional)' })}
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            rows={3}
            data-testid="pam-respond-reason"
            className={inputClass}
            placeholder={t('pamPamRespondModal.form.reasonPlaceholder', {
              defaultValue: 'Recorded in the audit trail',
            })}
          />
        </div>

        {error && (
          <ErrorAlert>
            {error}
            {needsApproverDevice && (
              <>
                {' '}
                <RegisterApproverDeviceLink />
              </>
            )}
          </ErrorAlert>
        )}

        <div className="flex items-center justify-between gap-2">
          {onCreateRule ? (
            <button
              type="button"
              onClick={onCreateRule}
              disabled={submitting}
              data-testid="pam-respond-create-rule"
              className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t('pamPamRespondModal.actions.createRule', {
                defaultValue: 'Create rule from this request…',
              })}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={btnGhostClass}>
              {t('common:actions.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="pam-respond-submit"
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white shadow-xs transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                decision === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {submitting
                ? t('pamPamRespondModal.actions.submitting', { defaultValue: 'Submitting…' })
                : decision === 'approve'
                  ? t('pamPamRespondModal.actions.approveElevation', {
                      defaultValue: 'Approve elevation',
                    })
                  : t('pamPamRespondModal.actions.denyRequest', { defaultValue: 'Deny request' })}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
