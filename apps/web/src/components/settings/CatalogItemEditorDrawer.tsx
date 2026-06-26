import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext, getJwtClaims } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { useOrgStore } from '@/stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';
import {
  createCatalogItem, updateCatalogItem, getCatalogItem, setBundleComponents,
  setOrgPriceOverride, removeOrgPriceOverride,
  uploadCatalogItemImage, importCatalogItemImageFromUrl, catalogItemImagePath, deleteCatalogItemImageRequest,
  computeMargin, formatMargin, marginTone,
  CATALOG_TYPE_LABELS, CATALOG_TYPE_ORDER,
  type CatalogItem, type CatalogItemType, type CatalogItemDetail, type OrgPriceOverride,
  type EnrichResult, type EnrichmentProvenance,
} from '../../lib/api/catalog';
import CatalogEnrichButton from '../catalog/CatalogEnrichButton';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// A bundle component as edited in the form (quantity kept as a string for free typing).
interface ComponentDraft {
  componentItemId: string;
  quantity: string;
  showOnInvoice: boolean;
}

interface Props {
  open: boolean;
  /** The item being edited, or null to create a new one. */
  item: CatalogItem | null;
  /** Active catalog items, used to populate the bundle component picker. */
  allItems: CatalogItem[];
  onClose: () => void;
  /** Called after a fully-successful save (item + components) so the host reloads. */
  onSaved: () => void;
}

/** Map a server bundle error code to a short user-facing message. */
function bundleFriendly(code: string): string | undefined {
  switch (code) {
    case 'BUNDLE_NESTED': return 'A bundle component cannot itself be a bundle.';
    case 'BUNDLE_SELF_REFERENCE': return 'A bundle cannot contain itself.';
    case 'BUNDLE_CROSS_PARTNER': return 'Components must belong to your catalog.';
    case 'BUNDLE_COMPONENT_NOT_FOUND': return 'One or more components no longer exist.';
    case 'BUNDLE_DUPLICATE_COMPONENT': return 'Each component can only be added once.';
    case 'NOT_A_BUNDLE': return 'This item is not a bundle.';
    default: return undefined;
  }
}

export default function CatalogItemEditorDrawer({ open, item, allItems, onClose, onSaved }: Props) {
  const editId = item?.id ?? null;

  const { can } = usePermissions();
  const canWrite = can('catalog', 'write');
  // Per-org overrides are a partner surface (an MSP pricing a customer). Detect
  // partner scope from the JWT claims — useOrgStore().partners is only populated
  // from a system-scope-only endpoint, so a real partner-scope user gets an empty
  // array and the section would never render (#1368).
  const { organizations } = useOrgStore();
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerScope = jwtScope === 'partner' && !!jwtPartnerId;

  const [itemType, setItemType] = useState<CatalogItemType>('service');
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [isBundle, setIsBundle] = useState(false);
  const [components, setComponents] = useState<ComponentDraft[]>([]);
  const [componentsLoading, setComponentsLoading] = useState(false);
  // True when the detail load (components + overrides) failed for an existing
  // item. Empty `components` is then "we couldn't load them", NOT "this item has
  // none" — so the bundle save path must be blocked to avoid wiping the bundle.
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // Per-org price overrides (#1368). Loaded for an existing item and edited as a
  // sub-resource — each set/remove applies immediately (the item already exists),
  // independent of the main Save.
  const [overrides, setOverrides] = useState<OrgPriceOverride[]>([]);
  const [newOverrideOrgId, setNewOverrideOrgId] = useState('');
  const [newOverridePrice, setNewOverridePrice] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  // Once a *new* item is created we hold its id, so a retry after a partial
  // failure (item saved, components failed) PATCHes instead of creating a dupe.
  const [committedId, setCommittedId] = useState<string | null>(null);
  // AI-enrichment provenance, stashed when the user auto-fills a NEW item and
  // persisted under attributes.enrichment on create. Null for plain/edited items.
  const [enrichment, setEnrichment] = useState<EnrichmentProvenance | null>(null);
  const effectiveId = editId ?? committedId;

  // Product image (one per item; manual upload, shown on quotes). Only available
  // once the item is persisted (effectiveId). `imageVersion` bumps to refetch the
  // preview after an upload/remove.
  const [imageBusy, setImageBusy] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [imageUrl, setImageUrl] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = useId();

  // ---- hydrate form when opened -------------------------------------------
  useEffect(() => {
    if (!open) return;
    setCommittedId(null);
    setSaving(false);
    setEnrichment(null);
    setOverrides([]);
    setNewOverrideOrgId('');
    setNewOverridePrice('');
    setDetailLoadFailed(false);
    if (item) {
      setItemType(item.itemType);
      setName(item.name);
      setSku(item.sku ?? '');
      setUnitPrice(item.unitPrice);
      setCostBasis(item.costBasis ?? '');
      setIsBundle(item.isBundle);
      setComponents([]);
      // Existing items carry sub-resources (bundle components + per-org price
      // overrides) — load the detail once and hydrate both.
      setComponentsLoading(item.isBundle);
      const failDetailLoad = () => {
        // The detail load is load-bearing: it drives what the bundle save writes
        // back. Surfacing the failure (and flagging it) prevents a silent "empty
        // bundle" that a save would persist as zero components (#1944). Contrast
        // QuoteEditor's loadEcStatus, where `if (!res.ok) return` is intentional
        // optional context.
        setDetailLoadFailed(true);
        showToast({
          message: 'Could not load this item’s components and pricing. Reopen to retry before saving.',
          type: 'error',
        });
      };
      void getCatalogItem(item.id)
        .then(async (res) => {
          if (res.status === 401) return UNAUTHORIZED();
          if (!res.ok) return failDetailLoad();
          const body = (await res.json().catch(() => null)) as { data?: CatalogItemDetail } | null;
          if (!body?.data) return failDetailLoad();
          const rows = body.data.components ?? [];
          setComponents(rows.map((r) => ({
            componentItemId: r.componentItemId,
            quantity: r.quantity,
            showOnInvoice: r.showOnInvoice,
          })));
          setOverrides(body.data.overrides ?? []);
        })
        .catch(() => failDetailLoad())
        .finally(() => setComponentsLoading(false));
    } else {
      setItemType('service');
      setName('');
      setSku('');
      setUnitPrice('');
      setCostBasis('');
      setIsBundle(false);
      setComponents([]);
    }
  }, [open, item]);

  // ---- a11y: focus, scroll-lock, escape, focus-trap -----------------------
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    });
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = '';
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key === 'Tab' && panelRef.current) {
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, [onClose]);

  const handleBackdropClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !saving) onClose();
  }, [onClose, saving]);

  // ---- bundle component editing -------------------------------------------
  const selectedIds = useMemo(() => new Set(components.map((c) => c.componentItemId)), [components]);

  // Items eligible to add as a component: active, not a bundle, not this item.
  const eligible = useMemo(
    () => allItems.filter((i) => i.isActive && !i.isBundle && i.id !== effectiveId),
    [allItems, effectiveId],
  );

  const itemName = useCallback(
    (id: string) => allItems.find((i) => i.id === id)?.name ?? 'Unknown item',
    [allItems],
  );

  const addComponent = () => setComponents((cs) => [...cs, { componentItemId: '', quantity: '1', showOnInvoice: false }]);
  const removeComponent = (idx: number) => setComponents((cs) => cs.filter((_, i) => i !== idx));
  const patchComponent = (idx: number, patch: Partial<ComponentDraft>) =>
    setComponents((cs) => cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  // ---- per-org price overrides (#1368) ------------------------------------
  const orgNameFor = useCallback(
    (orgId: string) => organizations.find((o) => o.id === orgId)?.name ?? orgId,
    [organizations],
  );
  const overriddenOrgIds = useMemo(() => new Set(overrides.map((o) => o.orgId)), [overrides]);
  const orgsWithoutOverride = useMemo(
    () => organizations.filter((o) => !overriddenOrgIds.has(o.id)),
    [organizations, overriddenOrgIds],
  );
  // Org pricing only applies to a persisted, non-bundle item (a bundle's price
  // derives from its components), for a partner-scope user who can write.
  const showOrgPricing = !!effectiveId && !isBundle && isPartnerScope && canWrite;

  const addOverride = useCallback(async () => {
    if (overrideBusy || !effectiveId) return;
    if (!newOverrideOrgId) { showToast({ message: 'Pick an organization.', type: 'error' }); return; }
    const price = Number(newOverridePrice);
    if (newOverridePrice.trim() === '' || !Number.isFinite(price) || price < 0) {
      showToast({ message: 'Enter a valid override price.', type: 'error' });
      return;
    }
    setOverrideBusy(true);
    try {
      const saved = await runAction<{ data: OrgPriceOverride }>({
        request: () => setOrgPriceOverride(effectiveId, newOverrideOrgId, price),
        errorFallback: 'Could not set the override. Retry.',
        successMessage: 'Override saved',
        onUnauthorized: UNAUTHORIZED,
      });
      setOverrides((cur) => [...cur.filter((o) => o.orgId !== newOverrideOrgId), saved.data]);
      setNewOverrideOrgId('');
      setNewOverridePrice('');
    } catch (err) {
      handleActionError(err, 'Could not set the override. Retry.');
    } finally {
      setOverrideBusy(false);
    }
  }, [overrideBusy, effectiveId, newOverrideOrgId, newOverridePrice]);

  const deleteOverride = useCallback(async (orgId: string) => {
    if (overrideBusy || !effectiveId) return;
    setOverrideBusy(true);
    try {
      await runAction({
        request: () => removeOrgPriceOverride(effectiveId, orgId),
        errorFallback: 'Could not remove the override. Retry.',
        successMessage: 'Override removed',
        onUnauthorized: UNAUTHORIZED,
      });
      setOverrides((cur) => cur.filter((o) => o.orgId !== orgId));
    } catch (err) {
      handleActionError(err, 'Could not remove the override. Retry.');
    } finally {
      setOverrideBusy(false);
    }
  }, [overrideBusy, effectiveId]);

  // ---- product image (#5) --------------------------------------------------
  const uploadImage = useCallback(async (file: File) => {
    if (!effectiveId || imageBusy) return;
    setImageBusy(true);
    try {
      await runAction({
        request: () => uploadCatalogItemImage(effectiveId, file),
        errorFallback: 'Could not upload the image. Retry.',
        successMessage: 'Image uploaded',
        onUnauthorized: UNAUTHORIZED,
      });
      setImageVersion((v) => v + 1);
    } catch (err) {
      handleActionError(err, 'Could not upload the image. Retry.');
    } finally {
      setImageBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }, [effectiveId, imageBusy]);

  const importFromUrl = useCallback(async () => {
    if (!effectiveId || imageBusy) return;
    const url = imageUrl.trim();
    if (!url) { showToast({ message: 'Enter an image URL.', type: 'error' }); return; }
    setImageBusy(true);
    try {
      await runAction({
        request: () => importCatalogItemImageFromUrl(effectiveId, url),
        errorFallback: 'Could not import the image from that URL. Retry.',
        successMessage: 'Image imported',
        onUnauthorized: UNAUTHORIZED,
      });
      setImageVersion((v) => v + 1);
      setImageUrl('');
    } catch (err) {
      handleActionError(err, 'Could not import the image from that URL. Retry.');
    } finally {
      setImageBusy(false);
    }
  }, [effectiveId, imageBusy, imageUrl]);

  const removeImage = useCallback(async () => {
    if (!effectiveId || imageBusy) return;
    setImageBusy(true);
    try {
      await runAction({
        request: () => deleteCatalogItemImageRequest(effectiveId),
        errorFallback: 'Could not remove the image. Retry.',
        successMessage: 'Image removed',
        onUnauthorized: UNAUTHORIZED,
      });
      setImageVersion((v) => v + 1);
    } catch (err) {
      handleActionError(err, 'Could not remove the image. Retry.');
    } finally {
      setImageBusy(false);
    }
  }, [effectiveId, imageBusy]);

  // ---- save ----------------------------------------------------------------
  const priceNum = Number(unitPrice);
  const priceValid = unitPrice.trim() !== '' && Number.isFinite(priceNum);
  const marginPreview = computeMargin(unitPrice, costBasis);
  // Block saving a bundle whose components never loaded — an empty save would
  // wipe the real components (#1944).
  const canSave = !saving && name.trim() !== '' && priceValid && !(isBundle && detailLoadFailed);

  const save = useCallback(async () => {
    if (saving) return;
    if (!name.trim()) { showToast({ message: 'Enter an item name.', type: 'error' }); return; }
    if (!priceValid) { showToast({ message: 'Enter a valid unit price.', type: 'error' }); return; }
    // If the detail load failed, our `components` state is unknown — not empty.
    // Saving a bundle would overwrite its real components with this stale/empty
    // set, wiping the bundle (#1944). Block until the user reopens and reloads.
    if (isBundle && detailLoadFailed) {
      showToast({
        message: 'This bundle’s components could not be loaded. Reopen the item to retry before saving.',
        type: 'error',
      });
      return;
    }

    const comps = isBundle ? components : [];
    for (const c of comps) {
      if (!c.componentItemId) { showToast({ message: 'Pick an item for every bundle component.', type: 'error' }); return; }
      const q = Number(c.quantity);
      if (c.quantity.trim() === '' || !Number.isFinite(q) || q <= 0) {
        showToast({ message: 'Component quantity must be greater than 0.', type: 'error' });
        return;
      }
    }

    const body = {
      itemType,
      name: name.trim(),
      sku: sku.trim() || null,
      unitPrice: priceNum,
      costBasis: costBasis.trim() ? Number(costBasis) : null,
      isBundle,
      // Persist AI provenance only for auto-filled new items (enrichment resets
      // to null when the drawer opens for an existing item). A bundle-retry PATCH
      // may still carry it, which is fine — the item was just created this session.
      ...(enrichment ? { attributes: { enrichment } } : {}),
    };

    setSaving(true);
    try {
      const targetId = effectiveId;
      const saved = await runAction<{ data: CatalogItem }>({
        request: () => (targetId ? updateCatalogItem(targetId, body) : createCatalogItem(body)),
        errorFallback: targetId ? 'Update failed. Retry.' : 'Item creation failed. Retry.',
        onUnauthorized: UNAUTHORIZED,
      });
      const savedId = saved.data.id;
      // Remember the id so a component-step retry edits rather than re-creates.
      if (!editId) setCommittedId(savedId);

      if (isBundle) {
        await runAction({
          request: () => setBundleComponents(savedId, comps.map((c) => ({
            componentItemId: c.componentItemId,
            quantity: Number(c.quantity),
            showOnInvoice: c.showOnInvoice,
          }))),
          errorFallback: 'Bundle components could not be saved. Retry.',
          friendly: bundleFriendly,
          onUnauthorized: UNAUTHORIZED,
        });
      }

      showToast({ message: editId ? 'Item updated' : `Item "${body.name}" created`, type: 'success' });
      onSaved();
      onClose();
    } catch (err) {
      handleActionError(err, 'Save failed. Retry.');
    } finally {
      setSaving(false);
    }
  }, [saving, name, priceValid, isBundle, detailLoadFailed, components, itemType, sku, priceNum, costBasis, enrichment, effectiveId, editId, onSaved, onClose]);

  // Auto-fill a NEW item from the web: fill the fields this form actually edits
  // (name + type) and stash provenance. Price is never auto-set — the button shows
  // a guidance hint and the user enters the real price.
  const applyEnrichment = useCallback((result: EnrichResult) => {
    setName(result.draft.name);
    setItemType(result.draft.itemType);
    setEnrichment(result.provenance);
  }, []);

  if (!open || typeof document === 'undefined') return null;

  const fieldCls = 'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex justify-end bg-background/80"
      style={{ animation: 'dialog-backdrop-in 150ms ease-out' }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      data-testid="catalog-editor-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="drawer-panel flex h-full w-full max-w-md flex-col border-l bg-card shadow-xl focus:outline-none"
        style={{ animation: 'slide-in-from-right 220ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        data-testid="catalog-item-editor"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold">
            {editId ? 'Edit item' : 'New item'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
            data-testid="catalog-form-close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body (scrolls) */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {/* AI auto-fill — new items only */}
          {!editId && canWrite && (
            <div className="rounded-md border border-dashed p-3" data-testid="catalog-form-enrich">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Auto-fill a new item from the web</p>
              <CatalogEnrichButton idSuffix="drawer" hint={itemType} onApply={applyEnrichment} />
            </div>
          )}
          {/* Type — segmented */}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Type</span>
            <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label="Item type">
              {CATALOG_TYPE_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setItemType(t)}
                  aria-pressed={itemType === t}
                  className={`rounded px-2 py-1.5 text-sm font-medium transition ${
                    itemType === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  data-testid={`catalog-form-type-${t}`}
                >
                  {CATALOG_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="catalog-form-name-input">Name</label>
            <input
              id="catalog-form-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldCls}
              placeholder="e.g. Managed Workstation"
              data-testid="catalog-form-name"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="catalog-form-sku-input">SKU <span className="font-normal opacity-70">(optional)</span></label>
            <input
              id="catalog-form-sku-input"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className={`${fieldCls} font-mono`}
              placeholder="SKU-001"
              data-testid="catalog-form-sku"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="catalog-form-price-input">Unit price</label>
              <input
                id="catalog-form-price-input"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                inputMode="decimal"
                className={`${fieldCls} text-right tabular-nums`}
                placeholder="0.00"
                data-testid="catalog-form-price"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="catalog-form-cost-input">Cost basis <span className="font-normal opacity-70">(optional)</span></label>
              <input
                id="catalog-form-cost-input"
                value={costBasis}
                onChange={(e) => setCostBasis(e.target.value)}
                inputMode="decimal"
                className={`${fieldCls} text-right tabular-nums`}
                placeholder="0.00"
                data-testid="catalog-form-cost"
              />
            </div>
          </div>

          {/* Live margin preview */}
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="catalog-form-margin">
            <span className="text-muted-foreground">Margin</span>
            <span className={`font-medium tabular-nums ${marginTone(marginPreview)}`}>
              {marginPreview == null ? 'Add a cost basis to see margin' : formatMargin(marginPreview)}
            </span>
          </div>

          {/* Product image (#5) — manual upload, shown on quotes */}
          {canWrite && (
            <div className="space-y-2 rounded-md border p-3" data-testid="catalog-form-image">
              <span className="text-xs font-medium text-muted-foreground">Product image</span>
              {effectiveId ? (
                <>
                  <CatalogImagePreview itemId={effectiveId} version={imageVersion} />
                  <div className="flex items-center gap-2">
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={imageBusy}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }}
                      className="block w-full text-xs file:mr-2 file:rounded-md file:border file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium disabled:opacity-50"
                      data-testid="catalog-form-image-input"
                    />
                    <button
                      type="button"
                      onClick={() => void removeImage()}
                      disabled={imageBusy}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      data-testid="catalog-form-image-remove"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={imageUrl}
                      onChange={(e) => setImageUrl(e.target.value)}
                      disabled={imageBusy}
                      placeholder="https://example.com/product.png"
                      className={`${fieldCls} text-xs disabled:opacity-50`}
                      data-testid="catalog-form-image-url"
                    />
                    <button
                      type="button"
                      onClick={() => void importFromUrl()}
                      disabled={imageBusy || imageUrl.trim() === ''}
                      className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      data-testid="catalog-form-image-url-btn"
                    >
                      Import from URL
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">PNG, JPEG, or WebP up to 5 MB.</p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="catalog-form-image-hint">
                  Save the item first, then add a product image.
                </p>
              )}
            </div>
          )}

          {/* Bundle toggle */}
          <label className="flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={isBundle}
              onChange={(e) => setIsBundle(e.target.checked)}
              className="h-4 w-4"
              data-testid="catalog-form-bundle"
            />
            <span>
              <span className="font-medium">This item is a bundle</span>
              <span className="block text-xs text-muted-foreground">Groups other catalog items sold together.</span>
            </span>
          </label>

          {/* Bundle component builder */}
          {isBundle && (
            <div className="space-y-2 rounded-md border p-3" data-testid="catalog-bundle-builder">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Items included in this bundle</span>
                {canWrite && (
                  <button
                    type="button"
                    onClick={addComponent}
                    className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                    data-testid="catalog-bundle-add"
                  >
                    Add component
                  </button>
                )}
              </div>

              {componentsLoading ? (
                <p className="py-2 text-center text-xs text-muted-foreground">Loading components.</p>
              ) : detailLoadFailed ? (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive"
                  data-testid="catalog-bundle-load-error"
                >
                  Could not load this bundle’s components. Reopen the item to retry — saving now is disabled to avoid wiping the bundle.
                </p>
              ) : components.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground" data-testid="catalog-bundle-empty">
                  No components yet. Add the items this bundle includes.
                </p>
              ) : (
                <ul className="space-y-2">
                  {components.map((c, idx) => {
                    // Options: eligible items not already chosen, plus this row's own choice.
                    const opts = eligible.filter((e) => !selectedIds.has(e.id) || e.id === c.componentItemId);
                    return (
                      <li key={idx} className="space-y-1.5 rounded-md border bg-background p-2" data-testid={`catalog-bundle-row-${idx}`}>
                        <div className="flex items-center gap-2">
                          <select
                            value={c.componentItemId}
                            onChange={(e) => patchComponent(idx, { componentItemId: e.target.value })}
                            className="h-9 flex-1 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            data-testid={`catalog-bundle-item-${idx}`}
                          >
                            <option value="">Select item…</option>
                            {c.componentItemId && !opts.some((o) => o.id === c.componentItemId) && (
                              <option value={c.componentItemId}>{itemName(c.componentItemId)}</option>
                            )}
                            {opts.map((o) => (
                              <option key={o.id} value={o.id}>{o.name}</option>
                            ))}
                          </select>
                          <input
                            value={c.quantity}
                            onChange={(e) => patchComponent(idx, { quantity: e.target.value })}
                            inputMode="decimal"
                            aria-label="Quantity"
                            className="h-9 w-16 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                            data-testid={`catalog-bundle-qty-${idx}`}
                          />
                          {canWrite && (
                            <button
                              type="button"
                              onClick={() => removeComponent(idx)}
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                              aria-label="Remove component"
                              data-testid={`catalog-bundle-remove-${idx}`}
                            >
                              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 6h18M8 6V4h8v2m-9 0v14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </button>
                          )}
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={c.showOnInvoice}
                            onChange={(e) => patchComponent(idx, { showOnInvoice: e.target.checked })}
                            data-testid={`catalog-bundle-showoninvoice-${idx}`}
                          />
                          Show this line on the invoice
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Per-organization price overrides (#1368) */}
          {showOrgPricing && (
            <div className="space-y-2 rounded-md border p-3" data-testid="catalog-org-pricing">
              <span className="text-xs font-medium text-muted-foreground">Per-organization pricing</span>
              <p className="text-xs text-muted-foreground">
                Override the base unit price for a specific customer. Everyone else is billed the catalog price.
              </p>

              {overrides.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground" data-testid="catalog-org-pricing-empty">
                  No overrides — every organization is billed the base price.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {overrides.map((o) => (
                    <li
                      key={o.orgId}
                      className="flex items-center gap-2 rounded-md border bg-background p-2 text-sm"
                      data-testid={`catalog-override-row-${o.orgId}`}
                    >
                      <span className="flex-1 truncate">{orgNameFor(o.orgId)}</span>
                      <span className="tabular-nums" data-testid={`catalog-override-price-${o.orgId}`}>{o.unitPrice}</span>
                      <button
                        type="button"
                        onClick={() => void deleteOverride(o.orgId)}
                        disabled={overrideBusy}
                        aria-label={`Remove override for ${orgNameFor(o.orgId)}`}
                        data-testid={`catalog-override-remove-${o.orgId}`}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M8 6V4h8v2m-9 0v14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-2">
                <select
                  value={newOverrideOrgId}
                  onChange={(e) => setNewOverrideOrgId(e.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  data-testid="catalog-override-org"
                >
                  <option value="">Select organization…</option>
                  {orgsWithoutOverride.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                <input
                  value={newOverridePrice}
                  onChange={(e) => setNewOverridePrice(e.target.value)}
                  inputMode="decimal"
                  aria-label="Override price"
                  placeholder="0.00"
                  className="h-9 w-20 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                  data-testid="catalog-override-price-input"
                />
                <button
                  type="button"
                  onClick={() => void addOverride()}
                  disabled={overrideBusy || !newOverrideOrgId}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  data-testid="catalog-override-add"
                >
                  Set
                </button>
              </div>
              {organizations.length > 0 && orgsWithoutOverride.length === 0 && (
                <p className="text-center text-[11px] text-muted-foreground">All organizations have an override.</p>
              )}
            </div>
          )}
        </div>

        {/* Footer (sticky) */}
        <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            data-testid="catalog-form-cancel"
          >
            Cancel
          </button>
          {canWrite && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              data-testid="catalog-form-save"
            >
              {saving ? 'Saving…' : editId ? 'Save changes' : 'Create item'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Product-image preview. GET /catalog/:id/image needs the Bearer auth header, so a
// bare <img src> would 401 — fetchWithAuth → blob → object URL (mirrors
// QuoteImagePreview). 404 means the item simply has no image yet. `version` bumps
// to refetch after an upload/remove.
function CatalogImagePreview({ itemId, version }: { itemId: string; version: number }) {
  const [url, setUrl] = useState<string>();
  const [state, setState] = useState<'loading' | 'none' | 'error' | 'ok'>('loading');

  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;
    setState('loading');
    void (async () => {
      try {
        const res = await fetchWithAuth(catalogItemImagePath(itemId));
        if (res.status === 404) { if (!cancelled) setState('none'); return; }
        if (!res.ok) { if (!cancelled) setState('error'); return; }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = window.URL.createObjectURL(blob);
        setUrl(objectUrl);
        setState('ok');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; if (objectUrl) window.URL.revokeObjectURL(objectUrl); };
  }, [itemId, version]);

  if (state === 'loading') return <div className="h-32 w-full animate-pulse rounded border bg-muted" data-testid="catalog-image-loading" />;
  if (state === 'none') return <p className="rounded border border-dashed py-6 text-center text-xs text-muted-foreground" data-testid="catalog-image-empty">No image yet.</p>;
  if (state === 'error' || !url) return <p className="text-xs text-muted-foreground">Image preview unavailable.</p>;
  return <img src={url} alt="Product" className="max-h-40 rounded border" data-testid="catalog-image-preview" />;
}
