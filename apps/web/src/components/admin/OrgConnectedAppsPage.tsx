import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plug, Loader2, ShieldAlert, AlertTriangle, X, RefreshCw, Ban, Undo2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { formatAbsolute, formatRelative } from '../account/relativeTime';

interface OrgClient {
  clientId: string;
  displayName: string;
  activeUserCount: number;
  totalUserCount: number;
  clientCreatedAt: string;
  lastUsedAt: string | null;
  block: {
    blockedAt: string;
    blockedUntil: string | null;
    blockedReason: string | null;
  } | null;
}

type LoadState =
  | { kind: 'no-org' }
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; clients: OrgClient[] };

interface BlockDialogState {
  client: OrgClient;
  reason: string;
}

interface UnblockDialogState {
  client: OrgClient;
}

export default function OrgConnectedAppsPage() {
  const orgId = useOrgStore((s) => s.currentOrgId);
  const orgs = useOrgStore((s) => s.organizations);
  const orgName = useMemo(
    () => orgs.find((o) => o.id === orgId)?.name ?? null,
    [orgs, orgId]
  );

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [blockDialog, setBlockDialog] = useState<BlockDialogState | null>(null);
  const [unblockDialog, setUnblockDialog] = useState<UnblockDialogState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) {
      setState({ kind: 'no-org' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const res = await fetchWithAuth(`/admin/orgs/${encodeURIComponent(orgId)}/oauth-clients`);
      if (res.status === 403) {
        setState({ kind: 'unauthorized' });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: body.error ?? `Request failed (${res.status})` });
        return;
      }
      const body = (await res.json()) as { clients: OrgClient[] };
      setState({ kind: 'ready', clients: body.clients ?? [] });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBlock = async () => {
    if (!blockDialog || !orgId) return;
    if (blockDialog.reason.trim().length === 0) {
      showToast({ type: 'error', message: 'Reason is required.' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithAuth(
        `/admin/orgs/${encodeURIComponent(orgId)}/oauth-clients/${encodeURIComponent(blockDialog.client.clientId)}/block-globally`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: blockDialog.reason.trim() }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast({ type: 'error', message: body.error ?? `Block failed (${res.status})` });
        return;
      }
      showToast({
        type: 'success',
        message: `${blockDialog.client.displayName} blocked for the organization. Users will sign out within their token TTL (≤15 min).`,
      });
      setBlockDialog(null);
      await load();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnblock = async () => {
    if (!unblockDialog || !orgId) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth(
        `/admin/orgs/${encodeURIComponent(orgId)}/oauth-clients/${encodeURIComponent(unblockDialog.client.clientId)}/unblock-globally`,
        { method: 'POST' }
      );
      if (res.status !== 204 && !res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast({ type: 'error', message: body.error ?? `Unblock failed (${res.status})` });
        return;
      }
      showToast({
        type: 'success',
        message: `${unblockDialog.client.displayName} unblocked. Users must re-authorize before tokens are issued again.`,
      });
      setUnblockDialog(null);
      await load();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Connected apps (org-wide)</h1>
          <p className="text-sm text-muted-foreground">
            AI assistants and other MCP clients that users in
            {orgName ? <> <span className="font-medium text-foreground">{orgName}</span></> : ' your organization'}
            {' '}have authorized. Block any client to immediately revoke every active grant.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={state.kind === 'loading'}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${state.kind === 'loading' ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {state.kind === 'no-org' && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          Pick an organization from the org switcher to view its connected apps.
        </div>
      )}

      {state.kind === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      )}

      {state.kind === 'unauthorized' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive">Not allowed</h2>
          <p className="mt-1 text-sm text-destructive">
            You don't have the <code>users:write</code> permission required to manage org-wide
            connected app blocks.
          </p>
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
              Try again
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && state.clients.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <Plug className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
          <h2 className="mt-4 text-base font-semibold">No authorized clients yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When a user in this org authorizes an MCP client, it'll show up here.
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.clients.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">App</th>
                <th className="px-4 py-3">Active users</th>
                <th className="px-4 py-3">Last used</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {state.clients.map((client) => {
                const blocked = !!client.block;
                return (
                  <tr key={client.clientId}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium">
                        <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
                        {client.displayName}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{client.clientId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{client.activeUserCount}</span>
                      {client.totalUserCount > client.activeUserCount && (
                        <span className="text-xs text-muted-foreground">
                          {' '}
                          / {client.totalUserCount} ever
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" title={formatAbsolute(client.lastUsedAt)}>
                      {formatRelative(client.lastUsedAt)}
                    </td>
                    <td className="px-4 py-3">
                      {blocked ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                          title={
                            client.block?.blockedReason
                              ? `Reason: ${client.block.blockedReason}`
                              : undefined
                          }
                        >
                          <Ban className="h-3 w-3" aria-hidden /> Blocked
                          {client.block?.blockedUntil && (
                            <> · until {formatRelative(client.block.blockedUntil)}</>
                          )}
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                          Allowed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {blocked ? (
                        <button
                          type="button"
                          onClick={() => setUnblockDialog({ client })}
                          className="inline-flex h-9 items-center gap-1 rounded-md border border-emerald-500/40 px-3 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/10 dark:text-emerald-400"
                        >
                          <Undo2 className="h-3.5 w-3.5" /> Unblock
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setBlockDialog({ client, reason: '' })}
                          className="inline-flex h-9 items-center gap-1 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
                        >
                          <Ban className="h-3.5 w-3.5" /> Block org-wide
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {blockDialog && (
        <BlockOrgWideDialog
          state={blockDialog}
          submitting={submitting}
          orgLabel={orgName ?? 'this organization'}
          onChange={(reason) => setBlockDialog({ ...blockDialog, reason })}
          onCancel={() => (submitting ? null : setBlockDialog(null))}
          onConfirm={handleBlock}
        />
      )}

      {unblockDialog && (
        <UnblockDialog
          state={unblockDialog}
          submitting={submitting}
          onCancel={() => (submitting ? null : setUnblockDialog(null))}
          onConfirm={handleUnblock}
        />
      )}
    </div>
  );
}

function BlockOrgWideDialog({
  state,
  submitting,
  orgLabel,
  onChange,
  onCancel,
  onConfirm,
}: {
  state: BlockDialogState;
  submitting: boolean;
  orgLabel: string;
  onChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const reasonValid = state.reason.trim().length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">Block {state.client.displayName}?</h2>
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
          <p className="text-muted-foreground">
            This blocks <span className="font-medium text-foreground">{state.client.displayName}</span>{' '}
            for every user in <span className="font-medium text-foreground">{orgLabel}</span>. All
            active grants and refresh tokens are revoked immediately. Users will see a sign-out
            within their access-token TTL (~15 min). They cannot re-authorize until you unblock.
          </p>
          {state.client.activeUserCount > 0 && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              <p>
                <strong>{state.client.activeUserCount}</strong>{' '}
                user{state.client.activeUserCount === 1 ? '' : 's'} currently authorized — they'll
                lose access in this app.
              </p>
            </div>
          )}
          <label htmlFor="org-block-reason" className="block text-sm font-medium">
            Reason <span className="text-destructive">*</span>
          </label>
          <textarea
            id="org-block-reason"
            rows={3}
            value={state.reason}
            onChange={(e) => onChange(e.target.value)}
            maxLength={500}
            placeholder="Vendor risk review, suspected compromise, policy change…"
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            required
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
            disabled={submitting || !reasonValid}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Blocking…
              </>
            ) : (
              'Block org-wide'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function UnblockDialog({
  state,
  submitting,
  onCancel,
  onConfirm,
}: {
  state: UnblockDialogState;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10">
              <Undo2 className="h-5 w-5 text-emerald-700 dark:text-emerald-400" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">Unblock {state.client.displayName}?</h2>
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

        <p className="mt-4 text-sm text-muted-foreground">
          Users in this organization will be able to authorize{' '}
          <span className="font-medium text-foreground">{state.client.displayName}</span> again.
          Existing grants stay revoked — every user must sign in fresh through the OAuth flow.
        </p>

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
            disabled={submitting}
            className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Unblocking…
              </>
            ) : (
              'Unblock'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
