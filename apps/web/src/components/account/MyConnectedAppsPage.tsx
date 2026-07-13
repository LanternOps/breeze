import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plug, Loader2, ShieldAlert, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import AccountSubNav from './AccountSubNav';
import { formatAbsolute, formatRelative } from './relativeTime';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

interface OauthClient {
  clientId: string;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastApprovalDecidedAt: string | null;
  revokedAt: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; clients: OauthClient[] };

interface ConfirmState {
  client: OauthClient;
  reason: string;
  isOnly: boolean;
}

export default function MyConnectedAppsPage() {
  const { t } = useTranslation('common');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetchWithAuth('/me/oauth-clients');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: body.error ?? `Request failed (${res.status})` });
        return;
      }
      const body = (await res.json()) as { clients: OauthClient[] };
      setState({ kind: 'ready', clients: body.clients ?? [] });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeClients = useMemo(
    () => (state.kind === 'ready' ? state.clients.filter((c) => !c.revokedAt) : []),
    [state]
  );

  const handleRevokeClick = (client: OauthClient) => {
    if (client.revokedAt) return;
    setConfirm({
      client,
      reason: '',
      isOnly: activeClients.length <= 1,
    });
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    setRevoking(true);
    try {
      const res = await fetchWithAuth(
        `/me/oauth-clients/${encodeURIComponent(confirm.client.clientId)}/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            reason: confirm.reason.trim().length > 0 ? confirm.reason.trim() : undefined,
          }),
        }
      );
      if (res.status !== 204 && !res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast({ type: 'error', message: body.error ?? `Revoke failed (${res.status})` });
        return;
      }
      showToast({
        type: 'success',
        message: t('account.apps.revokedToast', { app: confirm.client.displayName }),
      });
      setConfirm(null);
      await load();
    } catch (err) {
      showToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('account.errors.revokeNetwork'),
      });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <a
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('account.returnDashboard')}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">{t('account.apps.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('account.apps.description')}
        </p>
      </header>

      <AccountSubNav current="connected-apps" />

      {state.kind === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <div className="flex-1 space-y-2">
            <p>{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              {t('actions.retry')}
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && state.clients.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <Plug className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
          <h2 className="mt-4 text-base font-semibold">{t('account.apps.empty')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('account.apps.emptyDescription')}
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.clients.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <ul className="divide-y">
            {state.clients.map((client) => {
              const active = !client.revokedAt;
              return (
                <li key={client.clientId} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
                        <span className="font-medium">{client.displayName}</span>
                        {active ? (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            {t('states.active')}
                          </span>
                        ) : (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {t('account.revoked')}
                          </span>
                        )}
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <dt>{t('account.apps.authorized')}</dt>
                        <dd title={formatAbsolute(client.createdAt)}>
                          {formatRelative(client.createdAt)}
                        </dd>
                        <dt>{t('account.apps.lastUsed')}</dt>
                        <dd title={formatAbsolute(client.lastUsedAt)}>
                          {formatRelative(client.lastUsedAt)}
                        </dd>
                        {client.lastApprovalDecidedAt && (
                          <>
                            <dt>{t('account.apps.lastDecision')}</dt>
                            <dd title={formatAbsolute(client.lastApprovalDecidedAt)}>
                              {formatRelative(client.lastApprovalDecidedAt)}
                            </dd>
                          </>
                        )}
                        {!active && (
                          <>
                            <dt>{t('account.revoked')}</dt>
                            <dd title={formatAbsolute(client.revokedAt)}>
                              {formatRelative(client.revokedAt)}
                            </dd>
                          </>
                        )}
                      </dl>
                    </div>
                    {active && (
                      <button
                        type="button"
                        onClick={() => handleRevokeClick(client)}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
                      >
                        {t('account.revoke')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {confirm && (
        <RevokeAppDialog
          state={confirm}
          revoking={revoking}
          onChange={(reason) => setConfirm({ ...confirm, reason })}
          onCancel={() => (revoking ? null : setConfirm(null))}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}

function RevokeAppDialog({
  state,
  revoking,
  onChange,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState;
  revoking: boolean;
  onChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">{t('account.apps.revokeTitle', { app: state.client.displayName })}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label={t('actions.close')}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            {t('account.apps.revokeDescription')}
          </p>
          {state.isOnly && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              <p>
                <strong>{t('account.apps.onlyAppTitle')}</strong> {t('account.apps.onlyAppDescription')}
              </p>
            </div>
          )}
          <label htmlFor="revoke-app-reason" className="block text-sm font-medium">
            {t('account.reason')}
          </label>
          <textarea
            id="revoke-app-reason"
            rows={2}
            value={state.reason}
            onChange={(e) => onChange(e.target.value)}
            maxLength={500}
            placeholder={t('account.apps.reasonPlaceholder')}
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={revoking}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {revoking ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t('account.revoking')}
              </>
            ) : (
              t('account.apps.revokeAction')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
