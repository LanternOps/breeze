import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plug, Loader2, ShieldAlert, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import type { McpConnectionToolListMode, McpToolListMode } from '@breeze/shared';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import McpToolListModeField, { type McpToolListModeFieldValue } from '../shared/McpToolListModeField';
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
  /** #12429: absent from an older API. */
  toolListMode?: McpConnectionToolListMode;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; clients: OauthClient[]; mcpToolListDefault: McpToolListMode };

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

  // `background` keeps the rows on screen: another row may hold an unsaved
  // choice, and a failed refresh must not replace the page after a good save.
  const load = useCallback(async (opts: { background?: boolean } = {}) => {
    if (!opts.background) setState({ kind: 'loading' });
    const fail = (message: string) => {
      if (opts.background) showToast({ type: 'error', message });
      else setState({ kind: 'error', message });
    };
    try {
      const res = await fetchWithAuth('/me/oauth-clients');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        fail(body.error ?? `Request failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { clients: OauthClient[]; mcpToolListDefault?: McpToolListMode };
      setState({ kind: 'ready', clients: body.clients ?? [], mcpToolListDefault: body.mcpToolListDefault ?? 'full' });
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Network error');
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
                  {active && client.toolListMode && client.toolListMode.kind !== 'none' && (
                    <ConnectionToolListMode
                      // A changed stored value starts this row's draft over.
                      key={client.toolListMode.kind === 'uniform' ? `uniform:${client.toolListMode.stored}` : 'mixed'}
                      clientId={client.clientId}
                      mode={client.toolListMode}
                      deploymentDefault={state.mcpToolListDefault}
                      onSaved={() => load({ background: true })}
                    />
                  )}
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

/**
 * One control per app, as the list is one row per app: it writes every active
 * connection the signed-in user has to it, across all partners, and says so.
 */
function ConnectionToolListMode({
  clientId,
  mode,
  deploymentDefault,
  onSaved,
}: {
  clientId: string;
  mode: Exclude<McpConnectionToolListMode, { kind: 'none' }>;
  deploymentDefault: McpToolListMode;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation('common');
  const stored: McpToolListModeFieldValue = mode.kind === 'mixed' ? 'mixed' : mode.stored;
  const [draft, setDraft] = useState<McpToolListModeFieldValue>(stored);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (draft === 'mixed') return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/me/oauth-clients/${encodeURIComponent(clientId)}/mcp-tool-list-mode`, {
            method: 'PATCH',
            body: JSON.stringify({ mcp_tool_list_mode: draft }),
          }),
        successMessage: t('longTail.mcpToolListMode.saved'),
        errorFallback: t('longTail.mcpToolListMode.saveFailed'),
        onUnauthorized: handleSessionExpired,
      });
      await onSaved();
    } catch (err) {
      handleActionError(err, t('longTail.mcpToolListMode.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid={`connection-tool-list-${clientId}`} className="mt-4 max-w-md space-y-2">
      <McpToolListModeField
        idPrefix={`connection-${clientId}`}
        variant="connection"
        value={draft}
        effective={mode.kind === 'uniform' && draft === mode.stored ? mode.effective : null}
        deploymentDefault={deploymentDefault}
        onChange={setDraft}
        disabled={saving}
      />
      {mode.kind === 'mixed' && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('longTail.mcpToolListMode.mixedHelp')}</p>
      )}
      <p className="text-xs text-muted-foreground">{t('longTail.mcpToolListMode.allConnections')}</p>
      <button
        type="button"
        data-testid="connection-tool-list-save"
        onClick={save}
        disabled={saving || draft === stored}
        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? t('longTail.mcpToolListMode.saving') : t('longTail.mcpToolListMode.save')}
      </button>
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
