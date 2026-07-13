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

// ─── TD SYNNEX nightly SFTP price & availability file ────────────────────────

const SFTP_BASE = '/catalog/distributors/td-synnex-sftp';

/** A populated password reads back from the API as this sentinel. Never send it
 *  back on save — an empty field means "keep the stored password". */
export const SFTP_MASKED_SECRET = '********';

export type SftpRegion = 'US' | 'CA';

export interface SftpStatus {
  configured: boolean;
  enabled: boolean;
  id?: string;
  region?: string;
  accountNumber?: string;
  /** Derived server-side from region + account number (read-only in the UI). */
  username?: string | null;
  remoteFileName?: string | null;
  host?: string;
  credentials?: { password?: string };
  lastTestStatus?: string | null;
  lastTestAt?: string | null;
  lastTestError?: string | null;
  lastSyncStatus?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  lastFileName?: string | null;
  lastRowCount?: number | null;
}

export interface SftpConfigInput {
  region?: SftpRegion;
  accountNumber?: string | null;
  /** Omit to keep the stored password. */
  password?: string | null;
  enabled?: boolean;
}

export interface SftpTestResult {
  success: boolean;
  /** A brand-new account authenticates ~24h before TD SYNNEX generates the
   *  first file: success with fileFound=false is informational, not a failure. */
  fileFound: boolean;
  message?: string;
  error?: string | null;
}

/** One ingested price & availability row. Drizzle numerics arrive as strings. */
export interface SftpProduct {
  id?: string;
  synnexSku: string;
  mfgPartNo: string | null;
  name: string | null;
  description?: string | null;
  status?: string | null;
  currency: string | null;
  cost: string | number | null;
  msrp: string | number | null;
  totalQty: number | null;
  warehouses?: unknown;
  syncedAt?: string | null;
}

export function tdSynnexSftpStatus(): Promise<Response> {
  return fetchWithAuth(`${SFTP_BASE}/status`);
}

export function tdSynnexSftpSaveConfig(body: SftpConfigInput): Promise<Response> {
  return fetchWithAuth(`${SFTP_BASE}/config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function tdSynnexSftpTest(): Promise<Response> {
  return fetchWithAuth(`${SFTP_BASE}/test`, { method: 'POST', headers: JSON_HEADERS });
}

/** Enqueues a background job — the caller must report "queued", not "synced". */
export function tdSynnexSftpSync(): Promise<Response> {
  return fetchWithAuth(`${SFTP_BASE}/sync`, { method: 'POST', headers: JSON_HEADERS });
}

export function tdSynnexSftpProducts(opts: { q?: string; limit?: number; offset?: number } = {}): Promise<Response> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  });
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  return fetchWithAuth(`${SFTP_BASE}/products?${params.toString()}`);
}

const PAX8_BASE = '/catalog/distributors/pax8';

export interface Pax8Product {
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  shortDescription: string | null;
  raw: Record<string, unknown>;
}

export interface Pax8PriceOption {
  commitmentTerm: string | null;
  billingTerm: string | null;
  partnerBuyRate: string | null;        // cost
  suggestedRetailPrice: string | null;  // list price
  currencyCode: string | null;
}

export interface Pax8ImportItem {
  name: string;
  sku: string | null;
  description: string | null;
  unitPrice: number;
  costBasis: number | null;
}

export interface Pax8ImportProduct {
  source: 'pax8';
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  commitmentTerm: string | null;
  billingTerm: string | null;
  partnerBuyRate: string | null;
  currency: string | null;
  raw: Record<string, unknown>;
}

export function pax8Status(): Promise<Response> {
  return fetchWithAuth(`${PAX8_BASE}/status`);
}

export function pax8Search(q: string, vendor?: string): Promise<Response> {
  const params = new URLSearchParams({ q });
  if (vendor) params.set('vendor', vendor);
  return fetchWithAuth(`${PAX8_BASE}/search?${params.toString()}`);
}

export function pax8Pricing(productId: string): Promise<Response> {
  return fetchWithAuth(`${PAX8_BASE}/pricing?productId=${encodeURIComponent(productId)}`);
}

export function pax8Import(body: { product: Pax8ImportProduct; item: Pax8ImportItem; aiCleanup?: boolean }): Promise<Response> {
  return fetchWithAuth(`${PAX8_BASE}/import`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
