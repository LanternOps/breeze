import '@/lib/i18n';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { type ElevationRequest, requestTarget } from './types';

export default function PamRevokeModal({
  request,
  onClose,
  onActioned,
}: {
  request: ElevationRequest;
  onClose: () => void;
  onActioned: () => void;
}) {
  const { t } = useTranslation('security');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !reason.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/pam/elevation-requests/${request.id}/revoke`, {
            method: 'POST',
            body: JSON.stringify({ reason: reason.trim() }),
          }),
        errorFallback: t('pamPamRevokeModal.errors.revokeFailed', {
          defaultValue: 'Failed to revoke elevation',
        }),
        successMessage: t('pamPamRevokeModal.toasts.revoked', { defaultValue: 'Elevation revoked' }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onActioned();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        if (err.status === 409) {
          // Already ended (race with expiry/another admin). runAction already
          // toasted the server message — just refresh the list, no extra toast.
          onActioned();
          return;
        }
        setError(err.message);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : t('pamPamRevokeModal.errors.network', { defaultValue: 'Network error' }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('pamPamRevokeModal.title', { defaultValue: 'Revoke active elevation' })}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-6 pt-2">
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="pamPamRevokeModal.description"
            ns="security"
            values={{
              target: requestTarget(request),
              device: request.deviceHostname ?? request.deviceId,
            }}
            defaults="Ends the elevation window for <target>{{target}}</target> on <device>{{device}}</device> immediately."
            components={{
              target: <span className="font-medium text-foreground" />,
              device: <span className="font-medium text-foreground" />,
            }}
          />
        </p>

        <div>
          <label htmlFor={reasonId} className="mb-1 block text-sm font-medium">
            {t('pamPamRevokeModal.form.reasonRequired', { defaultValue: 'Reason (required)' })}
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            rows={3}
            required
            data-testid="pam-revoke-reason"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder={t('pamPamRevokeModal.form.reasonPlaceholder', {
              defaultValue: 'Recorded in the audit trail',
            })}
          />
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            {t('common:actions.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            disabled={submitting || !reason.trim()}
            data-testid="pam-revoke-submit"
            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submitting
              ? t('pamPamRevokeModal.actions.revoking', { defaultValue: 'Revoking…' })
              : t('pamPamRevokeModal.actions.revokeElevation', {
                  defaultValue: 'Revoke elevation',
                })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
