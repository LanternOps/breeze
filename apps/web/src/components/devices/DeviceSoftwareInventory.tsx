import { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type SoftwareItem = {
  id?: string;
  name?: string;
  title?: string;
  version?: string;
  publisher?: string;
  vendor?: string;
  installDate?: string;
  installedAt?: string;
  install_date?: string;
};

type DeviceSoftwareInventoryProps = {
  deviceId: string;
  timezone?: string;
};

function formatDate(value?: string, timezone?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceSoftwareInventory({ deviceId, timezone }: DeviceSoftwareInventoryProps) {
  const [software, setSoftware] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [query, setQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 15;

  // Use provided timezone, fetched siteTimezone, or browser default
  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const fetchSoftware = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/software`);
      if (!response.ok) throw new Error('Failed to fetch software inventory');
      const json = await response.json();
      const payload = json?.data ?? json;
      setSoftware(Array.isArray(payload) ? payload : []);
      if (json?.timezone || json?.siteTimezone) {
        setSiteTimezone(json.timezone ?? json.siteTimezone);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch software inventory');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchSoftware();
  }, [fetchSoftware]);

  const rows = useMemo(() => {
    return software.map((item, index) => ({
      id: item.id ?? `${item.name ?? item.title ?? 'software'}-${index}`,
      name: item.name ?? item.title ?? 'Unknown software',
      version: item.version || 'Not reported',
      publisher: item.publisher ?? item.vendor ?? 'Not reported',
      installDate: formatDate(item.installDate ?? item.installedAt ?? item.install_date, effectiveTimezone)
    }));
  }, [software, effectiveTimezone]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) return rows;
    return rows.filter(
      item =>
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.publisher.toLowerCase().includes(normalizedQuery) ||
        item.version.toLowerCase().includes(normalizedQuery)
    );
  }, [rows, query]);

  const totalPages = Math.ceil(filteredRows.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRows = filteredRows.slice(startIndex, startIndex + pageSize);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading software inventory...</p>
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
          onClick={fetchSoftware}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Installed Software</h3>
          <span className="text-sm text-muted-foreground">
            ({filteredRows.length} of {rows.length} items)
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search software..."
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-64"
          />
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Publisher</th>
              <th className="px-4 py-3">Installed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {query ? 'No software matches your search.' : 'No software inventory reported.'}
                </td>
              </tr>
            ) : (
              paginatedRows.map(item => (
                <tr key={item.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">{item.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.version}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.publisher}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.installDate}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredRows.length)} of{' '}
            {filteredRows.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
