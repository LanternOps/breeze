import { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';

interface PendingRequest {
  requestId: string;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  requestedAt: string;
  processBy: string;
  reason: string | null;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; request: PendingRequest };

const REQUIRED_CONFIRMATION = 'DELETE';

function formatDate(input: string): string {
  try {
    return new Date(input).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return input;
  }
}

export default function AccountDeletionPage() {
  const user = useAuthStore((s) => s.user);

  const [loadingExisting, setLoadingExisting] = useState(true);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });

  const passwordId = useId();
  const confirmId = useId();
  const reasonId = useId();
  const formErrId = useId();

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/auth/account-deletion-request')
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 401) {
            // Auth expired — AuthOverlay will handle the redirect.
            return;
          }
          setPendingError('Unable to load your account status. Please refresh.');
          return;
        }
        const data = (await res.json()) as { pending: PendingRequest | null };
        setPending(data.pending);
      })
      .catch(() => {
        if (cancelled) return;
        setPendingError('Unable to load your account status. Please refresh.');
      })
      .finally(() => {
        if (!cancelled) setLoadingExisting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = useMemo(() => {
    if (submitState.kind === 'submitting') return false;
    if (password.trim().length === 0) return false;
    if (confirmation.trim().toUpperCase() !== REQUIRED_CONFIRMATION) return false;
    return true;
  }, [submitState, password, confirmation]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitState({ kind: 'submitting' });
    try {
      const res = await fetchWithAuth('/auth/account-deletion-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password,
          reason: reason.trim().length > 0 ? reason.trim() : undefined,
        }),
      });

      if (!res.ok) {
        let message = 'We could not submit your request. Please try again.';
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // Non-JSON body — keep generic message.
        }
        setSubmitState({ kind: 'error', message });
        return;
      }

      const data = (await res.json()) as PendingRequest;
      setSubmitState({ kind: 'success', request: data });
      setPending(data);
      // Wipe sensitive form state immediately.
      setPassword('');
      setConfirmation('');
      setReason('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error. Please try again.';
      setSubmitState({ kind: 'error', message });
    }
  }

  async function handleCancel(requestId: string) {
    setCancellingId(requestId);
    setPendingError(null);
    try {
      const res = await fetchWithAuth(`/auth/account-deletion-request/${requestId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (!res.ok) {
        let message = 'We could not cancel your request. Please try again.';
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // Ignore.
        }
        setPendingError(message);
        return;
      }
      setPending(null);
      setSubmitState({ kind: 'idle' });
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setCancellingId(null);
    }
  }

  if (loadingExisting) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-12">
      <div className="space-y-2">
        <a
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to settings
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Delete your account</h1>
        <p className="text-sm text-muted-foreground">
          Submitting a deletion request notifies an administrator on your organization. Your account
          will be processed and removed within 30 days. You can cancel any time before then.
        </p>
      </div>

      {submitState.kind === 'success' || pending ? (
        <PendingState
          request={(submitState.kind === 'success' ? submitState.request : pending) as PendingRequest}
          onCancel={handleCancel}
          cancelling={cancellingId !== null}
          error={pendingError}
        />
      ) : (
        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
          aria-describedby={submitState.kind === 'error' ? formErrId : undefined}
        >
          <section className="space-y-2 rounded-md border bg-muted/40 p-4 text-sm">
            <p className="font-medium text-foreground">Signed in as</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Name</dt>
              <dd className="text-foreground">{user?.name ?? '—'}</dd>
              <dt>Email</dt>
              <dd className="text-foreground">{user?.email ?? '—'}</dd>
            </dl>
          </section>

          <div
            role="note"
            className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-foreground"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-destructive" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium text-destructive">This is a request, not an immediate deletion.</p>
              <p className="text-muted-foreground">
                Once submitted, an admin from your organization is notified by email. Your account
                will be processed within 30 days. You can sign in and cancel any time before then.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor={passwordId} className="text-sm font-medium">
              Confirm your password
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor={confirmId} className="text-sm font-medium">
              Type <span className="font-mono text-destructive">DELETE</span> to confirm
            </label>
            <input
              id={confirmId}
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor={reasonId} className="text-sm font-medium">
              Reason (optional)
            </label>
            <textarea
              id={reasonId}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              placeholder="Help us improve — what made you decide to leave?"
              className="w-full rounded-md border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {submitState.kind === 'error' && (
            <div
              id={formErrId}
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              <span>{submitState.message}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <a
              href="/settings"
              className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </a>
            <button
              type="submit"
              disabled={!canSubmit}
              aria-busy={submitState.kind === 'submitting' || undefined}
              className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitState.kind === 'submitting' ? 'Submitting…' : 'Request account deletion'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PendingState({
  request,
  onCancel,
  cancelling,
  error,
}: {
  request: PendingRequest;
  onCancel: (requestId: string) => void;
  cancelling: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex gap-3">
        <CheckCircle2 className="h-6 w-6 flex-none text-primary" aria-hidden />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Deletion request received</h2>
          <p className="text-sm text-muted-foreground">
            We've notified an administrator on your organization. Your account will be processed by{' '}
            <strong className="text-foreground">{formatDate(request.processBy)}</strong>.
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-muted/40 p-4 text-sm">
        <dt className="text-muted-foreground">Reference</dt>
        <dd className="font-mono text-foreground">{request.requestId}</dd>
        <dt className="text-muted-foreground">Submitted</dt>
        <dd className="text-foreground">{formatDate(request.requestedAt)}</dd>
        <dt className="text-muted-foreground">Processes by</dt>
        <dd className="text-foreground">{formatDate(request.processBy)}</dd>
      </dl>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <a
          href="/"
          className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          Return to dashboard
        </a>
        <button
          type="button"
          onClick={() => onCancel(request.requestId)}
          disabled={cancelling}
          className="inline-flex h-10 items-center justify-center rounded-md border border-destructive/40 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {cancelling ? 'Cancelling…' : 'Cancel deletion request'}
        </button>
      </div>
    </div>
  );
}
