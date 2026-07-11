import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims, loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { formatMoney } from '../../lib/timeFormat';
import CatalogItemEditorDrawer from './CatalogItemEditorDrawer';
import CatalogDistributorDrawer from './CatalogDistributorDrawer';
import Pax8CatalogDrawer from './Pax8CatalogDrawer';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { ecExpressStatus, pax8Status } from '../../lib/api/distributors';
import {
  listCatalog, getCatalogItem, getBundleEconomics, archiveCatalogItem, updateCatalogItem,
  computeMargin, formatMargin, marginTone,
  CATALOG_TYPE_LABELS, CATALOG_TYPE_CHIP, CATALOG_TYPE_ORDER, CATALOG_PAGE_LIMIT,
  type CatalogItem, type CatalogItemType, type CatalogItemDetail,
  type BundleComponentRow, type BundleEconomics,
} from '../../lib/api/catalog';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type View = 'active' | 'archived';
type TypeFilter = 'all' | CatalogItemType;
type SortKey = 'name' | 'unitPrice' | 'margin';
interface Sort { key: SortKey; dir: 'asc' | 'desc' }

interface ExpandState {
  loading: boolean;
  failed: boolean;
  components: BundleComponentRow[];
  economics: BundleEconomics | null;
}

export default function CatalogItemsTab({ reloadKey = 0 }: { reloadKey?: number }) {
  const { t } = useTranslation('settings');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<View>('active');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [distributorOpen, setDistributorOpen] = useState(false);
  // TD SYNNEX EC Express import is only offered when the integration is set up;
  // mirrors the quote editor's ecActive gate (configured && enabled).
  const [ecActive, setEcActive] = useState(false);
  const [pax8Open, setPax8Open] = useState(false);
  const [pax8Active, setPax8Active] = useState(false);
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  // Archive is a soft-delete that pulls the item from active pickers — guard it
  // behind a confirm step (#1368) instead of acting on a single menu click.
  const [pendingArchive, setPendingArchive] = useState<CatalogItem | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ExpandState>>({});

  // Catalog routes enforce requireScope('partner','system') server-side. Mirror
  // that here so org-scope users get a clear message instead of a misleading
  // load error; only a confirmed 'organization' scope is blocked (a missing or
  // undecodable token falls through and the server re-checks).
  const isOrgScoped = getJwtClaims().scope === 'organization';

  const { can } = usePermissions();
  const canWrite = can('catalog', 'write');

  const load = useCallback(async (v: View) => {
    setLoading(true);
    setError(false);
    try {
      const res = await listCatalog({ isActive: v === 'active', limit: CATALOG_PAGE_LIMIT });
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) { setError(true); return; }
      const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
      setItems(body?.data ?? []);
      setExpanded({});
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(view); }, [load, view, reloadKey]);

  // Surface the distributor-import entry only when EC Express is connected.
  // Best-effort: any failure leaves it hidden (optional capability, not core).
  useEffect(() => {
    if (!canWrite) return;
    void (async () => {
      try {
        const res = await ecExpressStatus();
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
        setEcActive(Boolean(body?.data?.configured && body?.data?.enabled));
      } catch { /* leave hidden */ }
    })();
  }, [canWrite]);

  // Surface the Pax8 import entry only when the Pax8 integration is connected.
  useEffect(() => {
    if (!canWrite) return;
    void (async () => {
      try {
        const res = await pax8Status();
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
        setPax8Active(Boolean(body?.data?.configured && body?.data?.enabled));
      } catch { /* leave hidden */ }
    })();
  }, [canWrite]);

  const openCreate = () => { setEditItem(null); setDrawerOpen(true); };
  const openEdit = (it: CatalogItem) => { setEditItem(it); setDrawerOpen(true); };

  const archive = useCallback(async (id: string) => {
    if (archivingId) return;
    setArchivingId(id);
    try {
      await runAction({
        request: () => archiveCatalogItem(id),
        errorFallback: t('catalogItemsTab.archiveFailedRetry'),
        successMessage: t('catalogItemsTab.itemArchived'),
        onUnauthorized: UNAUTHORIZED,
      });
      void load(view);
    } catch (err) {
      handleActionError(err, 'Archive failed. Retry.');
    } finally {
      setArchivingId(null);
    }
  }, [load, view, archivingId]);

  const restore = useCallback(async (id: string) => {
    if (archivingId) return;
    setArchivingId(id);
    try {
      await runAction({
        request: () => updateCatalogItem(id, { isActive: true }),
        errorFallback: t('catalogItemsTab.restoreFailedRetry'),
        successMessage: t('catalogItemsTab.itemRestored'),
        onUnauthorized: UNAUTHORIZED,
      });
      void load(view);
    } catch (err) {
      handleActionError(err, 'Restore failed. Retry.');
    } finally {
      setArchivingId(null);
    }
  }, [load, view, archivingId]);

  const toggleExpand = useCallback((it: CatalogItem) => {
    setExpanded((prev) => {
      if (prev[it.id]) {
        const next = { ...prev };
        delete next[it.id];
        return next;
      }
      // Lazily fetch this bundle's components + rolled-up economics.
      void Promise.all([getCatalogItem(it.id), getBundleEconomics(it.id)])
        .then(async ([detailRes, econRes]) => {
          if (detailRes.status === 401 || econRes.status === 401) return UNAUTHORIZED();
          // The component list is the load-bearing read; a failure must NOT render
          // as "empty bundle" (that misrepresents contents). Economics is optional.
          if (!detailRes.ok) {
            setExpanded((p) => (p[it.id] ? { ...p, [it.id]: { loading: false, failed: true, components: [], economics: null } } : p));
            return;
          }
          const detail = ((await detailRes.json().catch(() => null)) as { data?: CatalogItemDetail } | null)?.data ?? null;
          const econ = econRes.ok
            ? ((await econRes.json().catch(() => null)) as { data?: BundleEconomics } | null)?.data ?? null
            : null;
          setExpanded((p) => (p[it.id]
            ? { ...p, [it.id]: { loading: false, failed: false, components: detail?.components ?? [], economics: econ } }
            : p));
        })
        .catch(() => setExpanded((p) => (p[it.id] ? { ...p, [it.id]: { loading: false, failed: true, components: [], economics: null } } : p)));
      return { ...prev, [it.id]: { loading: true, failed: false, components: [], economics: null } };
    });
  }, []);

  const itemName = useCallback(
    (id: string) => items.find((i) => i.id === id)?.name ?? t('catalogItemsTab.unknownItem'),
    [items, t],
  );

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // ---- derived rows: filter (type + search) then sort ---------------------
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = items.filter((it) => {
      if (typeFilter !== 'all' && it.itemType !== typeFilter) return false;
      if (q && !it.name.toLowerCase().includes(q) && !(it.sku ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      if (sort.key === 'name') return a.name.localeCompare(b.name) * dir;
      if (sort.key === 'unitPrice') return (Number(a.unitPrice) - Number(b.unitPrice)) * dir;
      // margin: nulls always sort to the bottom regardless of direction
      const ma = computeMargin(a.unitPrice, a.costBasis);
      const mb = computeMargin(b.unitPrice, b.costBasis);
      if (ma == null && mb == null) return 0;
      if (ma == null) return 1;
      if (mb == null) return -1;
      return (ma - mb) * dir;
    });
    return out;
  }, [items, typeFilter, search, sort]);

  const capHit = items.length >= CATALOG_PAGE_LIMIT;

  // ---- gated / empty-of-everything states ---------------------------------
  if (isOrgScoped) {
    return (
      <p className="rounded-lg border bg-card px-4 py-12 text-center text-sm text-muted-foreground" data-testid="catalog-items-org-scope">
        {t('catalogItemsTab.theProductCatalogIsAvailableToPartnerAccountsOnly')}</p>
    );
  }

  const SortHeader = ({ label, sortKey, align = 'left' }: { label: string; sortKey: SortKey; align?: 'left' | 'right' }) => (
    <th className={`px-3 py-3 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => toggleSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${align === 'right' ? 'flex-row-reverse' : ''}`}
        data-testid={`catalog-sort-${sortKey}`}
      >
        {label}
        <span className="text-[10px] leading-none">{sort.key === sortKey ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );

  return (
    <div className="space-y-4" data-testid="catalog-items-tab">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2" data-testid="catalog-toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('catalogItemsTab.searchNameOrSKU')}
          aria-label={t('catalogItemsTab.searchCatalog')}
          className="h-9 min-w-48 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          data-testid="catalog-search"
        />

        {/* Type filter — segmented */}
        <div className="flex items-center gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label={t('catalogItemsTab.filterByType')}>
          {(['all', ...CATALOG_TYPE_ORDER] as TypeFilter[]).map((catalogType) => (
            <button
              key={catalogType}
              type="button"
              onClick={() => setTypeFilter(catalogType)}
              aria-pressed={typeFilter === catalogType}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                typeFilter === catalogType ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
              data-testid={`catalog-filter-type-${catalogType}`}
            >
              {catalogType === 'all' ? t('catalogItemsTab.all') : CATALOG_TYPE_LABELS[catalogType]}
            </button>
          ))}
        </div>

        {/* Active / archived */}
        <div className="flex items-center gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label={t('catalogItemsTab.activeOrArchived')}>
          {(['active', 'archived'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition ${
                view === v ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
              data-testid={`catalog-view-${v}`}
            >
              {v}
            </button>
          ))}
        </div>

        {canWrite && ecActive && (
          <button
            type="button"
            onClick={() => setDistributorOpen(true)}
            className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
            data-testid="catalog-import-distributor"
          >
            {t('catalogItemsTab.importFromTDSYNNEX')}</button>
        )}

        {canWrite && pax8Active && (
          <button
            type="button"
            onClick={() => setPax8Open(true)}
            className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
            data-testid="catalog-import-pax8"
          >
            {t('catalogItemsTab.importFromPax8')}</button>
        )}

        {canWrite && (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            data-testid="catalog-add-item"
          >
            {t('catalogItemsTab.addItem')}</button>
        )}
      </div>

      {/* Table card */}
      <div className="rounded-lg border bg-card shadow-xs">
        {loading ? (
          <div className="divide-y" data-testid="catalog-items-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="px-4 py-12 text-center text-sm text-destructive" data-testid="catalog-items-error">
            {t('catalogItemsTab.catalogFailedToLoad')}<div>
              <button
                type="button"
                onClick={() => void load(view)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                data-testid="catalog-items-retry"
              >
                {t('catalogItemsTab.tryAgain')}</button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-14 text-center" data-testid="catalog-items-empty">
            {view === 'archived' ? (
              <p className="text-sm text-muted-foreground">{t('catalogItemsTab.noArchivedItems')}</p>
            ) : (
              <>
                <h3 className="text-sm font-semibold">{t('catalogItemsTab.buildYourCatalog')}</h3>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  {t('catalogItemsTab.addTheHardwareSoftwareAndServiceItemsYouSellCatalogItems')}</p>
                {canWrite && (
                  <button
                    type="button"
                    onClick={openCreate}
                    className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                    data-testid="catalog-empty-add"
                  >
                    {t('catalogItemsTab.addYourFirstItem')}</button>
                )}
              </>
            )}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="catalog-items-no-match">
            {t('catalogItemsTab.noItemsMatchTheseFilters')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="catalog-items-table">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <SortHeader label={t('catalogItemsTab.name')} sortKey="name" />
                  <th className="px-3 py-3 font-medium">{t('catalogItemsTab.type')}</th>
                  <th className="px-3 py-3 font-medium">{t('catalogItemsTab.sKU')}</th>
                  <SortHeader label={t('catalogItemsTab.unitPrice')} sortKey="unitPrice" align="right" />
                  <th className="px-3 py-3 text-right font-medium">{t('catalogItemsTab.cost')}</th>
                  <SortHeader label={t('catalogItemsTab.margin')} sortKey="margin" align="right" />
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => {
                  const margin = computeMargin(it.unitPrice, it.costBasis);
                  const exp = expanded[it.id];
                  const isOpen = !!exp;
                  return (
                    <FragmentRow key={it.id}>
                      <tr
                        className="cursor-pointer border-t transition hover:bg-muted/40"
                        data-testid={`catalog-item-row-${it.id}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => openEdit(it)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(it); }
                        }}
                      >
                        <td className="px-3 py-3 font-medium">
                          <span className="flex items-center gap-1.5">
                            {it.isBundle ? (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleExpand(it); }}
                                aria-expanded={isOpen}
                                aria-label={isOpen ? t('catalogItemsTab.collapseBundle') : t('catalogItemsTab.expandBundle')}
                                className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                data-testid={`catalog-bundle-toggle-${it.id}`}
                              >
                                <svg className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            ) : (
                              <span className="inline-block w-[18px]" />
                            )}
                            {it.name}
                            {it.isBundle && (
                              <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('catalogItemsTab.bundle')}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${CATALOG_TYPE_CHIP[it.itemType]}`}>
                            {CATALOG_TYPE_LABELS[it.itemType]}
                          </span>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{it.sku ?? '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatMoney(it.unitPrice)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{it.costBasis ? formatMoney(it.costBasis) : '—'}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${marginTone(margin)}`} data-testid={`catalog-margin-${it.id}`}>
                          {formatMargin(margin)}
                        </td>
                        <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          <RowActions
                            item={it}
                            view={view}
                            busy={archivingId === it.id}
                            disabled={archivingId !== null}
                            onEdit={() => openEdit(it)}
                            onArchive={() => setPendingArchive(it)}
                            onRestore={() => void restore(it.id)}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t bg-muted/20" data-testid={`catalog-bundle-detail-${it.id}`}>
                          <td colSpan={7} className="px-3 py-3">
                            {exp.loading ? (
                              <p className="pl-6 text-xs text-muted-foreground">{t('catalogItemsTab.loadingComponents')}</p>
                            ) : exp.failed ? (
                              <p className="pl-6 text-xs text-destructive">
                                {t('catalogItemsTab.couldnRsquoTLoadComponents')}{' '}
                                <button type="button" onClick={() => { toggleExpand(it); toggleExpand(it); }} className="underline hover:text-foreground">{t('catalogItemsTab.retry')}</button>
                              </p>
                            ) : exp.components.length === 0 ? (
                              <p className="pl-6 text-xs text-muted-foreground">{t('catalogItemsTab.thisBundleHasNoComponentsYet')}</p>
                            ) : (
                              <div className="pl-6">
                                <ul className="space-y-1">
                                  {exp.components.map((c) => (
                                    <li key={c.id} className="flex items-center gap-2 text-xs">
                                      <span className="tabular-nums text-muted-foreground">{Number(c.quantity)}×</span>
                                      <span>{itemName(c.componentItemId)}</span>
                                      {c.showOnInvoice && (
                                        <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                          {t('catalogItemsTab.onInvoice')}</span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                                {exp.economics && (
                                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
                                    <span>{t('catalogItemsTab.componentCost')}<span className="tabular-nums text-foreground">{formatMoney(exp.economics.totalCost)}</span></span>
                                    <span>{t('catalogItemsTab.bundleMargin')}<span className={`tabular-nums ${marginTone(exp.economics.marginPct)}`}>{formatMoney(exp.economics.margin)} ({formatMargin(exp.economics.marginPct)})</span></span>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {capHit && (
        <p className="text-xs text-muted-foreground" data-testid="catalog-cap-note">
          {t('catalogItemsTab.showingTheFirst')}{CATALOG_PAGE_LIMIT} {t('catalogItemsTab.itemsUseSearchToNarrowTheList')}</p>
      )}

      <CatalogItemEditorDrawer
        open={drawerOpen}
        item={editItem}
        allItems={items}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => void load(view)}
      />

      <CatalogDistributorDrawer
        open={distributorOpen}
        onClose={() => setDistributorOpen(false)}
        onImported={() => void load('active')}
      />

      <Pax8CatalogDrawer
        open={pax8Open}
        onClose={() => setPax8Open(false)}
        onImported={() => void load('active')}
      />

      <ConfirmDialog
        open={pendingArchive !== null}
        onClose={() => setPendingArchive(null)}
        onConfirm={() => {
          const target = pendingArchive;
          setPendingArchive(null);
          if (target) void archive(target.id);
        }}
        title={t('catalogItemsTab.archiveItem')}
        message={pendingArchive
          ? t('catalogItemsTab.archiveConfirm', { name: pendingArchive.name })
          : ''}
        confirmLabel="Archive"
        variant="destructive"
        isLoading={archivingId !== null && archivingId === pendingArchive?.id}
        confirmTestId="catalog-archive-confirm"
      />
    </div>
  );
}

// Tiny helper so a row + its expanded detail row share one key without a wrapper
// element (which would be invalid inside <tbody>).
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// Per-row overflow ("⋯") menu. The table scrolls horizontally (overflow-x-auto),
// which would clip an absolutely-positioned dropdown, so the menu is portalled to
// <body> and positioned with fixed coordinates from the trigger's rect.
function RowActions({
  item, view, busy, disabled, onEdit, onArchive, onRestore,
}: {
  item: CatalogItem;
  view: View;
  busy: boolean;
  disabled: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const { can } = usePermissions();
  const canWrite = can('catalog', 'write');
  const canDelete = can('catalog', 'delete');
  // Edit/Restore need write; Archive needs delete. View determines which of
  // archive/restore is even offered.
  const showEdit = canWrite;
  const showArchive = view === 'active' && canDelete;
  const showRestore = view === 'archived' && canWrite;

  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }, []);

  const openMenu = () => { place(); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Any scroll/resize invalidates the fixed coords — just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const itemCls = 'flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50';

  // Nothing actionable for this user → don't render an empty popover trigger.
  if (!showEdit && !showArchive && !showRestore) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={disabled && !busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={i18n.t('settings:catalogItemsTab.rowActions')}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        data-testid={`catalog-actions-${item.id}`}
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        )}
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 w-36 overflow-hidden rounded-md border bg-card py-1 shadow-lg"
          style={{ top: coords.top, right: coords.right }}
          data-testid={`catalog-actions-menu-${item.id}`}
        >
          {showEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onEdit(); }}
              className={itemCls}
              data-testid={`catalog-edit-${item.id}`}
            >
              {i18n.t('settings:catalogItemsTab.edit')}</button>
          )}
          {showArchive && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onArchive(); }}
              className={`${itemCls} text-destructive`}
              data-testid={`catalog-archive-${item.id}`}
            >
              {i18n.t('settings:catalogItemsTab.archive')}</button>
          )}
          {showRestore && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onRestore(); }}
              className={`${itemCls} text-primary`}
              data-testid={`catalog-restore-${item.id}`}
            >
              {i18n.t('settings:catalogItemsTab.restore')}</button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
