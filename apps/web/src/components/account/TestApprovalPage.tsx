import { useState } from 'react';
import { ArrowLeft, BellRing, CheckCircle2, Loader2, ShieldAlert, Smartphone } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';

interface TriggerResponse {
  approvalId: string;
  expiresAt: string;
  pushSentToDeviceCount: number;
  registeredDeviceCount: number;
  errors: string[];
}

type TriggerState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; response: TriggerResponse }
  | { kind: 'no-devices'; response: TriggerResponse }
  | { kind: 'error'; message: string };

export default function TestApprovalPage() {
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<TriggerState>({ kind: 'idle' });

  async function handleTrigger() {
    setState({ kind: 'sending' });
    try {
      const res = await fetchWithAuth('/auth/me/test-approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        let message = 'We could not send a test approval. Please try again.';
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // Non-JSON body — keep generic message.
        }
        setState({ kind: 'error', message });
        return;
      }

      const data = (await res.json()) as TriggerResponse;
      if (data.registeredDeviceCount === 0) {
        setState({ kind: 'no-devices', response: data });
        return;
      }
      setState({ kind: 'sent', response: data });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error. Please try again.';
      setState({ kind: 'error', message });
    }
  }

  const isSending = state.kind === 'sending';

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
        <h1 className="text-2xl font-semibold tracking-tight">Test the approval flow</h1>
        <p className="text-sm text-muted-foreground">
          Send a sandbox approval push to your own Breeze Mobile devices. Tapping the push will
          take over your phone with the approval screen for 60 seconds. Approving or denying does
          not run any real action — it's purely for testing.
        </p>
      </div>

      <section className="space-y-2 rounded-md border bg-muted/40 p-4 text-sm">
        <p className="font-medium text-foreground">Signed in as</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Name</dt>
          <dd className="text-foreground">{user?.name ?? '—'}</dd>
          <dt>Email</dt>
          <dd className="text-foreground">{user?.email ?? '—'}</dd>
        </dl>
      </section>

      <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex gap-3">
          <BellRing className="h-6 w-6 flex-none text-primary" aria-hidden />
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Send a test approval to your phone</h2>
            <p className="text-sm text-muted-foreground">
              We'll deliver a push within a few seconds. The approval expires automatically after
              60 seconds if you don't act on it.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleTrigger}
          disabled={isSending}
          aria-busy={isSending || undefined}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {isSending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Sending…
            </>
          ) : (
            <>
              <Smartphone className="h-4 w-4" aria-hidden />
              Send test approval to my phone
            </>
          )}
        </button>

        {state.kind === 'sent' && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">Sent. Check your phone within a few seconds.</p>
              <p className="text-xs text-muted-foreground">
                Push delivered to {state.response.pushSentToDeviceCount} of{' '}
                {state.response.registeredDeviceCount} registered device
                {state.response.registeredDeviceCount === 1 ? '' : 's'}. The approval expires in 60
                seconds.
              </p>
            </div>
          </div>
        )}

        {state.kind === 'no-devices' && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
            <p>
              We don't see a registered Breeze Mobile device on your account. Sign in to the app
              at least once, then try again.
            </p>
          </div>
        )}

        {state.kind === 'error' && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
            <span>{state.message}</span>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Tip: this page is safe to share with App Store reviewers. They can sign in with the
        provided test account, click the button, and verify the approval takeover end-to-end.
      </p>
    </div>
  );
}
