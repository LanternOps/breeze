import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Package,
  X,
  Rocket,
  Plus,
  Trash2,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { Dialog } from '../shared/Dialog';
import DeploymentWizard from './DeploymentWizard';
import SoftwareVersionManager from './SoftwareVersionManager';
import AddPackageModal, { type CreatedPackage } from './AddPackageModal';
import { getProviderBranding, isIntegrationProvider, type IntegrationProvider } from './providerBranding';
import { useEdrReadiness, type EdrReadiness } from './useEdrReadiness';
import BuiltinPackageDetail from './BuiltinPackageDetail';

type SoftwareItem = {
  id: string;
  /** Owning org for an org-scoped (non-built-in) package; unset for partner-scoped built-ins. */
  orgId?: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  createdAt: string;
  /** Set for built-in integration packages (e.g. Huntress, SentinelOne). */
  integrationProvider?: IntegrationProvider;
  partnerId?: string;
  /** Number of uploaded versions; built-in S1 needs >=1 before it can deploy. */
  versionCount?: number;
};

/**
 * A built-in package whose installer binary must be uploaded before it can deploy
 * (SentinelOne ships no derivable download URL — the partner uploads the MSI once).
 */
const needsInstallerUpload = (item: SoftwareItem): boolean =>
  item.integrationProvider === 'sentinelone' && (item.versionCount ?? 0) === 0;

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

/** Small at-a-glance readiness chip for a built-in EDR card. */
function ReadinessPill({ status }: { status: EdrReadiness['status'] }) {
  if (status === 'ready')
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        Ready
      </span>
    );
  if (status === 'incomplete')
    return (
      <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        Setup needed
      </span>
    );
  if (status === 'loading') return <span className="text-xs text-muted-foreground">Checking…</span>;
  return null;
}

export default function SoftwareCatalog() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [selectedSoftware, setSelectedSoftware] = useState<SoftwareItem | null>(null);
  const [showDeployWizard, setShowDeployWizard] = useState(false);
  const [deployCatalogId, setDeployCatalogId] = useState<string | undefined>();
  const [showAddModal, setShowAddModal] = useState(false);
  const [detailTab, setDetailTab] = useState<'details' | 'versions'>('details');
  const [catalogItems, setCatalogItems] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<SoftwareItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openDeploy = (catalogId?: string) => {
    setDeployCatalogId(catalogId);
    setShowDeployWizard(true);
  };

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
          orgId: item.orgId ? String(item.orgId) : undefined,
          name: String(item.name ?? ''),
          vendor: String(item.vendor ?? ''),
          category: String(item.category ?? 'utility'),
          description: String(item.description ?? ''),
          createdAt: String(item.createdAt ?? ''),
          integrationProvider: item.integrationProvider === 'huntress' || item.integrationProvider === 'sentinelone'
            ? item.integrationProvider
            : undefined,
          partnerId: item.partnerId ? String(item.partnerId) : undefined,
          versionCount: item.versionCount != null ? Number(item.versionCount) : undefined,
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

  // Built-in EDR readiness: one fetch per present provider (there's one
  // integration per partner), shared by the cards and the detail panel.
  const builtinProviders = useMemo(
    () => Array.from(new Set(catalogItems.map(i => i.integrationProvider).filter(isIntegrationProvider))),
    [catalogItems],
  );
  const s1VersionCount = useMemo(
    () => catalogItems.find(i => i.integrationProvider === 'sentinelone')?.versionCount ?? 0,
    [catalogItems],
  );
  const readinessMap = useEdrReadiness(builtinProviders, { s1VersionCount });

  const handleCreated = (pkg: CreatedPackage) => {
    setCatalogItems(prev => [
      {
        id: pkg.id,
        name: pkg.name,
        vendor: pkg.vendor,
        category: pkg.category,
        description: pkg.description,
        createdAt: pkg.createdAt,
        versionCount: pkg.versionCount,
      },
      ...prev,
    ]);
    setShowAddModal(false);
  };

  const handleDeletePackage = async (item: SoftwareItem) => {
    try {
      setDeleting(true);
      // Scope the DELETE to the package's own org. fetchWithAuth only auto-injects
      // an orgId when one is actively selected in the org switcher, so a
      // partner/system user in "All organizations" mode would otherwise send no
      // orgId and hit "orgId is required for this scope" (resolveScopedOrgId).
      const deleteUrl = item.orgId
        ? `/software/catalog/${item.id}?orgId=${item.orgId}`
        : `/software/catalog/${item.id}`;
      await runAction({
        request: () => fetchWithAuth(deleteUrl, { method: 'DELETE' }),
        errorFallback: 'Failed to delete package',
        successMessage: `Deleted "${item.name}"`,
      });
      setCatalogItems(prev => prev.filter(i => i.id !== item.id));
      setConfirmDelete(null);
      setSelectedSoftware(prev => (prev?.id === item.id ? null : prev));
    } catch (err) {
      handleActionError(err, 'Failed to delete package');
    } finally {
      setDeleting(false);
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
          <h1 className="text-xl font-semibold tracking-tight">Software Library</h1>
          <p className="text-sm text-muted-foreground">Browse and deploy approved software packages.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Package
          </button>
          <button
            type="button"
            onClick={() => openDeploy(undefined)}
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
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={category}
          onChange={event => setCategory(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
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
              className="group rounded-lg border bg-card p-5 shadow-xs transition hover:-translate-y-1 hover:shadow-md"
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
                  {isIntegrationProvider(item.integrationProvider) ? (() => {
                    const branding = getProviderBranding(item.integrationProvider);
                    const Icon = branding.icon;
                    return (
                      <div className={cn('flex h-10 w-10 items-center justify-center rounded-md border', branding.accent)}>
                        <Icon className="h-5 w-5" />
                      </div>
                    );
                  })() : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                      <Package className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-semibold">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.vendor || 'Unknown vendor'}</p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  {isIntegrationProvider(item.integrationProvider) && (
                    <div className="flex items-center gap-1.5">
                      <ReadinessPill status={readinessMap[item.integrationProvider].status} />
                      <span className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        getProviderBranding(item.integrationProvider).accent,
                      )}>
                        Built-in
                      </span>
                    </div>
                  )}
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
              </div>

              {item.description && (
                <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{item.description}</p>
              )}

              <div className="mt-4 flex items-center justify-between gap-2">
                {needsInstallerUpload(item) ? (
                  <p className="text-xs text-muted-foreground">Upload installer to enable deploy</p>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  disabled={needsInstallerUpload(item)}
                  title={
                    needsInstallerUpload(item)
                      ? 'Upload the SentinelOne installer (Versions tab) to enable deploy'
                      : item.integrationProvider
                        ? 'Deploys to mapped organizations only'
                        : undefined
                  }
                  onClick={event => {
                    event.stopPropagation();
                    openDeploy(item.id);
                  }}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
        <Dialog
          open={!!selectedSoftware}
          onClose={() => setSelectedSoftware(null)}
          title={selectedSoftware.name}
          labelledBy="software-detail-title"
          maxWidth="4xl"
          alignTop
          className="flex max-h-[90vh] flex-col"
        >
          {/* Sticky header: identity + tabs + close */}
          <div className="border-b px-6 pt-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
                  <Package className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <h2 id="software-detail-title" className="text-lg font-semibold">{selectedSoftware.name}</h2>
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
                aria-label="Close"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-1">
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
          </div>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {detailTab === 'details' && (
              isIntegrationProvider(selectedSoftware.integrationProvider) ? (
                <BuiltinPackageDetail
                  name={selectedSoftware.name}
                  provider={selectedSoftware.integrationProvider}
                  readiness={readinessMap[selectedSoftware.integrationProvider]}
                  onDeploy={() => {
                    const id = selectedSoftware.id;
                    setSelectedSoftware(null);
                    openDeploy(id);
                  }}
                />
              ) : (
                <div>
                  {selectedSoftware.description && (
                    <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                      {selectedSoftware.description}
                    </div>
                  )}
                  <div className="mt-5 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(selectedSoftware)}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-destructive/40 bg-background px-4 text-sm font-medium text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const id = selectedSoftware.id;
                        setSelectedSoftware(null);
                        openDeploy(id);
                      }}
                      className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      Deploy
                    </button>
                  </div>
                </div>
              )
            )}

            {detailTab === 'versions' && (
              <SoftwareVersionManager catalogId={selectedSoftware.id} embedded />
            )}
          </div>
        </Dialog>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <Dialog
          open={!!confirmDelete}
          onClose={() => (deleting ? undefined : setConfirmDelete(null))}
          title="Delete package?"
          labelledBy="delete-package-title"
          maxWidth="md"
          className="p-6"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <h2 id="delete-package-title" className="text-lg font-semibold">Delete package?</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                This removes <span className="font-medium text-foreground">{confirmDelete.name}</span> from
                the software library, along with all of its versions and stored installer references. This
                cannot be undone.
              </p>
            </div>
          </div>
          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              disabled={deleting}
              className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleDeletePackage(confirmDelete)}
              disabled={deleting}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-destructive px-4 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </Dialog>
      )}

      <AddPackageModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={handleCreated}
      />

      {showDeployWizard && (
        <Dialog
          open={showDeployWizard}
          onClose={() => setShowDeployWizard(false)}
          title="Software deployment"
          labelledBy="deploy-wizard-title"
          maxWidth="4xl"
          alignTop
          className="flex max-h-[90vh] flex-col"
        >
          <div className="flex items-center justify-between border-b px-6 py-4">
            <h2 id="deploy-wizard-title" className="text-lg font-semibold">
              {deployCatalogId ? 'Deploy Software' : 'Bulk Software Deployment'}
            </h2>
            <button
              type="button"
              onClick={() => setShowDeployWizard(false)}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <DeploymentWizard initialCatalogId={deployCatalogId} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
