import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Network, RefreshCw, Search, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type IPAssignmentType = 'dhcp' | 'static' | 'vpn' | 'link-local' | 'unknown';
type IPType = 'ipv4' | 'ipv6';

type DeviceIpHistoryEntry = {
  id?: string;
  interfaceName?: string;
  ipAddress?: string;
  ipType?: IPType;
  assignmentType?: IPAssignmentType;
  macAddress?: string | null;
  subnetMask?: string | null;
  gateway?: string | null;
  dnsServers?: string[] | null;
  firstSeen?: string | null;
  lastSeen?: string | null;
  isActive?: boolean;
  deactivatedAt?: string | null;
};

type DeviceIpHistoryResponse = {
  deviceId?: string;
  count?: number;
  data?: DeviceIpHistoryEntry[];
};

type DeviceIpHistoryTabProps = {
  deviceId: string;
};

const ASSIGNMENT_TYPES: Array<'all' | IPAssignmentType> = ['all', 'dhcp', 'static', 'vpn', 'link-local', 'unknown'];
const PAGE_SIZE = 25;
const MAX_FETCH_LIMIT = 500;

function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAssignment(value?: string): string {
  if (!value) return 'Unknown';
  if (value === 'dhcp') return 'DHCP';
  if (value === 'vpn') return 'VPN';
  if (value === 'link-local') return 'Link-local';
  if (value === 'static') return 'Static';
  return 'Unknown';
}

function badgeClassForAssignment(value?: string): string {
  switch (value) {
    case 'dhcp':
      return 'bg-blue-500/10 text-blue-600';
    case 'static':
      return 'bg-emerald-500/10 text-emerald-600';
    case 'vpn':
      return 'bg-violet-500/10 text-violet-600';
    case 'link-local':
      return 'bg-amber-500/10 text-amber-700';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export default function DeviceIpHistoryTab({ deviceId }: DeviceIpHistoryTabProps) {
  const [entries, setEntries] = useState<DeviceIpHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [fetchedCount, setFetchedCount] = useState(0);

  const [search, setSearch] = useState('');
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | IPAssignmentType>('all');
  const [interfaceFilter, setInterfaceFilter] = useState<string>('all');
  const [ipTypeFilter, setIpTypeFilter] = useState<'all' | IPType>('all');
  const [activeOnly, setActiveOnly] = useState(false);
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const fetchIpHistory = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({
        limit: String(MAX_FETCH_LIMIT),
        offset: '0',
        active_only: activeOnly ? 'true' : 'false',
      });
      const response = await fetchWithAuth(`/devices/${deviceId}/ip-history?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch IP history');
      }
      const json = await response.json() as DeviceIpHistoryResponse;
      const payload = json.data ?? [];
      setEntries(Array.isArray(payload) ? payload : []);
      setFetchedCount(typeof json.count === 'number' ? json.count : Array.isArray(payload) ? payload.length : 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch IP history');
    } finally {
      setLoading(false);
    }
  }, [activeOnly, deviceId]);

  useEffect(() => {
    fetchIpHistory();
  }, [fetchIpHistory]);

  const interfaceNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of entries) {
      const value = row.interfaceName?.trim();
      if (value) names.add(value);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const filteredRows = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    const since = sinceDate ? new Date(`${sinceDate}T00:00:00`) : null;
    const until = untilDate ? new Date(`${untilDate}T23:59:59`) : null;

    return entries.filter((row) => {
      const interfaceName = row.interfaceName ?? '';
      const ipAddress = row.ipAddress ?? '';
      const ipType = row.ipType ?? 'ipv4';
      const assignment = row.assignmentType ?? 'unknown';

      if (assignmentFilter !== 'all' && assignment !== assignmentFilter) return false;
      if (interfaceFilter !== 'all' && interfaceName !== interfaceFilter) return false;
      if (ipTypeFilter !== 'all' && ipType !== ipTypeFilter) return false;

      if (since) {
        const rowLastSeen = row.lastSeen ? new Date(row.lastSeen) : null;
        if (!rowLastSeen || rowLastSeen < since) return false;
      }

      if (until) {
        const rowFirstSeen = row.firstSeen ? new Date(row.firstSeen) : null;
        if (!rowFirstSeen || rowFirstSeen > until) return false;
      }

      if (searchLower) {
        const haystack = [
          interfaceName,
          ipAddress,
          ipType,
          assignment,
          row.macAddress ?? '',
          row.gateway ?? '',
          row.subnetMask ?? '',
          ...(row.dnsServers ?? []),
        ].join(' ').toLowerCase();
        if (!haystack.includes(searchLower)) return false;
      }

      return true;
    });
  }, [entries, assignmentFilter, interfaceFilter, ipTypeFilter, sinceDate, untilDate, search]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const paginatedRows = filteredRows.slice(startIndex, startIndex + PAGE_SIZE);

  useEffect(() => {
    setCurrentPage(1);
  }, [assignmentFilter, interfaceFilter, ipTypeFilter, sinceDate, untilDate, search, activeOnly]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const clearFilters = () => {
    setSearch('');
    setAssignmentFilter('all');
    setInterfaceFilter('all');
    setIpTypeFilter('all');
    setSinceDate('');
    setUntilDate('');
    setCurrentPage(1);
  };

  const hasFilters = Boolean(
    search ||
    assignmentFilter !== 'all' ||
    interfaceFilter !== 'all' ||
    ipTypeFilter !== 'all' ||
    sinceDate ||
    untilDate
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading IP history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchIpHistory}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">IP Assignment History</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {filteredRows.length === fetchedCount ? fetchedCount : `${filteredRows.length} / ${fetchedCount}`}
          </span>
        </div>
        <button
          type="button"
          onClick={fetchIpHistory}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search IP, interface, gateway, DNS..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <select
          value={assignmentFilter}
          onChange={(event) => setAssignmentFilter(event.target.value as 'all' | IPAssignmentType)}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {ASSIGNMENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {value === 'all' ? 'All Assignments' : formatAssignment(value)}
            </option>
          ))}
        </select>

        <select
          value={interfaceFilter}
          onChange={(event) => setInterfaceFilter(event.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">All Interfaces</option>
          {interfaceNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          value={ipTypeFilter}
          onChange={(event) => setIpTypeFilter(event.target.value as 'all' | IPType)}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">All IP Types</option>
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
        </select>

        <label className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={activeOnly}
            onChange={(event) => setActiveOnly(event.target.checked)}
          />
          Active only
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Clock3 className="h-4 w-4" />
          Since
          <input
            type="date"
            value={sinceDate}
            onChange={(event) => setSinceDate(event.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          Until
          <input
            type="date"
            value={untilDate}
            onChange={(event) => setUntilDate(event.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="max-h-[560px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="sticky top-0 bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Interface</th>
                <th className="px-4 py-3">IP Address</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Assignment</th>
                <th className="px-4 py-3">First Seen</th>
                <th className="px-4 py-3">Last Seen</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {hasFilters ? 'No IP assignments match your filters.' : 'No IP history reported yet.'}
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row, index) => (
                  <tr key={row.id ?? `${row.interfaceName ?? 'iface'}-${row.ipAddress ?? 'ip'}-${index}`} className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{row.interfaceName ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.ipAddress ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                        {(row.ipType ?? 'ipv4').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${badgeClassForAssignment(row.assignmentType)}`}>
                        {formatAssignment(row.assignmentType)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(row.firstSeen)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(row.lastSeen)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                        row.isActive ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'
                      }`}>
                        {row.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} - {Math.min(startIndex + PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              First
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[100px] text-center text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Last
            </button>
          </div>
        </div>
      )}

      {fetchedCount >= MAX_FETCH_LIMIT && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the most recent {MAX_FETCH_LIMIT} assignments. Narrow filters to inspect specific ranges.
        </p>
      )}
    </div>
  );
}
