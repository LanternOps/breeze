import { useId, useState } from 'react';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { type ElevationRequest, FLOW_LABELS, requestTarget } from './types';

export default function PamRespondModal({
  request,
  onClose,
  onActioned,
}: {
  request: ElevationRequest;
  onClose: () => void;
  onActioned: () => void;
}) {
  const [decision, setDecision] = useState<'approve' | 'deny'>('approve');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('15');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const durationId = useId();

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
    }

    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/pam/elevation-requests/${request.id}/respond`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        errorFallback: `Failed to ${decision} request`,
        successMessage: decision === 'approve' ? 'Elevation approved' : 'Elevation denied',
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
        setError(err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Respond to elevation request" maxWidth="lg">
      <form onSubmit={handleSubmit} className="space-y-4 p-6 pt-2">
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="font-medium">{requestTarget(request)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {request.deviceHostname ?? request.deviceId} · {request.subjectUsername} ·{' '}
            {FLOW_LABELS[request.flowType]}
          </div>
          {request.reason && (
            <div className="mt-1 text-xs text-muted-foreground">Reason: {request.reason}</div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDecision('approve')}
            data-testid="pam-respond-approve-toggle"
            className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
              decision === 'approve'
                ? 'border-green-500 bg-green-500/10 text-green-600 dark:text-green-400'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setDecision('deny')}
            data-testid="pam-respond-deny-toggle"
            className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
              decision === 'deny'
                ? 'border-red-500 bg-red-500/10 text-red-600 dark:text-red-400'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            Deny
          </button>
        </div>

        {decision === 'approve' && (
          <div>
            <label htmlFor={durationId} className="mb-1 block text-sm font-medium">
              Approval window (minutes)
            </label>
            <input
              id={durationId}
              type="number"
              min={1}
              max={1440}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              data-testid="pam-respond-duration"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">1 to 1440 minutes (24h max).</p>
          </div>
        )}

        <div>
          <label htmlFor={reasonId} className="mb-1 block text-sm font-medium">
            Reason {decision === 'deny' ? '(recommended)' : '(optional)'}
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            rows={3}
            data-testid="pam-respond-reason"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Recorded in the audit trail"
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
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="pam-respond-submit"
            className={`rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              decision === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {submitting ? 'Submitting…' : decision === 'approve' ? 'Approve elevation' : 'Deny request'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
