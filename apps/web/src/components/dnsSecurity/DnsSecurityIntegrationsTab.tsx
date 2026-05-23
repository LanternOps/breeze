import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, Trash2, Plus } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';

type Provider =
  | 'umbrella'
  | 'cloudflare'
  | 'dnsfilter'
  | 'pihole'
  | 'opendns'
  | 'quad9'
  | 'adguard_home';

const PROVIDER_LABELS: Record<Provider, string> = {
  umbrella: 'Cisco Umbrella',
  cloudflare: 'Cloudflare Gateway',
  dnsfilter: 'DNSFilter',
  pihole: 'Pi-hole',
  opendns: 'OpenDNS',
  quad9: 'Quad9',
  adguard_home: 'AdGuard Home',
};

type Integration = {
  id: string;
  orgId: string;
  provider: Provider;
  name: string;
  enabled: boolean;
  lastSync: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  totalEventsProcessed: number | null;
  createdAt: string;
};

export default function DnsSecurityIntegrationsTab() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchIntegrations = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/dns-security/integrations', { signal });
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(`Failed to load integrations (HTTP ${res.status})`);
      }
      const body = await res.json();
      setIntegrations((body.data ?? body.integrations ?? []) as Integration[]);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchIntegrations(controller.signal);
    return () => controller.abort();
  }, [fetchIntegrations]);

  const handleSync = async (integration: Integration) => {
    setBusyId(integration.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/dns-security/integrations/${integration.id}/sync`, {
          method: 'POST',
        }),
        errorFallback: `Failed to trigger sync for ${integration.name}`,
        successMessage: `Sync queued for ${integration.name}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      // Refresh to surface updated lastSync state once the worker runs.
      await fetchIntegrations();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // runAction already toasted; nothing inline to surface beyond that.
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (integration: Integration) => {
    if (!window.confirm(`Delete ${integration.name}? Stored events are retained per the retention policy.`)) {
      return;
    }
    setBusyId(integration.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/dns-security/integrations/${integration.id}`, {
          method: 'DELETE',
        }),
        errorFallback: `Failed to delete ${integration.name}`,
        successMessage: `Deleted ${integration.name}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await fetchIntegrations();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Configured integrations</h2>
        <button
          type="button"
          // Add-integration modal lands in a follow-up PR; the button is wired
          // up so the IA is visible but tells the operator where it's headed.
          onClick={() => alert('Add Integration modal lands in a follow-up PR. For now, POST /dns-security/integrations directly with the provider-specific config payload.')}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add integration
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading integrations…
        </div>
      ) : integrations.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <Plug className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No DNS integrations configured</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect one of the 7 supported providers to start ingesting DNS query logs.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Provider</th>
                <th className="px-4 py-2 text-left">Last sync</th>
                <th className="px-4 py-2 text-left">Events</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((it) => (
                <tr key={it.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2 font-medium">{it.name}</td>
                  <td className="px-4 py-2">{PROVIDER_LABELS[it.provider] ?? it.provider}</td>
                  <td className="px-4 py-2">
                    {it.lastSync ? (
                      <span className={it.lastSyncStatus === 'error' ? 'text-destructive' : ''}>
                        {new Date(it.lastSync).toLocaleString()}
                        {it.lastSyncStatus === 'error' && ' — failed'}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{it.totalEventsProcessed ?? 0}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleSync(it)}
                        disabled={busyId === it.id}
                        title="Sync now"
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <RefreshCw className={`h-4 w-4 ${busyId === it.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(it)}
                        disabled={busyId === it.id}
                        title="Delete integration"
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
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
