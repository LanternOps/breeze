import { useState, useMemo, useEffect } from 'react';
import { X, Search, Package, Loader2, ChevronLeft, ChevronRight, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../../stores/auth';

export type SelectedSoftware = {
  catalogId: string;
  catalogName: string;
  vendor?: string;
  versionId?: string;
  versionLabel?: string;
};

type SoftwareCatalogPickerProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (software: SelectedSoftware) => void;
};

type CatalogItem = {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  isManaged: boolean;
};

type VersionItem = {
  id: string;
  version: string;
  releaseDate: string | null;
  architecture: string | null;
  isLatest: boolean;
};

const CATEGORIES = [
  'browser',
  'utility',
  'compression',
  'productivity',
  'communication',
  'developer',
  'media',
  'security',
] as const;

const categoryStyles: Record<string, string> = {
  browser: 'bg-blue-500/20 text-blue-700',
  utility: 'bg-amber-500/20 text-amber-700',
  developer: 'bg-purple-500/20 text-purple-700',
  communication: 'bg-emerald-500/20 text-emerald-700',
  security: 'bg-red-500/20 text-red-700',
  productivity: 'bg-slate-500/20 text-slate-700',
  compression: 'bg-orange-500/20 text-orange-700',
  media: 'bg-pink-500/20 text-pink-700',
};

function formatDate(dateString: string | null): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

export default function SoftwareCatalogPicker({
  isOpen,
  onClose,
  onSelect,
}: SoftwareCatalogPickerProps) {
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // Version selection state (step 2)
  const [selectedCatalogItem, setSelectedCatalogItem] = useState<CatalogItem | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string>();

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setCategoryFilter('all');
      setSelectedCatalogItem(null);
      setVersions([]);
      setVersionsError(undefined);
      fetchCatalog();
    }
  }, [isOpen]);

  async function fetchCatalog() {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth('/software/catalog?limit=100');
      if (!response.ok) {
        throw new Error('Failed to fetch software catalog');
      }

      const payload = await response.json();
      const data = payload.data ?? payload ?? [];

      const items: CatalogItem[] = Array.isArray(data)
        ? data.map((item: Record<string, unknown>) => ({
            id: String(item.id),
            name: String(item.name ?? ''),
            vendor: String(item.vendor ?? ''),
            category: String(item.category ?? 'utility'),
            description: String(item.description ?? ''),
            isManaged: Boolean(item.isManaged ?? item.is_managed ?? false),
          }))
        : [];

      setCatalogItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load software catalog');
    } finally {
      setLoading(false);
    }
  }

  async function fetchVersions(catalogId: string) {
    try {
      setVersionsLoading(true);
      setVersionsError(undefined);

      const response = await fetchWithAuth(`/software/catalog/${catalogId}/versions`);
      if (!response.ok) {
        throw new Error('Failed to fetch versions');
      }

      const payload = await response.json();
      const data = payload.data ?? payload.versions ?? payload ?? [];

      const versionList: VersionItem[] = Array.isArray(data)
        ? data.map((v: Record<string, unknown>) => ({
            id: String(v.id ?? ''),
            version: String(v.version ?? ''),
            releaseDate: v.releaseDate ? String(v.releaseDate) : (v.release_date ? String(v.release_date) : null),
            architecture: v.architecture ? String(v.architecture) : null,
            isLatest: Boolean(v.isLatest ?? v.is_latest ?? false),
          }))
        : [];

      setVersions(versionList);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : 'Failed to load versions');
    } finally {
      setVersionsLoading(false);
    }
  }

  const filteredCatalog = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return catalogItems.filter((item) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.vendor.toLowerCase().includes(normalizedQuery) ||
        item.description.toLowerCase().includes(normalizedQuery);
      const matchesCategory =
        categoryFilter === 'all' || item.category === categoryFilter;

      return matchesQuery && matchesCategory;
    });
  }, [catalogItems, query, categoryFilter]);

  const handleCatalogSelect = (item: CatalogItem) => {
    setSelectedCatalogItem(item);
    fetchVersions(item.id);
  };

  const handleVersionSelect = (versionId: string | null, versionLabel: string | null) => {
    if (!selectedCatalogItem) return;

    onSelect({
      catalogId: selectedCatalogItem.id,
      catalogName: selectedCatalogItem.name,
      vendor: selectedCatalogItem.vendor || undefined,
      versionId: versionId ?? undefined,
      versionLabel: versionLabel ?? undefined,
    });
    onClose();
  };

  const handleBackToCatalog = () => {
    setSelectedCatalogItem(null);
    setVersions([]);
    setVersionsError(undefined);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-lg border bg-card shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-3">
            {selectedCatalogItem && (
              <button
                type="button"
                onClick={handleBackToCatalog}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div>
              <h2 className="text-lg font-semibold">
                {selectedCatalogItem
                  ? `Select Version - ${selectedCatalogItem.name}`
                  : 'Select Software Package'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {selectedCatalogItem
                  ? 'Choose a specific version or select latest'
                  : 'Choose software to deploy when this rule fails compliance'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Filters (only on catalog view) */}
        {!selectedCatalogItem && (
          <div className="border-b px-6 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search software, vendor..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="all">All Categories</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {selectedCatalogItem ? (
            // Version selection view
            versionsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : versionsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {versionsError}
              </div>
            ) : (
              <div className="space-y-2">
                {/* "Latest" option - always shown */}
                <button
                  type="button"
                  onClick={() => handleVersionSelect(null, 'Latest')}
                  className="flex w-full items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-left transition hover:bg-primary/10"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/20 text-primary">
                    <CheckCircle className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">Latest</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Always deploy the most recent version available
                    </p>
                  </div>
                </button>

                {/* Specific versions */}
                {versions.map((ver) => (
                  <button
                    key={ver.id}
                    type="button"
                    onClick={() => handleVersionSelect(ver.id, ver.version.startsWith('v') ? ver.version : `v${ver.version}`)}
                    className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition hover:bg-muted/50"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-xs font-bold text-muted-foreground">
                      v
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{ver.version}</p>
                        {ver.isLatest && (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            Latest
                          </span>
                        )}
                        {ver.architecture && (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {ver.architecture}
                          </span>
                        )}
                      </div>
                      {ver.releaseDate && (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          Released {formatDate(ver.releaseDate)}
                        </p>
                      )}
                    </div>
                  </button>
                ))}

                {versions.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No specific versions available. Select "Latest" above.
                  </p>
                )}
              </div>
            )
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : filteredCatalog.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {catalogItems.length === 0
                ? 'No software packages available'
                : 'No packages match your search'}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredCatalog.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleCatalogSelect(item)}
                  className="flex w-full items-start gap-3 rounded-lg border p-4 text-left transition hover:bg-muted/50"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
                    <Package className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{item.name}</p>
                      {item.vendor && (
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {item.vendor}
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">
                        {item.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {item.category && (
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
                            categoryStyles[item.category] ?? 'bg-muted text-muted-foreground',
                          )}
                        >
                          {item.category.charAt(0).toUpperCase() + item.category.slice(1)}
                        </span>
                      )}
                      {item.isManaged && (
                        <span className="inline-flex items-center rounded-full bg-blue-500/20 px-2 py-0.5 font-medium text-blue-700">
                          Managed
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4">
          <p className="text-sm text-muted-foreground">
            {selectedCatalogItem
              ? `${versions.length} version(s) available`
              : `${filteredCatalog.length} package(s) available`}
          </p>
          <button
            type="button"
            onClick={selectedCatalogItem ? handleBackToCatalog : onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {selectedCatalogItem ? 'Back' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
