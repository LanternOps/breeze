// apps/web/src/components/billing/quotes/DistributorLookup.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import {
  ecExpressLookup,
  sellPriceDefault,
  tdSynnexSftpProducts,
  type EcProduct,
  type SftpProduct,
} from '../../../lib/api/distributors';
import { computeMarginBreakdown, formatMarginSummary } from '../../settings/marginMath';
import { formatNumber } from '@/lib/i18n/format';
import {
  freshnessOf,
  lifecycleOf,
  nightlyToEcProduct,
  warehouseSummary,
  type Freshness,
} from './nightlyProduct';

/**
 * `ec_express` is the live, exact-match lookup (one SKU or mfg part number at a
 * time — it has no keyword search). `nightly` searches the locally indexed TD
 * SYNNEX price & availability file, which is the only source that can answer
 * "show me every Lenovo dock". It is a nightly snapshot, so every row carries a
 * freshness marker and lifecycle/stock badges.
 */
type LookupSource = 'ec_express' | 'nightly';

const NIGHTLY_MIN_CHARS = 3;
const NIGHTLY_DEBOUNCE_MS = 300;
const NIGHTLY_LIMIT = 25;

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
}

/** One rendered row: the EC-shaped product every consumer imports, plus the
 *  nightly row it came from (null for the live EC Express lookup). */
interface Result {
  product: EcProduct;
  nightly: SftpProduct | null;
}

interface DistributorLookupProps {
  blockId: string;
  busy: boolean;
  onImportAdd: (product: EcProduct, sellPrice: number) => void;
}

export default function DistributorLookup({ blockId, busy, onImportAdd }: DistributorLookupProps) {
  const { t } = useTranslation('billing');
  const [source, setSource] = useState<LookupSource>('ec_express');
  const [query, setQuery] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id — a slow earlier response must never overwrite the
  // results of a later keystroke (the nightly search fires on every debounce).
  const requestId = useRef(0);

  const applyResults = useCallback((next: Result[]) => {
    setResults(next);
    setPrices(Object.fromEntries(next.map((r) => [r.product.synnexSku, sellPriceDefault(r.product)])));
  }, []);

  const runSearch = useCallback(async (term: string, mode: LookupSource, stockOnly: boolean) => {
    const q = term.trim();
    if (!q) return;
    if (mode === 'nightly' && q.length < NIGHTLY_MIN_CHARS) return;
    const id = ++requestId.current;
    setSearching(true);
    setError(null);
    try {
      const res = mode === 'nightly'
        ? await tdSynnexSftpProducts({ q, inStockOnly: stockOnly, limit: NIGHTLY_LIMIT })
        : await ecExpressLookup(q);
      if (id !== requestId.current) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (id !== requestId.current) return;
        setError(body?.error ?? t('quotes.distributorLookup.lookupFailed'));
        applyResults([]);
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
      if (id !== requestId.current) return;
      // A null body means the response wasn't valid JSON — a failure, not an
      // empty catalog. Never render "no matches" for a broken response.
      if (body === null) {
        setError(t('quotes.distributorLookup.lookupFailed'));
        applyResults([]);
        return;
      }
      const rows = body.data ?? [];
      applyResults(mode === 'nightly'
        ? (rows as SftpProduct[]).map((row) => ({ product: nightlyToEcProduct(row), nightly: row }))
        : (rows as EcProduct[]).map((product) => ({ product, nightly: null })));
    } catch {
      if (id !== requestId.current) return;
      setError(t('quotes.distributorLookup.lookupFailed'));
      applyResults([]);
    } finally {
      if (id === requestId.current) {
        setSearching(false);
        setSearched(true);
      }
    }
  }, [applyResults, t]);

  // Nightly only: debounced keyword search. EC Express stays a deliberate,
  // explicit lookup (Enter / button) — it hits TD SYNNEX live, per keystroke
  // requests would hammer their API.
  useEffect(() => {
    if (source !== 'nightly') return;
    const q = query.trim();
    if (q.length < NIGHTLY_MIN_CHARS) {
      requestId.current += 1; // cancel any in-flight response
      setResults([]);
      setSearched(false);
      setError(null);
      setSearching(false);
      return;
    }
    const timer = setTimeout(() => { void runSearch(q, 'nightly', inStockOnly); }, NIGHTLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, source, inStockOnly, runSearch]);

  const changeSource = (next: LookupSource) => {
    if (next === source) return;
    requestId.current += 1;
    setSource(next);
    setResults([]);
    setPrices({});
    setError(null);
    setSearched(false);
    setSearching(false);
  };

  const nightly = source === 'nightly';
  const tooShort = nightly && query.trim().length > 0 && query.trim().length < NIGHTLY_MIN_CHARS;

  const freshnessLabel = (freshness: Freshness): string => {
    switch (freshness.unit) {
      case 'unknown': return t('quotes.distributorLookup.syncedUnknown');
      case 'now': return t('quotes.distributorLookup.syncedJustNow');
      case 'minutes': return t('quotes.distributorLookup.syncedMinutesAgo', { count: freshness.count });
      case 'hours': return t('quotes.distributorLookup.syncedHoursAgo', { count: freshness.count });
      case 'days': return t('quotes.distributorLookup.syncedDaysAgo', { count: freshness.count });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor={`quote-distributor-source-${blockId}`}>
          {t('quotes.distributorLookup.source')}
        </label>
        <select
          id={`quote-distributor-source-${blockId}`}
          value={source}
          onChange={(e) => changeSource(e.target.value as LookupSource)}
          data-testid={`quote-distributor-source-${blockId}`}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="ec_express">{t('quotes.distributorLookup.sourceEcExpress')}</option>
          <option value="nightly">{t('quotes.distributorLookup.sourceNightly')}</option>
        </select>
        {nightly && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={inStockOnly}
              onChange={(e) => setInStockOnly(e.target.checked)}
              data-testid={`quote-distributor-instock-${blockId}`}
            />
            {t('quotes.distributorLookup.inStockOnly')}
          </label>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          placeholder={nightly
            ? t('quotes.distributorLookup.nightlyPlaceholder')
            : t('quotes.distributorLookup.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(query, source, inStockOnly); } }}
          data-testid={`quote-distributor-search-${blockId}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void runSearch(query, source, inStockOnly)}
          disabled={searching || !query.trim() || tooShort}
          data-testid={`quote-distributor-search-btn-${blockId}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {searching ? t('quotes.distributorLookup.searching') : t('common:actions.search')}
        </button>
      </div>

      {nightly && (
        <p className="text-xs text-muted-foreground" data-testid={`quote-distributor-hint-${blockId}`}>
          {t('quotes.distributorLookup.nightlyHint', { count: NIGHTLY_MIN_CHARS })}
        </p>
      )}

      {error && (
        <p className="text-xs text-destructive" data-testid={`quote-distributor-error-${blockId}`}>{error}</p>
      )}

      {!error && !searching && searched && results.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid={`quote-distributor-empty-${blockId}`}>
          {t('quotes.distributorLookup.noResults')}
        </p>
      )}

      {results.map(({ product: p, nightly: row }) => {
        const priceVal = prices[p.synnexSku] ?? '';
        const parsed = toMoney(priceVal);
        const margin = computeMarginBreakdown(p.cost ?? null, parsed);
        const lifecycle = row ? lifecycleOf(row) : null;
        const outOfStock = row ? (p.totalQty ?? 0) === 0 : false;
        const warehouses = row ? warehouseSummary(row.warehouses) : '';
        const manufacturer = row?.manufacturer?.trim() ?? '';
        const freshness = row ? freshnessOf(row.syncedAt) : null;
        return (
          <div key={p.synnexSku} data-testid={`quote-distributor-result-${p.synnexSku}`} className="rounded-md border bg-background/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              {lifecycle && (
                <span
                  data-testid={`quote-distributor-eol-${p.synnexSku}`}
                  className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
                >
                  {lifecycle === 'eol'
                    ? t('quotes.distributorLookup.endOfLife')
                    : t('quotes.distributorLookup.toBeDiscontinued')}
                </span>
              )}
              {outOfStock && (
                <span
                  data-testid={`quote-distributor-oos-${p.synnexSku}`}
                  className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                >
                  {t('quotes.distributorLookup.outOfStock')}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('quotes.distributorLookup.sku', { sku: p.synnexSku })}
              {p.mfgPartNo ? ` · ${t('quotes.distributorLookup.mfgPart', { part: p.mfgPartNo })}` : ''}
              {manufacturer ? ` · ${manufacturer}` : ''}
              {!row && p.status ? ` · ${p.status}` : ''}
              {p.cost != null ? ` · ${t('quotes.distributorLookup.cost', { currency: p.currency ?? 'USD', amount: formatNumber(p.cost, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}` : ''}
              {p.msrp != null ? ` · ${t('quotes.distributorLookup.msrp', { amount: formatNumber(p.msrp, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}` : ''}
              {p.totalQty != null ? ` · ${t('quotes.distributorLookup.available', { count: p.totalQty })}` : ''}
            </div>
            {warehouses && (
              <div className="text-xs text-muted-foreground" data-testid={`quote-distributor-warehouses-${p.synnexSku}`}>
                {t('quotes.distributorLookup.warehouses', { list: warehouses })}
              </div>
            )}
            {freshness && (
              <div
                className={`text-xs ${freshness.unit !== 'unknown' && freshness.unit !== 'now' && freshness.stale ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
                data-testid={`quote-distributor-freshness-${p.synnexSku}`}
              >
                {freshnessLabel(freshness)}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-muted-foreground">{t('quotes.distributorLookup.sellPrice')}</label>
              <input
                type="number" min="0" step="0.01"
                value={priceVal}
                onChange={(e) => setPrices((s) => ({ ...s, [p.synnexSku]: e.target.value }))}
                data-testid={`quote-distributor-price-${p.synnexSku}`}
                className="h-9 w-28 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => { if (parsed != null) onImportAdd(p, parsed); }}
                disabled={busy || parsed == null}
                data-testid={`quote-distributor-add-${p.synnexSku}`}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {t('quotes.distributorLookup.importAndAdd')}
              </button>
            </div>
            {margin && (
              <p
                className={`mt-1.5 text-xs tabular-nums ${margin.profit < 0 ? 'text-destructive' : 'text-muted-foreground'}`}
                data-testid={`quote-distributor-margin-${p.synnexSku}`}
              >
                {formatMarginSummary(margin, p.currency ?? 'USD')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
