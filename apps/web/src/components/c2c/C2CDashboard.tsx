import { useCallback, useEffect, useState } from 'react';
import {
  Cloud,
  Link2,
  Settings2,
  History,
  Search,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OrgRequiredGate } from '../shared/OrgRequiredGate';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { formatNumber } from '@/lib/i18n/format';
import C2CConnectionWizard from './C2CConnectionWizard';
import C2CRestoreDialog from './C2CRestoreDialog';
import AlphaBadge from '../shared/AlphaBadge';

type C2CTab = 'connections' | 'configs' | 'jobs' | 'items';

interface C2CConnection {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
}

interface C2CConfig {
  id: string;
  connectionId: string;
  name: string;
  backupScope: string;
  targetUsers: string[];
  isActive: boolean;
  createdAt: string;
}

interface C2CJob {
  id: string;
  configId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  itemsProcessed: number;
  itemsNew: number;
  bytesTransferred: number;
  errorLog: string | null;
}

interface C2CItem {
  id: string;
  itemType: string;
  userEmail: string | null;
  subjectOrName: string | null;
  parentPath: string | null;
  sizeBytes: number | null;
  itemDate: string | null;
}

function statusBadge(status: string, t: (key: string) => string) {
  const lower = status.toLowerCase();
  const label = t(/* i18n-dynamic */ `longTail.c2c.C2CDashboard.status.${lower}`);
  const displayStatus = label === `longTail.c2c.C2CDashboard.status.${lower}` ? status : label;
  if (lower === 'active' || lower === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> {displayStatus}
      </span>
    );
  }
  if (lower === 'failed' || lower === 'error' || lower === 'revoked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
        <XCircle className="h-3 w-3" /> {displayStatus}
      </span>
    );
  }
  if (lower === 'running' || lower === 'syncing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" /> {displayStatus}
      </span>
    );
  }
  if (lower === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Clock className="h-3 w-3" /> {displayStatus}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {displayStatus}
    </span>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${formatNumber(bytes / Math.pow(k, i), { maximumFractionDigits: 1 })} ${sizes[i]}`;
}

function formatDate(d: string | null): string {
  return formatDateTime(d, { fallback: '-' });
}

function C2CDashboardInner() {
  const { t } = useTranslation('common');
  const [activeTab, setActiveTab] = useState<C2CTab>('connections');
  const [connections, setConnections] = useState<C2CConnection[]>([]);
  const [configs, setConfigs] = useState<C2CConfig[]>([]);
  const [jobs, setJobs] = useState<C2CJob[]>([]);
  const [items, setItems] = useState<C2CItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showWizard, setShowWizard] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [itemSearch, setItemSearch] = useState('');
  const [itemTypeFilter, setItemTypeFilter] = useState('');
  const [itemUserFilter, setItemUserFilter] = useState('');
  const [consentSuccess, setConsentSuccess] = useState<string>();
  const [consentError, setConsentError] = useState<string>();

  // Handle callback params from M365 admin consent redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('c2c_connected') === 'true') {
      setConsentSuccess(t('longTail.c2c.C2CDashboard.consentSuccess'));
      // Clean URL params
      const url = new URL(window.location.href);
      url.searchParams.delete('c2c_connected');
      url.searchParams.delete('connectionId');
      window.history.replaceState({}, '', url.pathname);
    }
    const c2cError = params.get('c2c_error');
    if (c2cError) {
      setConsentError(decodeURIComponent(c2cError));
      const url = new URL(window.location.href);
      url.searchParams.delete('c2c_error');
      window.history.replaceState({}, '', url.pathname);
    }
  }, [t]);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/c2c/connections');
      if (!res.ok) throw new Error(t('longTail.c2c.C2CDashboard.errors.fetchConnections'));
      const data = await res.json();
      setConnections(data?.data ?? data?.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CDashboard.errors.loadConnections'));
    }
  }, [t]);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/c2c/configs');
      if (!res.ok) throw new Error(t('longTail.c2c.C2CDashboard.errors.fetchConfigs'));
      const data = await res.json();
      setConfigs(data?.data ?? data?.configs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CDashboard.errors.loadConfigs'));
    }
  }, [t]);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/c2c/jobs');
      if (!res.ok) throw new Error(t('longTail.c2c.C2CDashboard.errors.fetchJobs'));
      const data = await res.json();
      setJobs(data?.data ?? data?.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CDashboard.errors.loadJobs'));
    }
  }, [t]);

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (itemSearch) params.set('search', itemSearch);
      if (itemTypeFilter) params.set('itemType', itemTypeFilter);
      if (itemUserFilter) params.set('userEmail', itemUserFilter);
      const qs = params.toString();
      const res = await fetchWithAuth(`/c2c/items${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(t('longTail.c2c.C2CDashboard.errors.fetchItems'));
      const data = await res.json();
      setItems(data?.data ?? data?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CDashboard.errors.loadItems'));
    }
  }, [itemSearch, itemTypeFilter, itemUserFilter, t]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchConnections(), fetchConfigs(), fetchJobs(), fetchItems()])
      .finally(() => setLoading(false));
  }, [fetchConnections, fetchConfigs, fetchJobs, fetchItems]);

  const handleWizardComplete = useCallback(() => {
    setShowWizard(false);
    fetchConnections();
    fetchConfigs();
  }, [fetchConnections, fetchConfigs]);

  const tabs: { id: C2CTab; label: string; icon: typeof Cloud }[] = [
    { id: 'connections', label: t('longTail.c2c.C2CDashboard.tabs.connections'), icon: Link2 },
    { id: 'configs', label: t('longTail.c2c.C2CDashboard.tabs.configs'), icon: Settings2 },
    { id: 'jobs', label: t('longTail.c2c.C2CDashboard.tabs.jobs'), icon: History },
    { id: 'items', label: t('longTail.c2c.C2CDashboard.tabs.items'), icon: Search },
  ];

  const formatProvider = (provider: string) => {
    if (provider === 'microsoft365' || provider === 'microsoft_365') return t('longTail.c2c.C2CDashboard.providers.microsoft365');
    if (provider === 'google_workspace') return t('longTail.c2c.C2CDashboard.providers.googleWorkspace');
    return provider;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('longTail.c2c.C2CDashboard.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer={t('longTail.c2c.C2CDashboard.alphaDisclaimer')} />

      {consentSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {consentSuccess}
          <button type="button" onClick={() => setConsentSuccess(undefined)} className="ml-auto text-emerald-600 hover:text-emerald-800 dark:text-emerald-400">
            &times;
          </button>
        </div>
      )}

      {consentError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('longTail.c2c.C2CDashboard.consentFailed', { error: consentError })}
          <button type="button" onClick={() => setConsentError(undefined)} className="ml-auto text-red-600 hover:text-red-800 dark:text-red-400">
            &times;
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('longTail.c2c.C2CDashboard.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('longTail.c2c.C2CDashboard.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowWizard(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> {t('longTail.c2c.C2CDashboard.addConnection')}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mr-1 inline h-4 w-4" /> {error}
        </div>
      )}

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon className="h-4 w-4" /> {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'connections' && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.provider')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.displayName')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('common:labels.status')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.lastSync')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('common:labels.createdAt')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('common:labels.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {connections.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('longTail.c2c.C2CDashboard.empty.connections')}
                  </td>
                </tr>
              ) : (
                connections.map((conn) => (
                  <tr key={conn.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      {formatProvider(conn.provider)}
                    </td>
                    <td className="px-4 py-3">{conn.displayName}</td>
                    <td className="px-4 py-3">{statusBadge(conn.status, t)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(conn.lastSyncAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(conn.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="cursor-not-allowed rounded p-1 opacity-50"
                        title={t('longTail.c2c.C2CDashboard.syncNotImplemented')}
                        disabled
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'configs' && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">{t('common:labels.name')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.scope')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.targetUsers')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('common:states.active')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('common:labels.createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {configs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    {t('longTail.c2c.C2CDashboard.empty.configs')}
                  </td>
                </tr>
              ) : (
                configs.map((cfg) => (
                  <tr key={cfg.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{cfg.name}</td>
                    <td className="px-4 py-3">{cfg.backupScope}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {t('longTail.c2c.C2CDashboard.targetUsersCount', { count: Array.isArray(cfg.targetUsers) ? cfg.targetUsers.length : 0 })}
                    </td>
                    <td className="px-4 py-3">
                      {cfg.isActive
                        ? <span className="text-emerald-600 dark:text-emerald-400">{t('common:labels.yes')}</span>
                        : <span className="text-muted-foreground">{t('common:labels.no')}</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(cfg.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'jobs' && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.jobId')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('common:labels.status')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.started')}</th>
                <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.completed')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('longTail.c2c.C2CDashboard.tabs.items')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('longTail.c2c.C2CDashboard.table.transferred')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('longTail.c2c.C2CDashboard.empty.jobs')}
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{job.id.slice(0, 8)}</td>
                    <td className="px-4 py-3">{statusBadge(job.status, t)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(job.startedAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(job.completedAt)}</td>
                    <td className="px-4 py-3 text-right">{job.itemsProcessed}</td>
                    <td className="px-4 py-3 text-right">{formatBytes(job.bytesTransferred)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'items' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('longTail.c2c.C2CDashboard.searchItemsPlaceholder')}
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                className="w-full rounded-md border bg-background py-2 pl-10 pr-3 text-sm"
              />
            </div>
            <select
              value={itemTypeFilter}
              onChange={(e) => setItemTypeFilter(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">{t('longTail.c2c.C2CDashboard.filters.allTypes')}</option>
              <option value="email">{t('longTail.c2c.C2CDashboard.itemTypes.email')}</option>
              <option value="file">{t('longTail.c2c.C2CDashboard.itemTypes.file')}</option>
              <option value="calendar">{t('longTail.c2c.C2CDashboard.itemTypes.calendar')}</option>
              <option value="contact">{t('longTail.c2c.C2CDashboard.itemTypes.contact')}</option>
              <option value="chat">{t('longTail.c2c.C2CDashboard.itemTypes.chat')}</option>
            </select>
            <input
              type="text"
              placeholder={t('longTail.c2c.C2CDashboard.filterByUserEmail')}
              value={itemUserFilter}
              onChange={(e) => setItemUserFilter(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={fetchItems}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              <RefreshCw className="h-3.5 w-3.5" /> {t('common:actions.refresh')}
            </button>
            <button
              type="button"
              onClick={() => setShowRestore(true)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('longTail.c2c.C2CDashboard.restoreSelected')}
            </button>
          </div>

          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">{t('common:labels.type')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.nameOrSubject')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('common:labels.user')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.path')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('longTail.c2c.C2CDashboard.table.size')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CDashboard.table.date')}</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      {t('longTail.c2c.C2CDashboard.empty.items')}
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                          {item.itemType}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-[250px] truncate">{item.subjectOrName ?? '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.userEmail ?? '-'}</td>
                      <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">
                        {item.parentPath ?? '-'}
                      </td>
                      <td className="px-4 py-3 text-right">{formatBytes(item.sizeBytes)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(item.itemDate)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showWizard && (
        <C2CConnectionWizard
          onClose={() => setShowWizard(false)}
          onComplete={handleWizardComplete}
        />
      )}

      {showRestore && (
        <C2CRestoreDialog
          items={items}
          onClose={() => setShowRestore(false)}
          onComplete={() => {
            setShowRestore(false);
            fetchItems();
          }}
        />
      )}
    </div>
  );
}

// The c2c APIs are per-organization (they 400 on an org-less request), so the
// gate resolves loading/error/empty/fleet before the data component — with all
// its fetch effects — ever mounts without an org.
export default function C2CDashboard() {
  return (
    <OrgRequiredGate>
      <C2CDashboardInner />
    </OrgRequiredGate>
  );
}
