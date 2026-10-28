import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Plug, RefreshCw, Trash2, Plus, Clock } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import AddDnsIntegrationModal from './AddDnsIntegrationModal';
import EditDnsRetentionModal from './EditDnsRetentionModal';
import { formatDateTime } from '@/lib/dateTimeFormat';

type Provider =
  | 'umbrella'
  | 'cloudflare'
  | 'dnsfilter'
  | 'pihole'
  | 'opendns'
  | 'quad9'
  | 'adguard_home';

const PROVIDER_LABEL_KEYS: Record<Provider, string> = {
  umbrella: 'providers.umbrella',
  cloudflare: 'providers.cloudflare',
  dnsfilter: 'providers.dnsfilter',
  pihole: 'providers.pihole',
  opendns: 'providers.opendns',
  quad9: 'providers.quad9',
  adguard_home: 'providers.adguardHome',
};

type Integration = {
  id: string;
  orgId: string;
  provider: Provider;
  name: string;
  isActive?: boolean;
  config?: { retentionDays?: number } | null;
  lastSync: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  totalEventsProcessed: number | null;
  createdAt: string;
};

// #10019 — DELETE marks the row inactive + 'deleting' and answers 202; a
// background job removes its history and then the row itself.
const DELETING_STATUS = 'deleting';

function isDeleting(it: Integration): boolean {
  return it.isActive === false && it.lastSyncStatus === DELETING_STATUS;
}

// #10085 — while any row is deleting, the list is refetched so the row drops
// out once the background job removes it: 5 s, then doubling to a 30 s cap.
// The server has no terminal "delete failed" state (a failed job leaves the
// row marked and the nightly sweep re-queues it), so the poll ends when no row
// is deleting or on unmount. After MAX_POLL_FAILURES list requests in a row
// fail it pauses with the error banner up, and resumes on the next successful
// manual refresh (any action on the tab) or when the browser tab is shown
// again. It also sleeps while the browser tab is hidden.
const DELETE_POLL_INITIAL_MS = 5_000;
const DELETE_POLL_MAX_MS = 30_000;
const MAX_POLL_FAILURES = 3;

// 'stale': a newer list request was issued while this one was in flight, so
// its answer (or error) is dropped in favour of the newer one.
type FetchOutcome = 'ok' | 'failed' | 'stale' | 'aborted' | 'unauthorized';

export default function DnsSecurityIntegrationsTab() {
  const { t } = useTranslation('security');
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [retentionTarget, setRetentionTarget] = useState<Integration | null>(null);
  // Integrations this tab asked to delete, by id → name, so their removal by
  // the background job can be announced. Rows deleted elsewhere drop silently.
  const deletesStartedHere = useRef(new Map<string, string>());
  // Bumped by every successful non-poll fetch so a poll paused by failures
  // starts over (see the poll effect below).
  const [pollEpoch, setPollEpoch] = useState(0);
  // The poll and the post-action refetches overlap; only the newest request's
  // answer is applied, so an older list can never overwrite a newer one.
  const latestRequest = useRef(0);

  // `quiet` is the background poll: it keeps the table on screen (no spinner)
  // and leaves an existing error banner up until a request succeeds.
  const fetchIntegrations = useCallback(async (
    signal?: AbortSignal,
    { quiet = false }: { quiet?: boolean } = {},
  ): Promise<FetchOutcome> => {
    const requestId = ++latestRequest.current;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetchWithAuth('/dns-security/integrations', { signal });
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return 'unauthorized';
        }
        throw new Error(t('dnsSecurityDnsSecurityIntegrationsTab.messages.loadHttpError', { status: res.status }));
      }
      const body = await res.json();
      if (signal?.aborted) return 'aborted';
      if (requestId !== latestRequest.current) return 'stale';
      const payload: unknown = body?.data ?? body?.integrations;
      // A 200 without a list is a failure, not "no integrations": read as an
      // empty list it would announce every pending delete as finished.
      if (!Array.isArray(payload)) throw new Error(t('dnsSecurityDnsSecurityIntegrationsTab.messages.loadFailed'));
      const rows = payload as Integration[];
      setIntegrations(rows);
      setError(null);
      if (!quiet) setPollEpoch((n) => n + 1);
      const present = new Set(rows.map((r) => r.id));
      for (const [id, name] of deletesStartedHere.current) {
        if (present.has(id)) continue;
        deletesStartedHere.current.delete(id);
        showToast({
          type: 'success',
          message: t('dnsSecurityDnsSecurityIntegrationsTab.messages.deleteComplete', { name }),
        });
      }
      return 'ok';
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return 'aborted';
      if (requestId !== latestRequest.current) return 'stale';
      setError(err instanceof Error ? err.message : t('dnsSecurityDnsSecurityIntegrationsTab.messages.loadFailed'));
      return 'failed';
    } finally {
      if (!quiet && !signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchIntegrations(controller.signal);
    return () => controller.abort();
  }, [fetchIntegrations]);

  const anyDeleting = integrations.some(isDeleting);

  // One poll chain per "some row is deleting" episode, restarted by pollEpoch:
  // it starts when the first deleting row appears and is torn down (timer
  // cleared, request aborted) when none remain or the tab unmounts.
  useEffect(() => {
    if (!anyDeleting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = DELETE_POLL_INITIAL_MS;
    let failures = 0;
    let inFlight = false;
    // The chain stopped itself (browser tab hidden, or too many failures);
    // showing the tab again restarts it from the initial delay.
    let parked = false;

    const schedule = () => {
      if (controller.signal.aborted) return;
      timer = setTimeout(tick, delay);
      delay = Math.min(delay * 2, DELETE_POLL_MAX_MS);
    };

    async function tick() {
      timer = null;
      if (controller.signal.aborted) return;
      if (document.visibilityState === 'hidden') {
        parked = true;
        return;
      }
      inFlight = true;
      const outcome = await fetchIntegrations(controller.signal, { quiet: true });
      inFlight = false;
      if (outcome === 'aborted' || outcome === 'unauthorized') return;
      if (outcome === 'failed') {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          parked = true;
          return;
        }
      } else {
        failures = 0;
      }
      schedule();
    }

    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !parked || inFlight || timer !== null) return;
      parked = false;
      failures = 0;
      delay = DELETE_POLL_INITIAL_MS;
      void tick();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [anyDeleting, pollEpoch, fetchIntegrations]);

  const handleSync = async (integration: Integration) => {
    setBusyId(integration.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/dns-security/integrations/${integration.id}/sync`, {
          method: 'POST',
        }),
        errorFallback: t('dnsSecurityDnsSecurityIntegrationsTab.messages.syncFailed', { name: integration.name }),
        successMessage: t('dnsSecurityDnsSecurityIntegrationsTab.messages.syncQueued', { name: integration.name }),
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
    if (!window.confirm(t('dnsSecurityDnsSecurityIntegrationsTab.messages.deleteConfirm', { name: integration.name }))) {
      return;
    }
    setBusyId(integration.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/dns-security/integrations/${integration.id}`, {
          method: 'DELETE',
        }),
        errorFallback: t('dnsSecurityDnsSecurityIntegrationsTab.messages.deleteFailed', { name: integration.name }),
        successMessage: t('dnsSecurityDnsSecurityIntegrationsTab.messages.deleteSuccess', { name: integration.name }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      deletesStartedHere.current.set(integration.id, integration.name);
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
        <h2 className="text-lg font-medium">{t('dnsSecurityDnsSecurityIntegrationsTab.title')}</h2>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('dnsSecurityDnsSecurityIntegrationsTab.actions.addIntegration')}
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
          {t('dnsSecurityDnsSecurityIntegrationsTab.loading')}
        </div>
      ) : integrations.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <Plug className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t('dnsSecurityDnsSecurityIntegrationsTab.empty.title')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('dnsSecurityDnsSecurityIntegrationsTab.empty.description')}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">{t('dnsSecurityDnsSecurityIntegrationsTab.table.name')}</th>
                <th className="px-4 py-2 text-left">{t('dnsSecurityDnsSecurityIntegrationsTab.table.provider')}</th>
                <th className="px-4 py-2 text-left">{t('dnsSecurityDnsSecurityIntegrationsTab.table.lastSync')}</th>
                <th className="px-4 py-2 text-left">{t('dnsSecurityDnsSecurityIntegrationsTab.table.events')}</th>
                <th className="px-4 py-2 text-right">{t('dnsSecurityDnsSecurityIntegrationsTab.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((it) => (
                <tr key={it.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2 font-medium">{it.name}</td>
                  <td className="px-4 py-2">
                    {PROVIDER_LABEL_KEYS[it.provider]
                      ? t(/* i18n-dynamic */ `dnsSecurityDnsSecurityIntegrationsTab.${PROVIDER_LABEL_KEYS[it.provider]}`)
                      : it.provider}
                  </td>
                  <td className="px-4 py-2">
                    {/* 'partial': the last run hit the provider's request budget and the
                        rest resumes next run (#10018); the unfetched range is on hover. */}
                    {isDeleting(it) ? (
                      <span className="text-muted-foreground">{t('dnsSecurityDnsSecurityIntegrationsTab.deletingInBackground')}</span>
                    ) : it.lastSync ? (
                      <span
                        className={
                          it.lastSyncStatus === 'error'
                            ? 'text-destructive'
                            : it.lastSyncStatus === 'partial'
                              ? 'text-warning'
                              : ''
                        }
                        title={it.lastSyncStatus === 'partial' ? it.lastSyncError ?? undefined : undefined}
                      >
                        {formatDateTime(it.lastSync)}
                        {it.lastSyncStatus === 'error' && t('dnsSecurityDnsSecurityIntegrationsTab.lastSyncFailedSuffix')}
                        {it.lastSyncStatus === 'partial' && t('dnsSecurityDnsSecurityIntegrationsTab.lastSyncPartialSuffix')}
                      </span>
                    ) : (
                      <span
                        className="text-muted-foreground"
                        title={it.lastSyncStatus === 'partial' ? it.lastSyncError ?? undefined : undefined}
                      >
                        {t('dnsSecurityDnsSecurityIntegrationsTab.never')}
                        {it.lastSyncStatus === 'partial' && t('dnsSecurityDnsSecurityIntegrationsTab.lastSyncPartialSuffix')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{it.totalEventsProcessed ?? 0}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setRetentionTarget(it)}
                        disabled={busyId === it.id || isDeleting(it)}
                        title={t('dnsSecurityDnsSecurityIntegrationsTab.actions.editRetention')}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <Clock className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSync(it)}
                        disabled={busyId === it.id || isDeleting(it)}
                        title={t('dnsSecurityDnsSecurityIntegrationsTab.actions.syncNow')}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <RefreshCw className={`h-4 w-4 ${busyId === it.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(it)}
                        disabled={busyId === it.id || isDeleting(it)}
                        title={t('dnsSecurityDnsSecurityIntegrationsTab.actions.deleteIntegration')}
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

      {retentionTarget && (
        <EditDnsRetentionModal
          integration={{
            id: retentionTarget.id,
            name: retentionTarget.name,
            retentionDays: retentionTarget.config?.retentionDays ?? null,
          }}
          onClose={() => setRetentionTarget(null)}
          onSaved={() => void fetchIntegrations()}
        />
      )}

      {showAddModal && (
        <AddDnsIntegrationModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => void fetchIntegrations()}
        />
      )}
    </div>
  );
}
