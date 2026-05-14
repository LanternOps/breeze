import { useState, useEffect, useCallback } from 'react';
import { Package, Search, ShieldCheck, AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

type CatalogEntry = {
  id: string;
  source: string;
  packageId: string;
  vendor: string;
  friendlyName: string;
  category: string;
  defaultSeverity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
  breezeTested: boolean;
  lastTestedAt: string | null;
  lastTestedVersion: string | null;
  lastTestedResult: string | null;
  notes: string | null;
  homepageUrl: string | null;
};

const severityStyles: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  important: 'bg-orange-100 text-orange-800',
  moderate: 'bg-yellow-100 text-yellow-800',
  low: 'bg-green-100 text-green-800',
  unknown: 'bg-gray-100 text-gray-700',
};

export default function ThirdPartyCatalog() {
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [showOnlyTested, setShowOnlyTested] = useState(false);

  const fetchCatalog = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      params.set('limit', '500');
      if (search.trim()) params.set('search', search.trim());
      if (showOnlyTested) params.set('breezeTested', 'true');
      const response = await fetchWithAuth(`/third-party-catalog?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to load catalog');
      const data = await response.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [search, showOnlyTested]);

  useEffect(() => {
    const timer = setTimeout(fetchCatalog, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [fetchCatalog, search]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Package className="w-6 h-6" /> Third-Party Package Catalog
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Breeze-curated metadata for third-party software detected by winget on agents.
            Total entries: <span data-testid="catalog-total">{total}</span>
          </p>
        </div>
        <button
          data-testid="catalog-refresh"
          onClick={fetchCatalog}
          className="px-3 py-2 text-sm border rounded hover:bg-gray-50 flex items-center gap-1"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            data-testid="catalog-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, vendor, or winget ID…"
            className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="catalog-filter-tested"
            checked={showOnlyTested}
            onChange={(e) => setShowOnlyTested(e.target.checked)}
          />
          Breeze-tested only
        </label>
      </div>

      {error && (
        <div className="bg-red-50 text-red-800 px-4 py-3 rounded mb-4 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading catalog…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500" data-testid="catalog-empty">
          No catalog entries match the current filters.
        </div>
      ) : (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 font-medium">Package</th>
                <th className="px-4 py-2 font-medium">Winget ID</th>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr
                  key={entry.id}
                  data-testid={`catalog-row-${entry.id}`}
                  className="border-b hover:bg-gray-50"
                >
                  <td className="px-4 py-2">{entry.vendor}</td>
                  <td className="px-4 py-2">
                    {entry.homepageUrl ? (
                      <a
                        href={entry.homepageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {entry.friendlyName}
                      </a>
                    ) : (
                      entry.friendlyName
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600">
                    {entry.packageId}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                        severityStyles[entry.defaultSeverity] ?? severityStyles.unknown
                      }`}
                    >
                      {entry.defaultSeverity}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {entry.breezeTested && (
                      <span
                        data-testid={`catalog-row-${entry.id}-tested-badge`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-100 text-green-800"
                      >
                        <ShieldCheck className="w-3 h-3" /> Breeze-tested
                      </span>
                    )}
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
