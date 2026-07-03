import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../db';
import { tdSynnexDigitalBridgeIntegrations } from '../db/schema';
import { encryptSecret, decryptForColumn } from './secretCrypto';
import { createCatalogItem, type CatalogActor } from './catalogService';
import { enrichDistributorListing } from './catalogEnrichmentService';
import type { CreateCatalogItemInput, EnrichmentProvenance } from '@breeze/shared';
import { checkSsrfSafe } from './ssrfGuard';
import { safeFetch, SsrfBlockedError } from './urlSafety';

const TABLE = 'td_synnex_digital_bridge_integrations';
const CREDENTIALS_COLUMN = 'credentials';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
export const TD_SYNNEX_MASKED_SECRET = '********';

type AuthType = 'api_key' | 'bearer' | 'basic';
type HttpMethod = 'GET' | 'POST';

export interface TdSynnexDigitalBridgeSettings {
  accountId?: string;
  testPath?: string;
  searchPath?: string;
  searchMethod?: HttpMethod;
  detailsPath?: string;
  availabilityPath?: string;
}

export interface TdSynnexDigitalBridgeCredentials {
  apiKey?: string | null;
  apiSecret?: string | null;
}

export interface TdSynnexDigitalBridgeConfigInput {
  environment: 'sandbox' | 'production';
  region: string;
  baseUrl: string;
  authType: AuthType;
  enabled: boolean;
  credentials?: TdSynnexDigitalBridgeCredentials;
  settings?: TdSynnexDigitalBridgeSettings;
}

export interface TdSynnexProduct {
  source: 'td_synnex_digital_bridge';
  sourceProductId: string;
  sku: string | null;
  manufacturerPartNumber: string | null;
  vendor: string | null;
  name: string;
  description: string | null;
  cost: string | null;
  currency: string | null;
  availability: number | null;
  warehouses: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
  lastRefreshedAt: string;
}

// Single source of truth for the HTTP status each error code maps to. Coupling
// the status to the code here makes incoherent pairs (e.g. a 502 duplicate-SKU)
// unrepresentable and removes the old misleading 400/PROVIDER_ERROR default.
const TD_SYNNEX_ERROR_STATUS = {
  TD_SYNNEX_PARTNER_REQUIRED: 400,
  TD_SYNNEX_NOT_CONFIGURED: 404,
  TD_SYNNEX_DISABLED: 400,
  TD_SYNNEX_ENDPOINT_NOT_CONFIGURED: 400,
  TD_SYNNEX_CREDENTIALS_INVALID: 400,
  TD_SYNNEX_AUTH_FAILED: 401,
  TD_SYNNEX_PROVIDER_ERROR: 502,
  TD_SYNNEX_NO_RESULTS: 404,
  TD_SYNNEX_DUPLICATE_SKU: 409,
} as const;

export type TdSynnexDigitalBridgeErrorCode = keyof typeof TD_SYNNEX_ERROR_STATUS;

export class TdSynnexDigitalBridgeError extends Error {
  public readonly status: number;
  constructor(
    message: string,
    public readonly code: TdSynnexDigitalBridgeErrorCode = 'TD_SYNNEX_PROVIDER_ERROR'
  ) {
    super(message);
    this.name = 'TdSynnexDigitalBridgeError';
    this.status = TD_SYNNEX_ERROR_STATUS[code];
  }
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX integration is partner-scoped', 'TD_SYNNEX_PARTNER_REQUIRED');
  }
  return actor.partnerId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asMethod(value: unknown): HttpMethod {
  return value === 'POST' ? 'POST' : 'GET';
}

function asAuthType(value: unknown): AuthType {
  return value === 'bearer' || value === 'basic' ? value : 'api_key';
}

function decryptCredential(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // A present-but-non-string credential means the stored JSONB is corrupt — fail
  // loudly with an actionable code instead of silently treating it as "absent".
  if (typeof value !== 'string') {
    throw new TdSynnexDigitalBridgeError('Stored TD SYNNEX credentials are corrupt — please re-enter and save them', 'TD_SYNNEX_CREDENTIALS_INVALID');
  }
  if (value.length === 0) return null;
  return decryptForColumn(TABLE, CREDENTIALS_COLUMN, value);
}

function mergeCredentialField(output: Record<string, unknown>, key: 'apiKey' | 'apiSecret', value: unknown) {
  if (value === undefined || value === TD_SYNNEX_MASKED_SECRET) return;
  if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
    delete output[key];
    return;
  }
  if (typeof value === 'string') {
    output[key] = encryptSecret(value.trim());
  }
}

function mergeCredentials(existing: unknown, next: TdSynnexDigitalBridgeCredentials | undefined): Record<string, unknown> {
  const current = asRecord(existing);
  const output: Record<string, unknown> = { ...current };
  if (!next) return output;
  mergeCredentialField(output, 'apiKey', next.apiKey);
  mergeCredentialField(output, 'apiSecret', next.apiSecret);
  return output;
}

export function normalizeTdSynnexBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX base URL must be a valid URL', 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }

  if (parsed.username || parsed.password) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX base URL cannot include credentials', 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }

  const ssrf = checkSsrfSafe(parsed.toString(), { mode: 'strict-https' });
  if (!ssrf.ok) {
    throw new TdSynnexDigitalBridgeError(`TD SYNNEX base URL rejected: ${ssrf.reason}`, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

export function normalizeTdSynnexEndpointPath(path: string): string {
  const value = path.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX endpoint paths must be relative paths beginning with /', 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }
  return value;
}

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.TD_SYNNEX_DIGITAL_BRIDGE_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, parsed));
}

function maskConfig(row: typeof tdSynnexDigitalBridgeIntegrations.$inferSelect | null) {
  if (!row) {
    return { configured: false, enabled: false };
  }
  const credentials = asRecord(row.credentials);
  const hasApiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.length > 0;
  const hasApiSecret = typeof credentials.apiSecret === 'string' && credentials.apiSecret.length > 0;
  // basic auth needs both key and secret to authenticate; key-only auth modes
  // (api_key headers / bearer) are configured with just the key.
  const requiresSecret = asAuthType(row.authType) === 'basic';
  return {
    configured: hasApiKey && (!requiresSecret || hasApiSecret),
    id: row.id,
    environment: row.environment,
    region: row.region,
    baseUrl: row.baseUrl,
    authType: row.authType,
    enabled: row.enabled,
    credentials: {
      apiKey: hasApiKey ? TD_SYNNEX_MASKED_SECRET : '',
      apiSecret: hasApiSecret ? TD_SYNNEX_MASKED_SECRET : ''
    },
    settings: asRecord(row.settings),
    lastTestStatus: row.lastTestStatus,
    lastTestAt: row.lastTestAt,
    lastTestError: row.lastTestError,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError
  };
}

export async function getTdSynnexDigitalBridgeStatus(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(tdSynnexDigitalBridgeIntegrations)
    .where(eq(tdSynnexDigitalBridgeIntegrations.partnerId, partnerId))
    .limit(1);
  return maskConfig(row ?? null);
}

export async function saveTdSynnexDigitalBridgeConfig(input: TdSynnexDigitalBridgeConfigInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const baseUrl = normalizeTdSynnexBaseUrl(input.baseUrl);
  const existing = await db
    .select()
    .from(tdSynnexDigitalBridgeIntegrations)
    .where(eq(tdSynnexDigitalBridgeIntegrations.partnerId, partnerId))
    .limit(1);
  const current = existing[0] ?? null;
  const credentials = mergeCredentials(current?.credentials, input.credentials);
  const settings = {
    ...asRecord(current?.settings),
    ...asRecord(input.settings),
    searchMethod: asMethod(input.settings?.searchMethod)
  };

  const rows = await db
    .insert(tdSynnexDigitalBridgeIntegrations)
    .values({
      partnerId,
      environment: input.environment,
      region: input.region,
      baseUrl,
      authType: input.authType,
      credentials,
      settings,
      enabled: input.enabled,
      createdBy: actor.userId,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: tdSynnexDigitalBridgeIntegrations.partnerId,
      set: {
        environment: input.environment,
        region: input.region,
        baseUrl,
        authType: input.authType,
        credentials,
        settings,
        enabled: input.enabled,
        updatedAt: new Date()
      }
    })
    .returning();

  return maskConfig(rows[0] ?? null);
}

async function getActiveIntegration(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(tdSynnexDigitalBridgeIntegrations)
    .where(eq(tdSynnexDigitalBridgeIntegrations.partnerId, partnerId))
    .limit(1);
  if (!row) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX Digital Bridge is not configured', 'TD_SYNNEX_NOT_CONFIGURED');
  }
  if (!row.enabled) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX Digital Bridge is disabled', 'TD_SYNNEX_DISABLED');
  }
  return row;
}

function endpointUrl(baseUrl: string, path: string, params?: Record<string, string | number | undefined>): string {
  const safeBaseUrl = normalizeTdSynnexBaseUrl(baseUrl);
  const safePath = normalizeTdSynnexEndpointPath(path);
  // Resolve the endpoint path RELATIVE to the base so a base URL carrying a path
  // prefix (e.g. https://host/digitalbridge/v1) is preserved. `new URL('/x', base)`
  // treats the leading slash as origin-absolute and silently drops the prefix, so
  // strip it and resolve against a trailing-slashed base instead.
  const base = safeBaseUrl.endsWith('/') ? safeBaseUrl : `${safeBaseUrl}/`;
  const url = new URL(safePath.replace(/^\/+/, ''), base);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && String(value).length > 0) url.searchParams.set(key, String(value));
  }
  // Re-validate the fully-resolved URL: the path/param join must not escape the
  // SSRF-vetted https origin.
  const ssrf = checkSsrfSafe(url.toString(), { mode: 'strict-https' });
  if (!ssrf.ok) {
    throw new TdSynnexDigitalBridgeError(`TD SYNNEX endpoint rejected: ${ssrf.reason}`, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }
  return url.toString();
}

function authHeaders(row: typeof tdSynnexDigitalBridgeIntegrations.$inferSelect): HeadersInit {
  const credentials = asRecord(row.credentials);
  let apiKey: string | null;
  let apiSecret: string | null;
  try {
    apiKey = decryptCredential(credentials.apiKey);
    apiSecret = decryptCredential(credentials.apiSecret);
  } catch (err) {
    // decryptCredential throws a typed error for corrupt JSONB; decryptForColumn
    // throws a plain Error for an undecryptable blob (rotated key / truncated
    // ciphertext). Both are actionable "re-enter credentials" situations, not 500s.
    if (err instanceof TdSynnexDigitalBridgeError) throw err;
    throw new TdSynnexDigitalBridgeError('Stored TD SYNNEX credentials could not be decrypted — please re-enter and save them', 'TD_SYNNEX_CREDENTIALS_INVALID');
  }
  const authType = asAuthType(row.authType);
  if (!apiKey) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX API key is not configured', 'TD_SYNNEX_CREDENTIALS_INVALID');
  }

  if (authType === 'bearer') {
    return { authorization: `Bearer ${apiKey}` };
  }
  if (authType === 'basic') {
    const auth = Buffer.from(`${apiKey}:${apiSecret ?? ''}`).toString('base64');
    return { authorization: `Basic ${auth}` };
  }
  return {
    'x-api-key': apiKey,
    ...(apiSecret ? { 'x-api-secret': apiSecret } : {})
  };
}

async function requestDigitalBridge(row: typeof tdSynnexDigitalBridgeIntegrations.$inferSelect, path: string, options: {
  method?: HttpMethod;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
}) {
  const method = options.method ?? 'GET';
  const url = endpointUrl(row.baseUrl, path, method === 'GET' ? options.query : undefined);
  // Build headers (which decrypt credentials) BEFORE the try so a typed
  // credential error surfaces as-is instead of being remapped to PROVIDER_ERROR.
  const headers = {
    accept: 'application/json',
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    ...authHeaders(row)
  };
  let response: Response;
  try {
    response = await safeFetch(url, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
      timeoutMs: requestTimeoutMs()
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw new TdSynnexDigitalBridgeError('TD SYNNEX base URL resolved to a blocked address', 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
    }
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('timed out'));
    throw new TdSynnexDigitalBridgeError(
      isTimeout ? 'TD SYNNEX request timed out' : 'TD SYNNEX request failed',
      'TD_SYNNEX_PROVIDER_ERROR'
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX rejected the configured credentials', 'TD_SYNNEX_AUTH_FAILED');
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX returned an invalid JSON response', 'TD_SYNNEX_PROVIDER_ERROR');
  }
  if (!response.ok) {
    throw new TdSynnexDigitalBridgeError(`TD SYNNEX request failed with HTTP ${response.status}`, 'TD_SYNNEX_PROVIDER_ERROR');
  }
  return parsed;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function pickArray(record: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry));
  }
  return [];
}

function productArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry));
  const record = asRecord(payload);
  for (const key of ['products', 'items', 'results', 'data']) {
    const value = record[key];
    if (Array.isArray(value)) return productArray(value);
  }
  return [];
}

export function normalizeTdSynnexProducts(payload: unknown): TdSynnexProduct[] {
  const now = new Date().toISOString();
  const products: TdSynnexProduct[] = [];
  for (const product of productArray(payload)) {
    const sourceProductId = pickString(product, ['id', 'productId', 'itemId', 'tdSynnexItemId', 'sku', 'partNumber']);
    const sku = pickString(product, ['sku', 'tdSku', 'tdSynnexSku', 'itemNumber', 'partNumber']);
    // Require a stable identifier. Fabricating `result-${index}` ids collides
    // across searches (React keys, distributor.sourceProductId) and lets garbage
    // provider rows import as meaningless catalog items — skip them instead.
    const resolvedId = sourceProductId ?? sku;
    if (!resolvedId) continue;
    const name = pickString(product, ['name', 'title', 'productName', 'description']) ?? sku ?? resolvedId;
    const cost = pickNumber(product, ['cost', 'price', 'netPrice', 'dealerPrice', 'unitCost']);
    products.push({
      source: 'td_synnex_digital_bridge',
      sourceProductId: resolvedId,
      sku,
      manufacturerPartNumber: pickString(product, ['manufacturerPartNumber', 'mfrPartNumber', 'mpn', 'vendorPartNumber']),
      vendor: pickString(product, ['vendor', 'manufacturer', 'brand']),
      name,
      description: pickString(product, ['description', 'longDescription', 'shortDescription']),
      cost: cost === null ? null : cost.toFixed(2),
      currency: pickString(product, ['currency', 'currencyCode']) ?? 'USD',
      availability: pickNumber(product, ['availability', 'availableQuantity', 'quantityAvailable', 'stock']),
      warehouses: pickArray(product, ['warehouses', 'warehouseAvailability', 'inventory']),
      raw: product,
      lastRefreshedAt: now
    });
  }
  return products;
}

export async function testTdSynnexDigitalBridgeConnection(actor: CatalogActor) {
  const row = await getActiveIntegration(actor);
  const settings = asRecord(row.settings);
  const testPath = asString(settings.testPath);
  if (!testPath) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX test endpoint path is not configured', 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }
  try {
    await requestDigitalBridge(row, testPath, { method: 'GET', query: { region: row.region } });
    const [updated] = await db
      .update(tdSynnexDigitalBridgeIntegrations)
      .set({ lastTestStatus: 'success', lastTestAt: new Date(), lastTestError: null, updatedAt: new Date() })
      .where(eq(tdSynnexDigitalBridgeIntegrations.id, row.id))
      .returning();
    return maskConfig(updated ?? row);
  } catch (err) {
    await db
      .update(tdSynnexDigitalBridgeIntegrations)
      .set({
        lastTestStatus: 'failed',
        lastTestAt: new Date(),
        lastTestError: err instanceof Error ? err.message : 'Connection test failed',
        updatedAt: new Date()
      })
      .where(eq(tdSynnexDigitalBridgeIntegrations.id, row.id));
    throw err;
  }
}

export async function searchTdSynnexProducts(query: { q: string; limit: number }, actor: CatalogActor) {
  const row = await getActiveIntegration(actor);
  const settings = asRecord(row.settings);
  const searchPath = asString(settings.searchPath);
  if (!searchPath) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX search endpoint path is not configured', 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }
  const accountId = asString(settings.accountId);
  const method = asMethod(settings.searchMethod);
  let payload: unknown;
  try {
    payload = await requestDigitalBridge(row, searchPath, {
      method,
      query: { q: query.q, query: query.q, limit: query.limit, region: row.region, accountId },
      body: { q: query.q, query: query.q, limit: query.limit, region: row.region, accountId }
    });
  } catch (err) {
    // Record the failure so the status panel reflects an unhealthy integration
    // instead of a stale "last sync succeeded" — mirrors the test-connection path.
    await db
      .update(tdSynnexDigitalBridgeIntegrations)
      .set({ lastError: err instanceof Error ? err.message : 'TD SYNNEX search failed', updatedAt: new Date() })
      .where(eq(tdSynnexDigitalBridgeIntegrations.id, row.id));
    throw err;
  }
  const products = normalizeTdSynnexProducts(payload).slice(0, query.limit);
  await db
    .update(tdSynnexDigitalBridgeIntegrations)
    .set({ lastSyncAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(tdSynnexDigitalBridgeIntegrations.id, row.id));
  return products;
}

export interface ImportTdSynnexCatalogItemInput {
  product: TdSynnexProduct;
  item: {
    name: string;
    sku?: string | null;
    description?: string | null;
    unitPrice: number;
    costBasis?: number | null;
    markupPercent?: number | null;
    taxable: boolean;
  };
  /** When true, run a best-effort web-search enrichment of the product into a
   *  tidy name + technical description before persisting. Falls back to the raw
   *  values if the AI is rate-limited/unavailable, so import never fails. */
  aiCleanup?: boolean;
}

// #2190 — this route (POST /distributors/td-synnex/import) opts out of the auth
// middleware's ambient request transaction (SELF_MANAGED_DB_CONTEXT_ROUTES) so
// the up-to-12s enrichDistributorListing call below never runs inside a held DB
// transaction. `dbCtx` is the request's RLS DbAccessContext, rebuilt by the route
// from `auth` (dbAccessContextFromAuth) since it can no longer rely on an ambient
// one; each DB op (the getActiveIntegration read, then createCatalogItem) runs in
// its own short-lived withDbAccessContext, with enrichment running between them
// under NO ambient context.
export async function importTdSynnexCatalogItem(input: ImportTdSynnexCatalogItemInput, actor: CatalogActor, dbCtx: DbAccessContext) {
  await withDbAccessContext(dbCtx, () => getActiveIntegration(actor));
  const existingSku = input.item.sku?.trim();

  // Optional web-search enrichment: turn the raw distributor listing into a clean
  // name + a real description. On any failure keep the raw values (enriched == null).
  let name = input.item.name;
  let description = input.item.description ?? input.product.description ?? null;
  let aiProvenance: EnrichmentProvenance | undefined;
  if (input.aiCleanup) {
    const mpn = input.product.manufacturerPartNumber;
    const query = mpn ? `${input.product.name} (MPN: ${mpn})` : input.product.name;
    const enriched = await enrichDistributorListing(query, 'hardware', {
      userId: actor.userId,
      orgId: actor.accessibleOrgIds?.[0] ?? null,
    });
    if (enriched) {
      name = enriched.name;
      if (enriched.description) description = enriched.description;
      aiProvenance = enriched.provenance;
    }
  }

  // Duplicate-SKU is enforced authoritatively by createCatalogItem's partial
  // unique index (it throws CatalogServiceError DUPLICATE_SKU/409, mapped by the
  // route). A pre-check here would only add a TOCTOU race and a second error code.
  const catalogInput: CreateCatalogItemInput = {
    itemType: 'hardware',
    name,
    sku: existingSku || null,
    description,
    billingType: 'one_time',
    unitPrice: input.item.unitPrice,
    costBasis: input.item.costBasis ?? null,
    markupPercent: input.item.markupPercent ?? null,
    unitOfMeasure: 'each',
    taxable: input.item.taxable,
    taxCategory: null,
    isBundle: false,
    attributes: {
      distributor: {
        provider: 'td_synnex_digital_bridge',
        sourceProductId: input.product.sourceProductId,
        sku: input.product.sku,
        manufacturerPartNumber: input.product.manufacturerPartNumber,
        vendor: input.product.vendor,
        currency: input.product.currency,
        availability: input.product.availability,
        warehouses: input.product.warehouses,
        lastRefreshedAt: input.product.lastRefreshedAt,
        rawName: input.product.name,
        aiEnriched: aiProvenance != null,
        ...(aiProvenance ? { aiProvenance } : {}),
      }
    }
  };
  return withDbAccessContext(dbCtx, () => createCatalogItem(catalogInput, actor));
}
