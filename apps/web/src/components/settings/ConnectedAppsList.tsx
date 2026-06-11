import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';

interface ConnectedApp {
  client_id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; apps: ConnectedApp[] };

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Never';
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? '—' : d.toLocaleString();
}

export default function ConnectedAppsList() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const res = await fetchWithAuth('/settings/connected-apps');
      if (res.status === 401) {
        window.location.href = '/login?next=/settings/connected-apps';
        setStatus({ kind: 'unauthenticated' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus({ kind: 'error', message: body?.message ?? `Request failed (${res.status})` });
        return;
      }
      const body = (await res.json()) as { clients: ConnectedApp[] };
      setStatus({ kind: 'ready', apps: body.clients ?? [] });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (app: ConnectedApp) => {
    if (!window.confirm(`Revoke access for ${app.client_name}? Their access token will stop working within 10 minutes.`)) return;
    setRevoking(app.client_id);
    try {
      const res = await fetchWithAuth(`/settings/connected-apps/${encodeURIComponent(app.client_id)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        setStatus({ kind: 'error', message: body?.message ?? `Revoke failed (${res.status})` });
        return;
      }
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Network error during revoke' });
    } finally {
      setRevoking(null);
    }
  };

  if (status.kind === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading connected apps…</p>;
  }

  if (status.kind === 'unauthenticated') {
    return <p className="text-sm text-muted-foreground">Redirecting to sign in…</p>;
  }

  if (status.kind === 'error') {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {status.message}
      </div>
    );
  }

  if (status.apps.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center">
        <p className="text-sm font-medium">No connected apps yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          When someone authorizes an MCP client (Claude.ai, ChatGPT, Cursor, …) against your tenant,
          it will appear here so you can revoke access at any time.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">App</th>
            <th className="px-4 py-2.5 font-medium">Registered</th>
            <th className="px-4 py-2.5 font-medium">Last used</th>
            <th className="px-4 py-2.5 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {status.apps.map((app) => {
            const isBusy = revoking === app.client_id;
            return (
              <tr key={app.client_id}>
                <td className="px-4 py-3">
                  <div className="font-medium">{app.client_name}</div>
                  <div className="text-xs text-muted-foreground">{app.client_id}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatDate(app.created_at)}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDate(app.last_used_at)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => revoke(app)}
                    disabled={isBusy}
                    className="inline-flex h-8 items-center justify-center rounded-md border border-red-200 bg-transparent px-3 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBusy ? 'Revoking…' : 'Revoke'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
