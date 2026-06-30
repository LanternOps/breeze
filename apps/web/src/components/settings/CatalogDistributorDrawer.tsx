import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { ecExpressImport, type EcProduct } from '../../lib/api/distributors';
import type { CatalogItem } from '../../lib/api/catalog';
import DistributorLookup from '../billing/quotes/DistributorLookup';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import with the new catalog item, so the host can
   *  reload its list and/or pre-fill a line from the imported item. */
  onImported: (item: CatalogItem) => void;
}

/**
 * Modal that brings the quote editor's TD SYNNEX EC Express lookup into the
 * catalog itself, so distributor items can be added to the catalog directly
 * (the import endpoint already existed; only the catalog entry point was
 * missing). Imports run the same best-effort AI enrichment as the quote flow
 * (aiCleanup), so the saved item gets a clean, readable name + a real,
 * web-sourced technical description rather than the raw distributor title.
 */
export default function CatalogDistributorDrawer({ open, onClose, onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  }, [open, onClose, busy]);

  const importAdd = useCallback((product: EcProduct, sellPrice: number) => {
    void (async () => {
      setBusy(true);
      try {
        const saved = await runAction<CatalogItem>({
          request: () => ecExpressImport({
            product,
            item: {
              name: product.name,
              sku: product.synnexSku || product.mfgPartNo || null,
              description: product.description ?? null,
              unitPrice: sellPrice,
              costBasis: product.cost != null && Number.isFinite(product.cost) ? Number(product.cost.toFixed(2)) : null,
            },
            // Tidy the raw distributor title into a readable name + description
            // server-side (best-effort; falls back to the raw values).
            aiCleanup: true,
          }),
          errorFallback: 'Could not import the distributor item.',
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
        // We always request aiCleanup; if the server couldn't run it (budget,
        // rate limit, timeout) it stores aiEnriched:false and keeps the raw
        // title — tell the user rather than imply the AI tidied it.
        const aiEnriched = (saved as { attributes?: { distributor?: { aiEnriched?: boolean } } })
          .attributes?.distributor?.aiEnriched === true;
        showToast(aiEnriched
          ? { message: `Imported "${saved.name}" to the catalog`, type: 'success' }
          : { message: `Imported "${saved.name}" — AI clean-up was unavailable, kept the original title.`, type: 'warning' });
        onImported(saved);
        onClose();
      } catch (err) {
        handleActionError(err, 'Could not import the distributor item.');
      } finally {
        setBusy(false);
      }
    })();
  }, [onImported, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      data-testid="catalog-distributor-modal"
    >
      <div ref={panelRef} className="mt-8 w-full max-w-2xl rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Import from TD SYNNEX</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Search EC Express by SKU or mfg part #, set your sell price, and add it to the catalog. AI fills in a clean name and a technical description for you.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
            data-testid="catalog-distributor-close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="p-5">
          <DistributorLookup blockId="catalog-import" busy={busy} onImportAdd={importAdd} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
