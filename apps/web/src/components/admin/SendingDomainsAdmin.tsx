import { useCallback, useEffect, useState } from 'react';
import { MailWarning } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';

/**
 * Platform-admin view of every partner sending domain (spec §9.3), with the
 * 7-day deliverability the admin list gained in W06 and the three kill-switch
 * actions. Unlisted, like /admin/trust-queue: it is reached by URL.
 *
 * Every mutation goes through runAction so a failure is always surfaced; the
 * unauthorized state is explicit rather than an empty table, because "no rows"
 * and "you are not a platform admin" must not look the same.
 */

type SendingDomainMetrics = {
  windowDays: number;
  messages: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  bounceRate: number;
};

type AdminSendingDomain = {
  id: string;
  partnerId: string;
  partnerName: string;
  domain: string;
  provider: string;
  status: string;
  statusReason: string | null;
  providerManaged: boolean;
  verifiedAt: string | null;
  createdAt: string;
  lastSendError: string | null;
  lastSendErrorAt: string | null;
  metrics: SendingDomainMetrics;
};

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'error';
type AdminAction = 'suspend' | 'unsuspend' | 'force-release';

const ACTION_LABEL: Record<AdminAction, string> = {
  suspend: 'Suspend',
  unsuspend: 'Unsuspend',
  'force-release': 'Force release',
};

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export default function SendingDomainsAdmin() {
  const [rows, setRows] = useState<AdminSendingDomain[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [actingOn, setActingOn] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const response = await fetchWithAuth('/admin/sending-domains?limit=200');
      if (response.status === 401 || response.status === 403) {
        setLoadState('unauthorized');
        return;
      }
      if (!response.ok) {
        setLoadState('error');
        return;
      }
      const body = await response.json() as { data: AdminSendingDomain[] };
      setRows(body.data ?? []);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (row: AdminSendingDomain, action: AdminAction) => {
    if (action === 'force-release') {
      // Irreversible: it drops Breeze's claim on the name and deletes the local
      // row. Nothing else on this page needs a confirmation.
      if (!window.confirm(
        `Force-release ${row.domain}? This drops Breeze's claim on the name and removes the row for ${row.partnerName}. It cannot be undone.`,
      )) return;
    }

    setActingOn(row.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/sending-domains/${encodeURIComponent(row.id)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
        errorFallback: `Unable to ${ACTION_LABEL[action].toLowerCase()} ${row.domain}`,
        successMessage: `${ACTION_LABEL[action]}d ${row.domain}`,
      });

      if (action === 'force-release') {
        setRows((current) => current.filter((candidate) => candidate.id !== row.id));
      } else {
        setRows((current) => current.map((candidate) => candidate.id === row.id
          ? {
              ...candidate,
              status: action === 'suspend' ? 'suspended' : 'pending',
              statusReason: action === 'suspend' ? 'platform_suspended' : null,
            }
          : candidate));
      }
    } catch (error) {
      if (error instanceof ActionError && (error.status === 401 || error.status === 403)) {
        setLoadState('unauthorized');
      } else {
        handleActionError(error, `Unable to ${ACTION_LABEL[action].toLowerCase()} ${row.domain}`);
      }
    } finally {
      setActingOn(null);
    }
  };

  if (loadState === 'loading') {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading sending domains…</p>;
  }
  if (loadState === 'unauthorized') {
    return (
      <p className="rounded-lg border bg-card p-6" data-testid="sending-domains-admin-requires-platform-admin">
        Sign in as a platform admin
      </p>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="rounded-lg border bg-card p-6" data-testid="sending-domains-admin-error">
        <p className="text-sm">Could not load sending domains.</p>
        <button
          type="button"
          className="mt-3 rounded-md border px-3 py-1.5 text-sm"
          data-testid="sending-domains-admin-retry"
          onClick={() => { void load(); }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="sending-domains-admin">
      <div className="flex items-center gap-2">
        <MailWarning className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-2xl font-semibold tracking-tight">Partner sending domains</h1>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center" data-testid="sending-domains-admin-empty">
          <p className="text-sm text-muted-foreground">No partner has added a sending domain yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Partner</th>
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">7-day messages</th>
                <th className="px-3 py-2">Bounce rate</th>
                <th className="px-3 py-2">Complaints</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id} className="border-t" data-testid={`sending-domains-admin-row-${row.id}`}>
                  <td className="px-3 py-2">{row.partnerName}</td>
                  <td className="px-3 py-2 font-medium">{row.domain}</td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-status-${row.id}`}>
                    {row.status}{row.statusReason ? ` (${row.statusReason})` : ''}
                  </td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-messages-${row.id}`}>
                    {formatCount(row.metrics.messages)}
                  </td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-bounce-rate-${row.id}`}>
                    {formatRate(row.metrics.bounceRate)}
                  </td>
                  <td className="px-3 py-2" data-testid={`sending-domains-admin-complaints-${row.id}`}>
                    {formatCount(row.metrics.complained)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs"
                        disabled={actingOn === row.id || row.status === 'suspended'}
                        data-testid={`sending-domains-admin-suspend-${row.id}`}
                        onClick={() => { void act(row, 'suspend'); }}
                      >
                        Suspend
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs"
                        disabled={actingOn === row.id || row.status !== 'suspended'}
                        data-testid={`sending-domains-admin-unsuspend-${row.id}`}
                        onClick={() => { void act(row, 'unsuspend'); }}
                      >
                        Unsuspend
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs text-destructive"
                        disabled={actingOn === row.id}
                        data-testid={`sending-domains-admin-force-release-${row.id}`}
                        onClick={() => { void act(row, 'force-release'); }}
                      >
                        Force release
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
