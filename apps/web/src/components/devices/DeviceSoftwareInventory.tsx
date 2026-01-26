import { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, Search, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
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
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceSoftwareInventory({ deviceId, timezone }: DeviceSoftwareInventoryProps) {
  const [software, setSoftware] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [publisherFilter, setPublisherFilter] = useState<string>('all');
  const pageSize = 25;

  // Use provided timezone, fetched siteTimezone, or browser default
  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchSoftware = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Fetch all software (use high limit since we're doing client-side filtering)
      const response = await fetchWithAuth(`/devices/${deviceId}/software?limit=1000`);
      if (!response.ok) throw new Error('Failed to fetch software inventory');
      const json = await response.json();
      const payload = json?.data ?? json;
      setSoftware(Array.isArray(payload) ? payload : []);
      setTotal(json?.pagination?.total ?? (Array.isArray(payload) ? payload.length : 0));
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

  // Get unique publishers for filter dropdown
  const publishers = useMemo(() => {
    const publisherSet = new Set<string>();
    for (const item of software) {
      const pub = item.publisher ?? item.vendor;
      if (pub) publisherSet.add(pub);
    }
    return Array.from(publisherSet).sort();
  }, [software]);

  const rows = useMemo(() => {
    return software.map((item, index) => ({
      id: item.id ?? `${item.name ?? item.title ?? 'software'}-${index}`,
      name: item.name ?? item.title ?? 'Unknown software',
      version: item.version || '-',
      publisher: item.publisher ?? item.vendor ?? '-',
      installDate: formatDate(item.installDate ?? item.installedAt ?? item.install_date, effectiveTimezone)
    }));
  }, [software, effectiveTimezone]);

  const filteredRows = useMemo(() => {
    return rows.filter(item => {
      // Publisher filter
      if (publisherFilter !== 'all' && item.publisher !== publisherFilter) {
        return false;
      }

      // Search filter
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        return (
          item.name.toLowerCase().includes(searchLower) ||
          item.publisher.toLowerCase().includes(searchLower) ||
          item.version.toLowerCase().includes(searchLower)
        );
      }

      return true;
    });
  }, [rows, debouncedSearch, publisherFilter]);

  const totalPages = Math.ceil(filteredRows.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRows = filteredRows.slice(startIndex, startIndex + pageSize);

  const clearFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setPublisherFilter('all');
    setCurrentPage(1);
  };

  const hasActiveFilters = search || publisherFilter !== 'all';

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Installed Software</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {filteredRows.length === rows.length
              ? rows.length
              : `${filteredRows.length} / ${rows.length}`}
          </span>
        </div>
        <button
          type="button"
          onClick={fetchSoftware}
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
            placeholder="Search by name, publisher, version..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Publisher filter */}
        <select
          value={publisherFilter}
          onChange={(e) => {
            setPublisherFilter(e.target.value);
            setCurrentPage(1);
          }}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 max-w-[200px]"
        >
          <option value="all">All Publishers ({publishers.length})</option>
          {publishers.map(pub => (
            <option key={pub} value={pub}>{pub}</option>
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
                    {hasActiveFilters
                      ? 'No software matches your filters.'
                      : 'No software inventory reported.'}
                  </td>
                </tr>
              ) : (
                paginatedRows.map(item => (
                  <tr key={item.id} className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{item.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{item.version}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.publisher}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.installDate}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} - {Math.min(startIndex + pageSize, filteredRows.length)} of{' '}
            {filteredRows.length}
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
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm min-w-[100px] text-center">
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
    </div>
  );
}
