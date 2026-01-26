import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network, Search, X, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type NetworkConnection = {
  id?: string;
  protocol?: string;
  localAddr?: string;
  localPort?: number | string;
  remoteAddr?: string;
  remotePort?: number | string;
  state?: string;
  processName?: string;
  pid?: number | string;
};

type DeviceNetworkConnectionsProps = {
  deviceId: string;
};

export default function DeviceNetworkConnections({ deviceId }: DeviceNetworkConnectionsProps) {
  const [connections, setConnections] = useState<NetworkConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/connections`);
      if (!response.ok) throw new Error('Failed to fetch network connections');
      const json = await response.json();
      const payload = json?.data ?? json;
      setConnections(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch network connections');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // Get unique protocols and states for filter dropdowns
  const { protocols, states } = useMemo(() => {
    const protocolSet = new Set<string>();
    const stateSet = new Set<string>();
    for (const conn of connections) {
      if (conn.protocol) protocolSet.add(conn.protocol.toUpperCase());
      if (conn.state) stateSet.add(conn.state);
    }
    return {
      protocols: Array.from(protocolSet).sort(),
      states: Array.from(stateSet).sort()
    };
  }, [connections]);

  const rows = useMemo(() => {
    return connections.map((item, index) => ({
      id: item.id ?? `${item.localAddr ?? 'conn'}-${index}`,
      protocol: item.protocol?.toUpperCase() ?? 'Unknown',
      localAddr: item.localAddr ?? '0.0.0.0',
      localPort: item.localPort ?? '-',
      local: `${item.localAddr ?? '0.0.0.0'}:${item.localPort ?? '-'}`,
      remoteAddr: item.remoteAddr ?? '',
      remotePort: item.remotePort ?? '',
      remote: item.remoteAddr ? `${item.remoteAddr}:${item.remotePort ?? '-'}` : '-',
      state: item.state || '-',
      process: item.processName || '-',
      pid: item.pid ?? '-'
    }));
  }, [connections]);

  const filteredRows = useMemo(() => {
    return rows.filter(row => {
      // Protocol filter
      if (protocolFilter !== 'all' && row.protocol !== protocolFilter) {
        return false;
      }

      // State filter
      if (stateFilter !== 'all' && row.state !== stateFilter) {
        return false;
      }

      // Search filter
      if (search) {
        const searchLower = search.toLowerCase();
        const searchableFields = [
          row.protocol,
          row.local,
          row.remote,
          row.state,
          row.process,
          String(row.pid),
          String(row.localPort),
          String(row.remotePort)
        ];
        return searchableFields.some(field =>
          field.toLowerCase().includes(searchLower)
        );
      }

      return true;
    });
  }, [rows, search, protocolFilter, stateFilter]);

  const clearFilters = () => {
    setSearch('');
    setProtocolFilter('all');
    setStateFilter('all');
  };

  const hasActiveFilters = search || protocolFilter !== 'all' || stateFilter !== 'all';

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading network connections...</p>
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
          onClick={fetchConnections}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Active Network Connections</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {filteredRows.length === rows.length
              ? rows.length
              : `${filteredRows.length} / ${rows.length}`}
          </span>
        </div>
        <button
          type="button"
          onClick={fetchConnections}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by process, address, port..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Protocol filter */}
        <select
          value={protocolFilter}
          onChange={(e) => setProtocolFilter(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">All Protocols</option>
          {protocols.map(proto => (
            <option key={proto} value={proto}>{proto}</option>
          ))}
        </select>

        {/* State filter */}
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="all">All States</option>
          {states.map(state => (
            <option key={state} value={state}>{state}</option>
          ))}
        </select>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="max-h-[500px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40 sticky top-0">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Protocol</th>
                <th className="px-4 py-3">Local</th>
                <th className="px-4 py-3">Remote</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Process</th>
                <th className="px-4 py-3">PID</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {hasActiveFilters
                      ? 'No connections match your filters.'
                      : 'No active network connections reported.'}
                  </td>
                </tr>
              ) : (
                filteredRows.map(row => (
                  <tr key={row.id} className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                        row.protocol.startsWith('TCP')
                          ? 'bg-blue-500/10 text-blue-600'
                          : 'bg-green-500/10 text-green-600'
                      }`}>
                        {row.protocol}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.local}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.remote}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                        row.state === 'ESTABLISHED' || row.state === 'LISTEN'
                          ? 'bg-green-500/10 text-green-600'
                          : row.state === 'TIME_WAIT' || row.state === 'CLOSE_WAIT'
                          ? 'bg-yellow-500/10 text-yellow-600'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {row.state}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.process}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.pid}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
