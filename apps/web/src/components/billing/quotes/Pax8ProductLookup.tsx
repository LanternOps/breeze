import { useState } from 'react';
import { pax8Search, pax8Pricing, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
import { computeMarginBreakdown, formatMarginSummary } from '../../settings/marginMath';

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
}

interface Props {
  blockId: string;
  busy: boolean;
  onImportAdd: (product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => void;
}

export default function Pax8ProductLookup({ blockId, busy, onImportAdd }: Props) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Pax8Product[]>([]);
  const [pricing, setPricing] = useState<Record<string, Pax8PriceOption[]>>({});
  const [termIndex, setTermIndex] = useState<Record<string, number>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPricing = async (productId: string) => {
    if (pricing[productId]) return;
    const res = await pax8Pricing(productId);
    const body = (await res.json().catch(() => null)) as { data?: Pax8PriceOption[] } | null;
    const options = body?.data ?? [];
    setPricing((s) => ({ ...s, [productId]: options }));
    setTermIndex((s) => ({ ...s, [productId]: 0 }));
    const first = options[0];
    if (first) setPrices((s) => ({ ...s, [productId]: first.suggestedRetailPrice ?? first.partnerBuyRate ?? '' }));
  };

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = await pax8Search(q);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Search failed.');
        setProducts([]);
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: Pax8Product[] } | null;
      const results = body?.data ?? [];
      setProducts(results);
      await Promise.all(results.map((p) => loadPricing(p.pax8ProductId)));
    } catch {
      setError('Search failed.');
      setProducts([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          placeholder="Product, vendor, or SKU"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }}
          data-testid={`pax8-product-search-${blockId}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          data-testid={`pax8-product-search-btn-${blockId}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <p className="text-xs text-destructive" data-testid={`pax8-product-error-${blockId}`}>{error}</p>}

      {products.map((p) => {
        const options = pricing[p.pax8ProductId] ?? [];
        const idx = termIndex[p.pax8ProductId] ?? 0;
        const term = options[idx];
        const cost = term?.partnerBuyRate != null ? Number(term.partnerBuyRate) : null;
        const priceVal = prices[p.pax8ProductId] ?? '';
        const parsed = toMoney(priceVal);
        const margin = computeMarginBreakdown(cost, parsed);
        return (
          <div key={p.pax8ProductId} data-testid={`pax8-product-result-${p.pax8ProductId}`} className="rounded-md border bg-background/40 p-3 text-sm">
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              {p.vendorName ?? 'Pax8'}{p.vendorSku ? ` · ${p.vendorSku}` : ''}
            </div>
            {options.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Term</label>
                <select
                  value={idx}
                  data-testid={`pax8-product-term-${p.pax8ProductId}`}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setTermIndex((s) => ({ ...s, [p.pax8ProductId]: next }));
                    const opt = options[next];
                    if (opt) setPrices((s) => ({ ...s, [p.pax8ProductId]: opt.suggestedRetailPrice ?? opt.partnerBuyRate ?? '' }));
                  }}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {options.map((o, i) => (
                    <option key={i} value={i}>
                      {[o.commitmentTerm, o.billingTerm].filter(Boolean).join(' / ') || `Option ${i + 1}`}
                      {o.partnerBuyRate ? ` — cost ${o.currencyCode ?? 'USD'} ${o.partnerBuyRate}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Sell price</label>
              <input
                type="number" min="0" step="0.01"
                value={priceVal}
                onChange={(e) => setPrices((s) => ({ ...s, [p.pax8ProductId]: e.target.value }))}
                data-testid={`pax8-product-price-${p.pax8ProductId}`}
                className="h-9 w-28 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => { if (parsed != null && term) onImportAdd(p, term, parsed); }}
                disabled={busy || parsed == null || !term}
                data-testid={`pax8-product-add-${p.pax8ProductId}`}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Import &amp; add
              </button>
            </div>
            {margin && (
              <p className={`mt-1.5 text-xs tabular-nums ${margin.profit < 0 ? 'text-destructive' : 'text-muted-foreground'}`} data-testid={`pax8-product-margin-${p.pax8ProductId}`}>
                {formatMarginSummary(margin, term?.currencyCode ?? 'USD')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
