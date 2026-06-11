import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, AlertTriangle, CheckCircle2, Loader2, ShieldAlert, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { formatAbsolute, formatRelative } from '../account/relativeTime';

interface AdminDeletionRequest {
  requestId: string;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  requestedAt: string;
  processBy: string;
  processedAt: string | null;
  processedBy: string | null;
  reason: string | null;
  adminNote: string | null;
  orgId: string | null;
  user: {
    id: string;
    email: string;
    name: string;
    joinedAt: string | null;
  } | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; request: AdminDeletionRequest };

interface ConfirmDialogState {
  action: 'approve' | 'reject';
  adminNote: string;
  typedEmail: string;
}

interface Props {
  requestId: string;
}

export default function AccountDeletionRequestDetail({ requestId }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<ConfirmDialogState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetchWithAuth(`/admin/account-deletion-requests/${encodeURIComponent(requestId)}`);
      if (res.status === 403) return setState({ kind: 'unauthorized' });
      if (res.status === 404) return setState({ kind: 'not-found' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return setState({ kind: 'error', message: body.error ?? `Request failed (${res.status})` });
      }
      const body = (await res.json()) as AdminDeletionRequest;
      setState({ kind: 'ready', request: body });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleProcess = async () => {
    if (!dialog || state.kind !== 'ready') return;
    if (state.request.user && dialog.typedEmail.trim() !== state.request.user.email) {
      showToast({ type: 'error', message: 'The email you typed does not match.' });
      return;
    }
    if (dialog.action === 'reject' && dialog.adminNote.trim().length === 0) {
      showToast({ type: 'error', message: 'A note is required when rejecting.' });
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = { action: dialog.action };
      if (dialog.adminNote.trim().length > 0) payload.adminNote = dialog.adminNote.trim();

      const res = await fetchWithAuth(
        `/admin/account-deletion-requests/${encodeURIComponent(requestId)}/process`,
        { method: 'POST', body: JSON.stringify(payload) }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast({ type: 'error', message: body.error ?? `Action failed (${res.status})` });
        return;
      }

      const updated = (await res.json()) as AdminDeletionRequest;
      setState({ kind: 'ready', request: updated });
      setDialog(null);
      showToast({
        type: 'success',
        message: dialog.action === 'approve'
          ? 'Request approved and queued for processing.'
          : 'Request rejected. The user has been notified.',
      });
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <a
        href="/admin/account-deletion-requests"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to deletion requests
      </a>

      {state.kind === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      )}

      {state.kind === 'unauthorized' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive">Not allowed</h2>
          <p className="mt-1 text-sm text-destructive">
            You don't have permission to review this request.
          </p>
        </div>
      )}

      {state.kind === 'not-found' && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <h2 className="text-base font-semibold">Request not found</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been removed or it doesn't exist in your tenant.
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <div>
            <p>{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-1 rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          <DetailHeader request={state.request} />
          <UserCard request={state.request} />
          <RequestCard request={state.request} />
          {state.request.status === 'pending' ? (
            <ActionFooter
              onApprove={() => setDialog({ action: 'approve', adminNote: '', typedEmail: '' })}
              onReject={() => setDialog({ action: 'reject', adminNote: '', typedEmail: '' })}
            />
          ) : (
            <ProcessedNotice request={state.request} />
          )}
        </>
      )}

      {dialog && state.kind === 'ready' && state.request.user && (
        <ConfirmDialog
          state={dialog}
          submitting={submitting}
          targetEmail={state.request.user.email}
          onChange={(next) => setDialog({ ...dialog, ...next })}
          onCancel={() => (submitting ? null : setDialog(null))}
          onConfirm={handleProcess}
        />
      )}
    </div>
  );
}

function DetailHeader({ request }: { request: AdminDeletionRequest }) {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Account deletion request</h1>
      <p className="text-sm text-muted-foreground">
        Reference <span className="font-mono text-foreground">{request.requestId}</span>
      </p>
    </div>
  );
}

function UserCard({ request }: { request: AdminDeletionRequest }) {
  return (
    <section className="space-y-2 rounded-lg border bg-card p-6 text-sm shadow-sm">
      <h2 className="text-base font-semibold">Requesting user</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>Name</dt>
        <dd className="text-foreground">{request.user?.name ?? '—'}</dd>
        <dt>Email</dt>
        <dd className="text-foreground">{request.user?.email ?? '—'}</dd>
        <dt>Joined</dt>
        <dd className="text-foreground">
          {request.user?.joinedAt ? formatAbsolute(request.user.joinedAt) : '—'}
        </dd>
        <dt>User ID</dt>
        <dd className="font-mono text-xs text-foreground">{request.user?.id ?? '—'}</dd>
      </dl>
    </section>
  );
}

function RequestCard({ request }: { request: AdminDeletionRequest }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-6 text-sm shadow-sm">
      <h2 className="text-base font-semibold">Request details</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>Status</dt>
        <dd className="text-foreground capitalize">{request.status}</dd>
        <dt>Requested</dt>
        <dd className="text-foreground" title={formatAbsolute(request.requestedAt)}>
          {formatRelative(request.requestedAt)}
        </dd>
        <dt>Process by</dt>
        <dd className="text-foreground" title={formatAbsolute(request.processBy)}>
          {formatRelative(request.processBy)}
        </dd>
        {request.processedAt && (
          <>
            <dt>Processed</dt>
            <dd className="text-foreground" title={formatAbsolute(request.processedAt)}>
              {formatRelative(request.processedAt)}
            </dd>
          </>
        )}
      </dl>
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Reason from user
        </div>
        <div className="rounded-md border bg-muted/40 p-3 text-foreground">
          {request.reason ? request.reason : <span className="italic text-muted-foreground">No reason given</span>}
        </div>
      </div>
      {request.adminNote && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Admin note
          </div>
          <div className="rounded-md border bg-muted/40 p-3 text-foreground">{request.adminNote}</div>
        </div>
      )}
    </section>
  );
}

function ActionFooter({ onApprove, onReject }: { onApprove: () => void; onReject: () => void }) {
  return (
    <section className="flex flex-col-reverse gap-2 rounded-lg border bg-card p-6 shadow-sm sm:flex-row sm:justify-end">
      <button
        type="button"
        onClick={onReject}
        className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
      >
        Reject
      </button>
      <button
        type="button"
        onClick={onApprove}
        className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90"
      >
        Approve and queue for processing
      </button>
    </section>
  );
}

function ProcessedNotice({ request }: { request: AdminDeletionRequest }) {
  const label = request.status === 'processing'
    ? 'Approved and queued for processing.'
    : request.status === 'cancelled'
      ? 'Rejected. User has been notified.'
      : 'Completed.';
  return (
    <section className="flex items-start gap-3 rounded-lg border bg-card p-6 shadow-sm">
      <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-primary" aria-hidden />
      <div>
        <p className="font-medium">{label}</p>
        {request.processedAt && (
          <p className="text-sm text-muted-foreground">
            Processed {formatRelative(request.processedAt)}.
          </p>
        )}
      </div>
    </section>
  );
}

function ConfirmDialog({
  state,
  submitting,
  targetEmail,
  onChange,
  onCancel,
  onConfirm,
}: {
  state: ConfirmDialogState;
  submitting: boolean;
  targetEmail: string;
  onChange: (patch: Partial<ConfirmDialogState>) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const emailMatches = useMemo(
    () => state.typedEmail.trim() === targetEmail,
    [state.typedEmail, targetEmail]
  );
  const noteValid = state.action === 'approve' || state.adminNote.trim().length > 0;
  const canConfirm = emailMatches && noteValid && !submitting;

  const isApprove = state.action === 'approve';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full ${isApprove ? 'bg-destructive/10' : 'bg-amber-500/10'}`}>
              <AlertTriangle className={`h-5 w-5 ${isApprove ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`} aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">
              {isApprove ? 'Approve deletion?' : 'Reject deletion?'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          {isApprove ? (
            <p className="text-muted-foreground">
              Approving queues this account for deletion. The actual deletion runs out-of-band; you
              can't undo this from the UI once it picks the request up.
            </p>
          ) : (
            <p className="text-muted-foreground">
              Rejecting cancels the request. The user will be emailed your note explaining why
              their request was declined.
            </p>
          )}

          <label htmlFor="confirm-email" className="block text-sm font-medium">
            Type the user's email to confirm
          </label>
          <input
            id="confirm-email"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={state.typedEmail}
            onChange={(e) => onChange({ typedEmail: e.target.value })}
            placeholder={targetEmail}
            className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />

          <label htmlFor="admin-note" className="block text-sm font-medium">
            Note {!isApprove && <span className="text-destructive">*</span>}
            {isApprove && <span className="text-muted-foreground"> (optional)</span>}
          </label>
          <textarea
            id="admin-note"
            rows={3}
            value={state.adminNote}
            onChange={(e) => onChange({ adminNote: e.target.value })}
            maxLength={2000}
            placeholder={isApprove
              ? 'Optional internal context for the audit log…'
              : 'Why are you declining? This is emailed to the user.'}
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            required={!isApprove}
          />
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
              isApprove
                ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                : 'border'
            }`}
          >
            {submitting ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {isApprove ? 'Approving…' : 'Rejecting…'}
              </>
            ) : (
              isApprove ? 'Approve' : 'Reject'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
