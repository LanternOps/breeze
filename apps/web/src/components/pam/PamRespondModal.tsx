import '@/lib/i18n';
import { useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { getApprovalAssertion } from '../../stores/authenticator';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { type ElevationRequest, FLOW_ICONS, FLOW_LABELS, requestTarget } from './types';
import { DialogHeader, ErrorAlert, btnGhostClass, inputClass } from './ui';

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
  const reasonId = useId();
  const durationId = useId();
  const titleId = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const body: Record<string, unknown> = { decision };
    if (reason.trim()) body.reason = reason.trim();
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
      });
      onActioned();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        if (err.status === 409) {
          // CAS race: someone else (or a reaper) actioned it first. runAction
          // already toasted the server message (e.g. "Request is not pending")
          // — just refresh the list, no extra toast.
          onActioned();
          return;
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

        {error && <ErrorAlert>{error}</ErrorAlert>}

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
