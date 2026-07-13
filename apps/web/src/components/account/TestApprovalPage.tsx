import { useState } from 'react';
import { ArrowLeft, BellRing, CheckCircle2, Loader2, ShieldAlert, Smartphone } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useTranslation } from 'react-i18next';

interface TriggerResponse {
  approvalId: string;
  expiresAt: string;
  pushSentToDeviceCount: number;
  registeredDeviceCount: number;
  // Count of tokens that failed to dispatch across all push providers.
  errors: number;
}

type TriggerState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; response: TriggerResponse }
  | { kind: 'no-devices'; response: TriggerResponse }
  | { kind: 'error'; message: string };

export default function TestApprovalPage() {
  const { t } = useTranslation('common');
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
        let message = t('account.approval.errors.send');
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
      const message = err instanceof Error ? err.message : t('account.errors.network');
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
          {t('account.backToSettings')}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">{t('account.approval.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('account.approval.description')}
        </p>
      </div>

      <section className="space-y-2 rounded-md border bg-muted/40 p-4 text-sm">
        <p className="font-medium text-foreground">{t('account.signedInAs')}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>{t('labels.name')}</dt>
          <dd className="text-foreground">{user?.name ?? '—'}</dd>
          <dt>{t('account.email')}</dt>
          <dd className="text-foreground">{user?.email ?? '—'}</dd>
        </dl>
      </section>

      <div className="space-y-4 rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex gap-3">
          <BellRing className="h-6 w-6 flex-none text-primary" aria-hidden />
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{t('account.approval.sendTitle')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('account.approval.sendDescription')}
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
              {t('account.approval.sending')}
            </>
          ) : (
            <>
              <Smartphone className="h-4 w-4" aria-hidden />
              {t('account.approval.send')}
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
              <p className="font-medium">{t('account.approval.sent')}</p>
              <p className="text-xs text-muted-foreground">
                {t('account.approval.delivered', { sent: state.response.pushSentToDeviceCount, count: state.response.registeredDeviceCount })}
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
              {t('account.approval.noDevices')}
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
        {t('account.approval.tip')}
      </p>
    </div>
  );
}
