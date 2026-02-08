import { useCallback, useEffect, useState } from 'react';
import {
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Loader2,
  Play,
  Trash2
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type MonitorDetail = {
  id: string;
  name: string;
  monitorType: string;
  target: string;
  config: Record<string, unknown>;
  pollingInterval: number;
  timeout: number;
  isActive: boolean;
  lastChecked: string | null;
  lastStatus: string;
  lastResponseMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  recentResults: Array<{
    id: string;
    status: string;
    responseMs: number | null;
    statusCode: number | null;
    error: string | null;
    details: Record<string, unknown> | null;
    timestamp: string;
  }>;
  alertRules: Array<{
    id: string;
    condition: string;
    threshold: string | null;
    severity: string;
    message: string | null;
    isActive: boolean;
  }>;
};

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  online: { icon: CheckCircle, color: 'text-green-600 bg-green-500/20 border-green-500/40', label: 'Online' },
  offline: { icon: XCircle, color: 'text-red-600 bg-red-500/20 border-red-500/40', label: 'Offline' },
  degraded: { icon: AlertTriangle, color: 'text-yellow-600 bg-yellow-500/20 border-yellow-500/40', label: 'Degraded' },
  unknown: { icon: HelpCircle, color: 'text-muted-foreground bg-muted border-muted', label: 'Unknown' }
};

const typeLabels: Record<string, string> = {
  icmp_ping: 'ICMP Ping',
  tcp_port: 'TCP Port',
  http_check: 'HTTP Check',
  dns_check: 'DNS Check'
};

function formatRelativeTime(dateString: string | null) {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

type MonitorDetailModalProps = {
  monitorId: string;
  onClose: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
};

export default function MonitorDetailModal({ monitorId, onClose, onDeleted, onUpdated }: MonitorDetailModalProps) {
  const [monitor, setMonitor] = useState<MonitorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionLoading, setActionLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editInterval, setEditInterval] = useState(60);
  const [editTimeout, setEditTimeout] = useState(5);
  const [editActive, setEditActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchWithAuth(`/monitors/${monitorId}`);
      if (!res.ok) throw new Error('Failed to load monitor details');
      const data = await res.json();
      const m = data.data;
      setMonitor(m);
      setEditName(m.name);
      setEditInterval(m.pollingInterval);
      setEditTimeout(m.timeout);
      setEditActive(m.isActive);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [monitorId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleCheck = async () => {
    setActionLoading(true);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}/check`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to trigger check');
      setTimeout(() => fetchDetail(), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          pollingInterval: editInterval,
          timeout: editTimeout,
          isActive: editActive
        })
      });
      if (!res.ok) throw new Error('Failed to update monitor');
      setEditing(false);
      await fetchDetail();
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      const res = await fetchWithAuth(`/monitors/${monitorId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete monitor');
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
        <div className="rounded-lg border bg-card p-8 shadow-sm">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!monitor) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <p className="text-sm text-destructive">{error ?? 'Monitor not found'}</p>
          <button type="button" onClick={onClose} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
            Close
          </button>
        </div>
      </div>
    );
  }

  const sc = statusConfig[monitor.lastStatus] ?? statusConfig.unknown;
  const StatusIcon = sc.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-sm">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{monitor.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {typeLabels[monitor.monitorType] ?? monitor.monitorType} &middot; {monitor.target}
            </p>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Status Bar */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-md border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Status:</span>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${sc.color}`}>
              <StatusIcon className="h-3 w-3" />
              {sc.label}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Response: {monitor.lastResponseMs != null ? `${Math.round(monitor.lastResponseMs)}ms` : '—'}
          </div>
          <div className="text-xs text-muted-foreground">
            Last checked: {formatRelativeTime(monitor.lastChecked)}
          </div>
          {monitor.consecutiveFailures > 0 && (
            <div className="text-xs text-destructive">
              {monitor.consecutiveFailures} consecutive failure{monitor.consecutiveFailures > 1 ? 's' : ''}
            </div>
          )}
          {monitor.lastError && (
            <div className="w-full text-xs text-destructive mt-1">{monitor.lastError}</div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheck}
            disabled={actionLoading}
            className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Check Now
          </button>
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
          >
            {editing ? 'Cancel Edit' : 'Edit'}
          </button>
        </div>

        {/* Edit Form */}
        {editing && (
          <div className="mt-4 rounded-md border bg-muted/20 p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Interval (s)</label>
                <input
                  type="number"
                  value={editInterval}
                  onChange={(e) => setEditInterval(Number(e.target.value))}
                  min={10}
                  max={86400}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Timeout (s)</label>
                <input
                  type="number"
                  value={editTimeout}
                  onChange={(e) => setEditTimeout(Number(e.target.value))}
                  min={1}
                  max={300}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editActive}
                onChange={(e) => setEditActive(e.target.checked)}
                className="rounded border"
              />
              Active
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-1"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        )}

        {/* Recent Results */}
        {monitor.recentResults.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold mb-2">Recent Results</h3>
            <div className="max-h-60 overflow-y-auto rounded-md border">
              <table className="min-w-full divide-y text-xs">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Time</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Response</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {monitor.recentResults.map((r) => {
                    const rsc = statusConfig[r.status] ?? statusConfig.unknown;
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-1.5 text-muted-foreground">{formatRelativeTime(r.timestamp)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${rsc.color}`}>
                            {rsc.label}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {r.responseMs != null ? `${Math.round(r.responseMs)}ms` : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground max-w-[200px] truncate" title={r.error ?? ''}>
                          {r.error ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Alert Rules */}
        {monitor.alertRules.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold mb-2">Alert Rules</h3>
            <div className="space-y-2">
              {monitor.alertRules.map((rule) => (
                <div key={rule.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                  <div>
                    <span className="font-medium">{rule.condition}</span>
                    {rule.threshold && <span className="text-muted-foreground ml-1">({rule.threshold})</span>}
                    <span className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      rule.severity === 'critical' ? 'bg-red-500/20 text-red-700' :
                      rule.severity === 'high' ? 'bg-orange-500/20 text-orange-700' :
                      rule.severity === 'medium' ? 'bg-yellow-500/20 text-yellow-700' :
                      'bg-blue-500/20 text-blue-700'
                    }`}>
                      {rule.severity}
                    </span>
                    {!rule.isActive && <span className="ml-2 text-muted-foreground">(disabled)</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <div>
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 text-xs text-destructive hover:underline"
              >
                <Trash2 className="h-3 w-3" />
                Delete monitor
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-destructive">Are you sure?</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={actionLoading}
                  className="h-7 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {actionLoading ? 'Deleting...' : 'Yes, delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="h-7 rounded-md border px-3 text-xs font-medium text-muted-foreground"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
