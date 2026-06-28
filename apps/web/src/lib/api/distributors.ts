// apps/web/src/lib/api/distributors.ts
import { fetchWithAuth } from '../../stores/auth';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BASE = '/catalog/distributors/td-synnex-ec';

export interface EcWarehouseStock {
  code: string | null;
  available: number;
  onOrder: number;
  bo: number;
  eta: string | null;
}

export interface EcProduct {
  source: 'td_synnex_ec_express';
  synnexSku: string;
  mfgPartNo: string | null;
  status: string | null;
  name: string;
  description: string | null;
  currency: string | null;
  cost: number | null;
  msrp: number | null;
  discount: number | null;
  totalQty: number | null;
  warehouses: EcWarehouseStock[];
  weight: number | null;
  parcelShippable: string | null;
  raw: Record<string, unknown>;
}

export interface EcStatus {
  configured: boolean;
  enabled: boolean;
  region?: string;
  settings?: { defaultWarehouse?: string; hideZeroInv?: boolean; defaultMarkupPercent?: number };
}

export interface EcImportItem {
  name: string;
  sku: string | null;
  description: string | null;
  unitPrice: number;
  costBasis: number | null;
}

export function ecExpressStatus(): Promise<Response> {
  return fetchWithAuth(`${BASE}/status`);
}

export function ecExpressLookup(q: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/lookup?q=${encodeURIComponent(q)}`);
}

export function ecExpressImport(body: { product: EcProduct; item: EcImportItem; aiCleanup?: boolean }): Promise<Response> {
  return fetchWithAuth(`${BASE}/import`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Default sell price: MSRP, else reseller cost, else blank. Mirrors the
 *  existing TdSynnexEcExpressPanel.sellPriceDefault. */
export function sellPriceDefault(product: EcProduct): string {
  const value = product.msrp ?? product.cost;
  return value === null || value === undefined ? '' : value.toFixed(2);
}
