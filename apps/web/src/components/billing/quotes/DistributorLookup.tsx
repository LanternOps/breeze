// apps/web/src/components/billing/quotes/DistributorLookup.tsx
import { useState } from 'react';
import { ecExpressLookup, sellPriceDefault, type EcProduct } from '../../../lib/api/distributors';

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
}

interface DistributorLookupProps {
  blockId: string;
  busy: boolean;
  onImportAdd: (product: EcProduct, sellPrice: number) => void;
}

export default function DistributorLookup({ blockId, busy, onImportAdd }: DistributorLookupProps) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<EcProduct[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = await ecExpressLookup(q);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Lookup failed.');
        setProducts([]);
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: EcProduct[] } | null;
      const results = body?.data ?? [];
      setProducts(results);
      setPrices(Object.fromEntries(results.map((p) => [p.synnexSku, sellPriceDefault(p)])));
    } catch {
      setError('Lookup failed.');
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
          placeholder="SYNNEX SKU or mfg part #"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }}
          data-testid={`quote-distributor-search-${blockId}`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          data-testid={`quote-distributor-search-btn-${blockId}`}
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-destructive" data-testid={`quote-distributor-error-${blockId}`}>{error}</p>
      )}

      {products.map((p) => {
        const priceVal = prices[p.synnexSku] ?? '';
        const parsed = toMoney(priceVal);
        return (
          <div key={p.synnexSku} data-testid={`quote-distributor-result-${p.synnexSku}`} className="rounded-md border bg-background/40 p-3 text-sm">
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              SKU {p.synnexSku}{p.status ? ` · ${p.status}` : ''}
              {p.cost != null ? ` · cost ${p.currency ?? 'USD'} ${p.cost.toFixed(2)}` : ''}
              {p.msrp != null ? ` · MSRP ${p.msrp.toFixed(2)}` : ''}
              {p.totalQty != null ? ` · ${p.totalQty} avail` : ''}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Sell price</label>
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
                Import &amp; add
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
