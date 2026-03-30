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
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import C2CConnectionWizard from './C2CConnectionWizard';
import C2CRestoreDialog from './C2CRestoreDialog';

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

function statusBadge(status: string) {
  const lower = status.toLowerCase();
  if (lower === 'active' || lower === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> {status}
      </span>
    );
  }
  if (lower === 'failed' || lower === 'error' || lower === 'revoked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
        <XCircle className="h-3 w-3" /> {status}
      </span>
    );
  }
  if (lower === 'running' || lower === 'syncing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" /> {status}
      </span>
    );
  }
  if (lower === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Clock className="h-3 w-3" /> {status}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {status}
    </span>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(d: string | null): string {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

export default function C2CDashboard() {
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

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/c2c/connections');
      if (!res.ok) throw new Error('Failed to fetch connections');
      const data = await res.json();
      setConnections(data?.data ?? data?.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connections');
    }
  }, []);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/c2c/configs');
      if (!res.ok) throw new Error('Failed to fetch configs');
      const data = await res.json();
      setConfigs(data?.data ?? data?.configs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load configs');
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/c2c/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs');
      const data = await res.json();
      setJobs(data?.data ?? data?.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    }
  }, []);

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (itemSearch) params.set('search', itemSearch);
      if (itemTypeFilter) params.set('itemType', itemTypeFilter);
      if (itemUserFilter) params.set('userEmail', itemUserFilter);
      const qs = params.toString();
      const res = await fetchWithAuth(`/c2c/items${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error('Failed to fetch items');
      const data = await res.json();
      setItems(data?.data ?? data?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load items');
    }
  }, [itemSearch, itemTypeFilter, itemUserFilter]);

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
    { id: 'connections', label: 'Connections', icon: Link2 },
    { id: 'configs', label: 'Configs', icon: Settings2 },
    { id: 'jobs', label: 'Jobs', icon: History },
    { id: 'items', label: 'Items', icon: Search },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading cloud backup data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cloud-to-Cloud Backup</h1>
          <p className="text-sm text-muted-foreground">
            Protect Microsoft 365 and Google Workspace data
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowWizard(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Add Connection
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
                <th className="px-4 py-3 text-left font-medium">Provider</th>
                <th className="px-4 py-3 text-left font-medium">Display Name</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Last Sync</th>
                <th className="px-4 py-3 text-left font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {connections.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No connections configured yet. Click "Add Connection" to get started.
                  </td>
                </tr>
              ) : (
                connections.map((conn) => (
                  <tr key={conn.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      {conn.provider === 'microsoft365' ? 'Microsoft 365' : conn.provider === 'google_workspace' ? 'Google Workspace' : conn.provider}
                    </td>
                    <td className="px-4 py-3">{conn.displayName}</td>
                    <td className="px-4 py-3">{statusBadge(conn.status)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(conn.lastSyncAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(conn.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="rounded p-1 hover:bg-muted"
                        title="Sync now"
                        onClick={() => {
                          fetchWithAuth(`/c2c/connections/${conn.id}/sync`, { method: 'POST' })
                            .then(() => fetchConnections());
                        }}
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
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Scope</th>
                <th className="px-4 py-3 text-left font-medium">Target Users</th>
                <th className="px-4 py-3 text-left font-medium">Active</th>
                <th className="px-4 py-3 text-left font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {configs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No backup configs yet. Add a connection first, then configure backups.
                  </td>
                </tr>
              ) : (
                configs.map((cfg) => (
                  <tr key={cfg.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{cfg.name}</td>
                    <td className="px-4 py-3">{cfg.backupScope}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {Array.isArray(cfg.targetUsers) ? cfg.targetUsers.length : 0} user(s)
                    </td>
                    <td className="px-4 py-3">
                      {cfg.isActive
                        ? <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
                        : <span className="text-muted-foreground">No</span>}
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
                <th className="px-4 py-3 text-left font-medium">Job ID</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Started</th>
                <th className="px-4 py-3 text-left font-medium">Completed</th>
                <th className="px-4 py-3 text-right font-medium">Items</th>
                <th className="px-4 py-3 text-right font-medium">Transferred</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No sync jobs have run yet.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{job.id.slice(0, 8)}</td>
                    <td className="px-4 py-3">{statusBadge(job.status)}</td>
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
                placeholder="Search items..."
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
              <option value="">All types</option>
              <option value="email">Email</option>
              <option value="file">File</option>
              <option value="calendar">Calendar</option>
              <option value="contact">Contact</option>
              <option value="chat">Chat</option>
            </select>
            <input
              type="text"
              placeholder="Filter by user email"
              value={itemUserFilter}
              onChange={(e) => setItemUserFilter(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={fetchItems}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowRestore(true)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Restore Selected
            </button>
          </div>

          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-left font-medium">Name / Subject</th>
                  <th className="px-4 py-3 text-left font-medium">User</th>
                  <th className="px-4 py-3 text-left font-medium">Path</th>
                  <th className="px-4 py-3 text-right font-medium">Size</th>
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No items found. Run a sync to populate backup items.
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
