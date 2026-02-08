import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Filter, Loader2, Search, ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';

type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';
type ThreatStatus = 'active' | 'quarantined' | 'removed';

type Threat = {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  category: string;
  severity: ThreatSeverity;
  status: ThreatStatus;
  detectedAt: string;
  filePath: string;
};

const severityBadge: Record<ThreatSeverity, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const statusBadge: Record<ThreatStatus, string> = {
  active: 'bg-red-500/15 text-red-700 border-red-500/30',
  quarantined: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  removed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40'
};

function formatDetectedAt(value: string, timezone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { timeZone: timezone });
}

interface ThreatListProps {
  timezone?: string;
}

export default function ThreatList({ timezone }: ThreatListProps) {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [threats, setThreats] = useState<Threat[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | null>(null);

  const fetchThreats = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({ limit: '100' });
      if (query.trim()) params.set('search', query.trim());
      if (severityFilter !== 'all') params.set('severity', severityFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (startDate) params.set('startDate', new Date(startDate).toISOString());
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        params.set('endDate', end.toISOString());
      }

      const response = await fetchWithAuth(`/security/threats?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      let nextThreats: Threat[] = Array.isArray(payload.data) ? payload.data : [];

      if (deviceFilter !== 'all') {
        nextThreats = nextThreats.filter((threat) => threat.deviceName === deviceFilter);
      }

      setThreats(nextThreats);
      setSelectedIds(new Set());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceFilter, endDate, query, severityFilter, startDate, statusFilter]);

  useEffect(() => {
    fetchThreats();
    return () => abortRef.current?.abort();
  }, [fetchThreats]);

  const deviceOptions = useMemo(
    () => Array.from(new Set(threats.map((threat) => threat.deviceName))).sort(),
    [threats]
  );

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(threats.map((threat) => threat.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
  };

  const handleBulkAction = async (action: 'quarantine' | 'remove') => {
    if (selectedIds.size === 0) return;

    setActing(true);
    setError(undefined);

    try {
      const requests = Array.from(selectedIds).map((id) =>
        fetchWithAuth(`/security/threats/${id}/${action}`, { method: 'POST' })
      );

      const responses = await Promise.all(requests);
      const failed = responses.find((response) => !response.ok);
      if (failed) throw new Error(`${failed.status} ${failed.statusText}`);

      await fetchThreats();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setActing(false);
    }
  };

  const allSelected = threats.length > 0 && threats.every((threat) => selectedIds.has(threat.id));
  const someSelected = threats.some((threat) => selectedIds.has(threat.id));

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Threats</h2>
          <p className="text-sm text-muted-foreground">{threats.length} threats match your filters</p>
        </div>
        <div className="flex flex-1 flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          <div className="relative w-full lg:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search by threat name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All severities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="quarantined">Quarantined</option>
              <option value="removed">Removed</option>
            </select>
            <select
              value={deviceFilter}
              onChange={(event) => setDeviceFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All devices</option>
              {deviceOptions.map((device) => (
                <option key={device} value={device}>
                  {device}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={fetchThreats}
              className="h-10 rounded-md border bg-background px-3 text-sm hover:bg-muted"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => handleBulkAction('quarantine')}
            disabled={acting}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
            Quarantine selected
          </button>
          <button
            type="button"
            onClick={() => handleBulkAction('remove')}
            disabled={acting}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            <ShieldCheck className="h-4 w-4" />
            Remove selected
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(element) => {
                    if (element) element.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={(event) => handleSelectAll(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Threat</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Detected</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading threats...
                  </span>
                </td>
              </tr>
            ) : threats.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">No threats found.</td>
              </tr>
            ) : (
              threats.map((threat) => (
                <tr key={threat.id} className="text-sm">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(threat.id)}
                      onChange={(event) => handleSelectOne(threat.id, event.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">{threat.deviceName}</td>
                  <td className="px-4 py-3">{threat.name}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{threat.category}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold', severityBadge[threat.severity])}>
                      {threat.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold', statusBadge[threat.status])}>
                      {threat.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDetectedAt(threat.detectedAt, timezone)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
