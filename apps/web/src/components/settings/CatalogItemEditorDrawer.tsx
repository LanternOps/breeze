import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import {
  createCatalogItem, updateCatalogItem, getCatalogItem, setBundleComponents,
  computeMargin, formatMargin, marginTone,
  CATALOG_TYPE_LABELS, CATALOG_TYPE_ORDER,
  type CatalogItem, type CatalogItemType, type CatalogItemDetail,
} from '../../lib/api/catalog';

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

  const [itemType, setItemType] = useState<CatalogItemType>('service');
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [isBundle, setIsBundle] = useState(false);
  const [components, setComponents] = useState<ComponentDraft[]>([]);
  const [componentsLoading, setComponentsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Once a *new* item is created we hold its id, so a retry after a partial
  // failure (item saved, components failed) PATCHes instead of creating a dupe.
  const [committedId, setCommittedId] = useState<string | null>(null);
  const effectiveId = editId ?? committedId;

  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = useId();

  // ---- hydrate form when opened -------------------------------------------
  useEffect(() => {
    if (!open) return;
    setCommittedId(null);
    setSaving(false);
    if (item) {
      setItemType(item.itemType);
      setName(item.name);
      setSku(item.sku ?? '');
      setUnitPrice(item.unitPrice);
      setCostBasis(item.costBasis ?? '');
      setIsBundle(item.isBundle);
      setComponents([]);
      if (item.isBundle) {
        setComponentsLoading(true);
        void getCatalogItem(item.id)
          .then(async (res) => {
            if (res.status === 401) return UNAUTHORIZED();
            if (!res.ok) return;
            const body = (await res.json().catch(() => null)) as { data?: CatalogItemDetail } | null;
            const rows = body?.data?.components ?? [];
            setComponents(rows.map((r) => ({
              componentItemId: r.componentItemId,
              quantity: r.quantity,
              showOnInvoice: r.showOnInvoice,
            })));
          })
          .finally(() => setComponentsLoading(false));
      }
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

  // ---- save ----------------------------------------------------------------
  const priceNum = Number(unitPrice);
  const priceValid = unitPrice.trim() !== '' && Number.isFinite(priceNum);
  const marginPreview = computeMargin(unitPrice, costBasis);
  const canSave = !saving && name.trim() !== '' && priceValid;

  const save = useCallback(async () => {
    if (saving) return;
    if (!name.trim()) { showToast({ message: 'Enter an item name.', type: 'error' }); return; }
    if (!priceValid) { showToast({ message: 'Enter a valid unit price.', type: 'error' }); return; }

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
  }, [saving, name, priceValid, isBundle, components, itemType, sku, priceNum, costBasis, effectiveId, editId, onSaved, onClose]);

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
