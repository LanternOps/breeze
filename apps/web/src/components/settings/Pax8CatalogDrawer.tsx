import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { pax8Import, type Pax8Product, type Pax8PriceOption } from '../../lib/api/distributors';
import type { CatalogItem } from '../../lib/api/catalog';
import Pax8ProductLookup from '../billing/quotes/Pax8ProductLookup';
import { feedCurrencyCode } from './marginMath';
import { usePartnerCurrency } from '../../lib/usePartnerCurrency';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (item: CatalogItem) => void;
}

export default function Pax8CatalogDrawer({ open, onClose, onImported }: Props) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // The sell price typed in the lookup is posted as a bare `unitPrice`, which
  // the API stores as the PARTNER-currency price-book row — so the lookup's
  // currency gate must be the partner currency (#3775 review #3). No 'USD'
  // fallback: while it is unresolved the lookup is not rendered at all.
  const { currency: partnerCurrency, failed: partnerCurrencyFailed, retry: retryPartnerCurrency } = usePartnerCurrency(open);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  }, [open, onClose, busy]);

  const importAdd = useCallback((product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => {
    void (async () => {
      setBusy(true);
      try {
        const saved = await runAction<CatalogItem>({
          request: () => pax8Import({
            product: {
              source: 'pax8',
              pax8ProductId: product.pax8ProductId,
              name: product.name,
              vendorName: product.vendorName,
              vendorSku: product.vendorSku,
              commitmentTerm: term.commitmentTerm,
              billingTerm: term.billingTerm,
              partnerBuyRate: term.partnerBuyRate,
              // Trimmed uppercase ISO or explicit null — never coerced to USD.
              currency: feedCurrencyCode(term.currencyCode),
              raw: product.raw,
            },
            item: {
              name: product.name.slice(0, 255),
              sku: product.vendorSku,
              description: product.shortDescription,
              unitPrice: sellPrice,
              costBasis: term.partnerBuyRate != null ? Number(term.partnerBuyRate) : null,
            },
            // Web-enrich the raw vendor listing into a clean name + technical
            // description on import (best-effort; falls back to raw on failure).
            aiCleanup: true,
          }),
          errorFallback: t('pax8CatalogDrawer.couldNotImportThePax8Product'),
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
        // aiCleanup is always requested; if the server couldn't run it it stores
        // pax8.aiEnriched:false and keeps the raw vendor name — surface that.
        const aiEnriched = (saved as { attributes?: { pax8?: { aiEnriched?: boolean } } })
          .attributes?.pax8?.aiEnriched === true;
        // #3775 review #3: re-importing a SKU already in the catalog no longer
        // overwrites a price-book row the partner may have hand-adjusted. Say
        // which currencies were left alone — a plain "Imported" would read as
        // "your sell price is now the Pax8 rate", which is exactly wrong.
        const preserved = (saved as { pricingApplied?: { preserved?: string[] } }).pricingApplied?.preserved ?? [];
        showToast(
          preserved.length > 0
            ? { message: t('pax8CatalogDrawer.importedPricePreserved', { name: saved.name, currencies: preserved.join(', ') }), type: 'warning' }
            : aiEnriched
              ? { message: t('pax8CatalogDrawer.imported', { name: saved.name }), type: 'success' }
              : { message: t('pax8CatalogDrawer.importedWithoutCleanup', { name: saved.name }), type: 'warning' }
        );
        onImported(saved);
        onClose();
      } catch (err) {
        handleActionError(err, 'Could not import the Pax8 product.');
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
      data-testid="pax8-catalog-modal"
    >
      <div ref={panelRef} className="mt-8 w-full max-w-2xl rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t('pax8CatalogDrawer.importFromPax8')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('pax8CatalogDrawer.searchThePax8CatalogPickATermSetYourSellPriceAndAddItToT')}</p>
          </div>
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('pax8CatalogDrawer.close')}
            data-testid="pax8-catalog-close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="p-5">
          {partnerCurrency == null ? (
            partnerCurrencyFailed ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="pax8-catalog-currency-error">
                {t('catalogItemEditorDrawer.partnerCurrencyUnavailable')}{' '}
                <button type="button" onClick={retryPartnerCurrency} className="underline hover:text-foreground">{t('catalogItemEditorDrawer.retry')}</button>
              </p>
            ) : (
              <p className="py-2 text-center text-xs text-muted-foreground" data-testid="pax8-catalog-currency-loading">
                {t('catalogItemEditorDrawer.loadingPartnerCurrency')}</p>
            )
          ) : (
            <Pax8ProductLookup blockId="pax8-catalog" busy={busy} currencyCode={partnerCurrency} onImportAdd={importAdd} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
