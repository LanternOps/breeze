// apps/web/src/components/billing/quotes/nightlyProduct.ts
//
// Helpers for the TD SYNNEX nightly price & availability file (the locally
// indexed, keyword-searchable catalog) as rendered inside DistributorLookup.
//
// The nightly rows come from Postgres via Drizzle, so every numeric column
// arrives as a STRING. Everything downstream (margin math, the import endpoint,
// the quote line) wants real numbers, so normalisation happens here, once.
import type { EcProduct, SftpProduct, SftpWarehouseStock } from '../../../lib/api/distributors';

/** Spec field 40. C = end-of-life, T = to be discontinued — both are traps to quote. */
export type NightlyLifecycle = 'eol' | 'to_be_discontinued' | null;

export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function lifecycleOf(product: SftpProduct): NightlyLifecycle {
  const code = product.abcCode?.trim().toUpperCase();
  if (code === 'C') return 'eol';
  if (code === 'T') return 'to_be_discontinued';
  return null;
}

/** `warehouses` is jsonb — treat it as untrusted and only keep usable buckets. */
export function nightlyWarehouses(value: unknown): SftpWarehouseStock[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SftpWarehouseStock =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

/** "DFW 12 · ATL 3" — only warehouses that actually hold stock. */
export function warehouseSummary(value: unknown, max = 4): string {
  const stocked = nightlyWarehouses(value)
    .map((w) => ({ code: w.code ?? w.loc ?? null, available: toNumber(w.available) ?? 0 }))
    .filter((w) => w.code !== null && w.available > 0)
    .sort((a, b) => b.available - a.available);
  if (stocked.length === 0) return '';
  const shown = stocked.slice(0, max).map((w) => `${w.code} ${w.available}`);
  if (stocked.length > max) shown.push(`+${stocked.length - max}`);
  return shown.join(' · ');
}

/**
 * Normalise a nightly-file row into the EC Express product shape the existing
 * `/import` endpoint (and every DistributorLookup consumer) already speaks.
 *
 * A shape adapter only — provenance is preserved, not laundered. The row keeps
 * `source: 'td_synnex_price_file'` (the import schema accepts it), so a catalog
 * item built from a nightly snapshot never claims it came from a live EC Express
 * lookup. That field is exactly what you check when a price looks stale.
 * No live EC Express call is made — price re-verification on add is a later phase.
 */
export function nightlyToEcProduct(product: SftpProduct): EcProduct {
  const cost = toNumber(product.cost);
  const msrp = toNumber(product.msrp);
  const warehouses = nightlyWarehouses(product.warehouses)
    .slice(0, 200)
    .map((w) => ({
      code: w.code ?? w.loc ?? null,
      available: toNumber(w.available) ?? 0,
      onOrder: 0,
      bo: 0,
      eta: product.etaDate ?? null,
    }));

  return {
    source: 'td_synnex_price_file',
    synnexSku: product.synnexSku,
    mfgPartNo: product.mfgPartNo ?? null,
    status: product.status ?? null,
    name: product.name ?? product.synnexSku,
    description: product.description ?? null,
    currency: product.currency ?? null,
    cost,
    msrp,
    discount: null,
    totalQty: product.totalQty ?? null,
    warehouses,
    weight: toNumber(product.weight),
    parcelShippable: null,
    raw: {
      source: 'td_synnex_price_file',
      tdPartNo: product.tdPartNo ?? null,
      manufacturer: product.manufacturer ?? null,
      abcCode: product.abcCode ?? null,
      costWithoutPromo: toNumber(product.costWithoutPromo),
      mapPrice: toNumber(product.mapPrice),
      upc: product.upc ?? null,
      unspsc: product.unspsc ?? null,
      etaDate: product.etaDate ?? null,
      fileDate: product.fileDate ?? null,
      syncedAt: product.syncedAt ?? null,
    },
  };
}

export type Freshness =
  | { unit: 'unknown' }
  | { unit: 'now' }
  | { unit: 'minutes' | 'hours' | 'days'; count: number; stale: boolean };

/**
 * How old the nightly snapshot is. Anything past 48h means at least two nightly
 * syncs were missed — that price is no longer safe to quote from without a look.
 */
export function freshnessOf(syncedAt: string | null | undefined, now: number = Date.now()): Freshness {
  if (!syncedAt) return { unit: 'unknown' };
  const at = new Date(syncedAt).getTime();
  if (!Number.isFinite(at)) return { unit: 'unknown' };
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const stale = hours >= 48;
  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'minutes', count: minutes, stale };
  if (hours < 24) return { unit: 'hours', count: hours, stale };
  return { unit: 'days', count: days, stale };
}
