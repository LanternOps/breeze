import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Package,
  X,
  Rocket,
  Plus,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import DeploymentWizard from './DeploymentWizard';
import SoftwareVersionManager from './SoftwareVersionManager';

type SoftwareItem = {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  createdAt: string;
};

const categoryStyles: Record<string, string> = {
  browser: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  utility: 'bg-amber-500/20 text-amber-700 border-amber-500/40',
  developer: 'bg-purple-500/20 text-purple-700 border-purple-500/40',
  communication: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
  security: 'bg-red-500/20 text-red-700 border-red-500/40',
  productivity: 'bg-slate-500/20 text-slate-700 border-slate-500/40',
  compression: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  media: 'bg-pink-500/20 text-pink-700 border-pink-500/40',
};

export default function SoftwareCatalog() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [selectedSoftware, setSelectedSoftware] = useState<SoftwareItem | null>(null);
  const [showDeployWizard, setShowDeployWizard] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [detailTab, setDetailTab] = useState<'details' | 'versions'>('details');
  const [catalogItems, setCatalogItems] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [addForm, setAddForm] = useState({
    name: '',
    vendor: '',
    category: 'utility',
    description: ''
  });

  const fetchCatalog = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/software/catalog');
      if (!response.ok) throw new Error('Failed to fetch software catalog');

      const payload = await response.json();
      const data = payload.data ?? payload ?? [];
      if (Array.isArray(data)) {
        setCatalogItems(data.map((item: Record<string, unknown>) => ({
          id: String(item.id),
          name: String(item.name ?? ''),
          vendor: String(item.vendor ?? ''),
          category: String(item.category ?? 'utility'),
          description: String(item.description ?? ''),
          createdAt: String(item.createdAt ?? ''),
        })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const categories = useMemo(() => {
    const unique = new Set(catalogItems.map(item => item.category));
    return Array.from(unique);
  }, [catalogItems]);

  const filteredSoftware = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return catalogItems.filter(item => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.vendor.toLowerCase().includes(normalizedQuery);
      const matchesCategory = category === 'all' ? true : item.category === category;
      return matchesQuery && matchesCategory;
    });
  }, [query, category, catalogItems]);

  const handleAddPackage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!addForm.name.trim()) return;

    try {
      setSaving(true);
      const response = await fetchWithAuth('/software/catalog', {
        method: 'POST',
        body: JSON.stringify({
          name: addForm.name.trim(),
          vendor: addForm.vendor.trim() || undefined,
          category: addForm.category,
          description: addForm.description.trim() || undefined,
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error ?? 'Failed to create package');
      }

      const result = await response.json();
      const newItem = result.data ?? result;
      setCatalogItems(prev => [...prev, {
        id: String(newItem.id),
        name: String(newItem.name ?? ''),
        vendor: String(newItem.vendor ?? ''),
        category: String(newItem.category ?? 'utility'),
        description: String(newItem.description ?? ''),
        createdAt: String(newItem.createdAt ?? ''),
      }]);
      setAddForm({ name: '', vendor: '', category: 'utility', description: '' });
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add package');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading software catalog...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Software Catalog</h1>
          <p className="text-sm text-muted-foreground">Browse and deploy approved software packages.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Package
          </button>
          <button
            type="button"
            onClick={() => setShowDeployWizard(true)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Rocket className="h-4 w-4" />
            Bulk Deploy
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
          <button type="button" onClick={() => setError(undefined)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search software, vendor..."
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={category}
          onChange={event => setCategory(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
        >
          <option value="all">All Categories</option>
          {categories.map(item => (
            <option key={item} value={item}>
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {filteredSoftware.length === 0 && !loading ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <Package className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-sm text-muted-foreground">
            {catalogItems.length === 0
              ? 'No software packages yet. Add one to get started.'
              : 'No packages match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredSoftware.map(item => (
            <div
              key={item.id}
              className="group rounded-lg border bg-card p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-md"
              role="button"
              tabIndex={0}
              onClick={() => { setDetailTab('details'); setSelectedSoftware(item); }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setDetailTab('details');
                  setSelectedSoftware(item);
                }
              }}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                    <Package className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.vendor || 'Unknown vendor'}</p>
                  </div>
                </div>
                {item.category && (
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                      categoryStyles[item.category] ?? 'bg-muted text-muted-foreground'
                    )}
                  >
                    {item.category.charAt(0).toUpperCase() + item.category.slice(1)}
                  </span>
                )}
              </div>

              {item.description && (
                <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{item.description}</p>
              )}

              <div className="mt-4 flex items-center justify-end">
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    setShowDeployWizard(true);
                  }}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Deploy
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selectedSoftware && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
          <div className="w-full max-w-5xl rounded-lg border bg-card p-6 shadow-lg my-8">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
                  <Package className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">{selectedSoftware.name}</h2>
                  <p className="text-sm text-muted-foreground">{selectedSoftware.vendor || 'Unknown vendor'}</p>
                </div>
                {selectedSoftware.category && (
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                      categoryStyles[selectedSoftware.category] ?? 'bg-muted text-muted-foreground'
                    )}
                  >
                    {selectedSoftware.category.charAt(0).toUpperCase() + selectedSoftware.category.slice(1)}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedSoftware(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-1 border-b">
              <button
                type="button"
                onClick={() => setDetailTab('details')}
                className={cn(
                  'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                  detailTab === 'details'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                Details
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('versions')}
                className={cn(
                  'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                  detailTab === 'versions'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                Versions
              </button>
            </div>

            {detailTab === 'details' && (
              <div className="mt-4">
                {selectedSoftware.description && (
                  <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                    {selectedSoftware.description}
                  </div>
                )}
                <div className="mt-5 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSoftware(null);
                      setShowDeployWizard(true);
                    }}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Deploy
                  </button>
                </div>
              </div>
            )}

            {detailTab === 'versions' && (
              <div className="mt-4">
                <SoftwareVersionManager catalogId={selectedSoftware.id} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add Package modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Add Software Package</h2>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleAddPackage} className="space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase text-muted-foreground">Name</label>
                <input
                  type="text"
                  value={addForm.name}
                  onChange={e => setAddForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Google Chrome"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-muted-foreground">Vendor</label>
                <input
                  type="text"
                  value={addForm.vendor}
                  onChange={e => setAddForm(prev => ({ ...prev, vendor: e.target.value }))}
                  placeholder="e.g. Google"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-muted-foreground">Category</label>
                <select
                  value={addForm.category}
                  onChange={e => setAddForm(prev => ({ ...prev, category: e.target.value }))}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="browser">Browser</option>
                  <option value="utility">Utility</option>
                  <option value="compression">Compression</option>
                  <option value="productivity">Productivity</option>
                  <option value="communication">Communication</option>
                  <option value="developer">Developer</option>
                  <option value="media">Media</option>
                  <option value="security">Security</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-muted-foreground">Description</label>
                <textarea
                  value={addForm.description}
                  onChange={e => setAddForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of the software"
                  className="mt-2 min-h-[80px] w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !addForm.name.trim()}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? 'Creating...' : 'Create Package'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDeployWizard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-4xl rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Bulk Software Deployment</h2>
              <button
                type="button"
                onClick={() => setShowDeployWizard(false)}
                className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <DeploymentWizard />
          </div>
        </div>
      )}
    </div>
  );
}
