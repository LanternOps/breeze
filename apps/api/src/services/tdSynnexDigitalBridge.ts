import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { catalogItems, tdSynnexDigitalBridgeIntegrations } from '../db/schema';
import { encryptSecret, decryptForColumn } from './secretCrypto';
import { createCatalogItem, type CatalogActor } from './catalogService';
import type { CreateCatalogItemInput } from '@breeze/shared';
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

export class TdSynnexDigitalBridgeError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 404 | 409 | 502 = 400,
    public code:
      | 'TD_SYNNEX_NOT_CONFIGURED'
      | 'TD_SYNNEX_DISABLED'
      | 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED'
      | 'TD_SYNNEX_AUTH_FAILED'
      | 'TD_SYNNEX_PROVIDER_ERROR'
      | 'TD_SYNNEX_NO_RESULTS'
      | 'TD_SYNNEX_DUPLICATE_SKU' = 'TD_SYNNEX_PROVIDER_ERROR'
  ) {
    super(message);
    this.name = 'TdSynnexDigitalBridgeError';
  }
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX integration is partner-scoped', 400, 'TD_SYNNEX_NOT_CONFIGURED');
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
  if (typeof value !== 'string' || value.length === 0) return null;
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
    throw new TdSynnexDigitalBridgeError('TD SYNNEX base URL must be a valid URL', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }

  if (parsed.username || parsed.password) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX base URL cannot include credentials', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }

  const ssrf = checkSsrfSafe(parsed.toString(), { mode: 'strict-https' });
  if (!ssrf.ok) {
    throw new TdSynnexDigitalBridgeError(`TD SYNNEX base URL rejected: ${ssrf.reason}`, 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

export function normalizeTdSynnexEndpointPath(path: string): string {
  const value = path.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX endpoint paths must be relative paths beginning with /', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
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
  return {
    configured: hasApiKey,
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
    throw new TdSynnexDigitalBridgeError('TD SYNNEX Digital Bridge is not configured', 404, 'TD_SYNNEX_NOT_CONFIGURED');
  }
  if (!row.enabled) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX Digital Bridge is disabled', 400, 'TD_SYNNEX_DISABLED');
  }
  return row;
}

function endpointUrl(baseUrl: string, path: string, params?: Record<string, string | number | undefined>): string {
  const safeBaseUrl = normalizeTdSynnexBaseUrl(baseUrl);
  const safePath = normalizeTdSynnexEndpointPath(path);
  const url = new URL(safePath, safeBaseUrl.endsWith('/') ? safeBaseUrl : `${safeBaseUrl}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && String(value).length > 0) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function authHeaders(row: typeof tdSynnexDigitalBridgeIntegrations.$inferSelect): HeadersInit {
  const credentials = asRecord(row.credentials);
  const apiKey = decryptCredential(credentials.apiKey);
  const apiSecret = decryptCredential(credentials.apiSecret);
  const authType = asAuthType(row.authType);
  if (!apiKey) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX API key is not configured', 400, 'TD_SYNNEX_NOT_CONFIGURED');
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
  let response: Response;
  try {
    response = await safeFetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...authHeaders(row)
      },
      body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
      timeoutMs: requestTimeoutMs()
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw new TdSynnexDigitalBridgeError('TD SYNNEX base URL resolved to a blocked address', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
    }
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('timed out'));
    throw new TdSynnexDigitalBridgeError(
      isTimeout ? 'TD SYNNEX request timed out' : 'TD SYNNEX request failed',
      502,
      'TD_SYNNEX_PROVIDER_ERROR'
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX rejected the configured credentials', 401, 'TD_SYNNEX_AUTH_FAILED');
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) as unknown : null;
  } catch {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX returned an invalid JSON response', 502, 'TD_SYNNEX_PROVIDER_ERROR');
  }
  if (!response.ok) {
    throw new TdSynnexDigitalBridgeError(`TD SYNNEX request failed with HTTP ${response.status}`, 502, 'TD_SYNNEX_PROVIDER_ERROR');
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
  return productArray(payload).map((product, index) => {
    const sourceProductId = pickString(product, ['id', 'productId', 'itemId', 'tdSynnexItemId', 'sku', 'partNumber']) ?? `result-${index}`;
    const sku = pickString(product, ['sku', 'tdSku', 'tdSynnexSku', 'itemNumber', 'partNumber']);
    const name = pickString(product, ['name', 'title', 'productName', 'description']) ?? sku ?? sourceProductId;
    const cost = pickNumber(product, ['cost', 'price', 'netPrice', 'dealerPrice', 'unitCost']);
    return {
      source: 'td_synnex_digital_bridge',
      sourceProductId,
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
    };
  });
}

export async function testTdSynnexDigitalBridgeConnection(actor: CatalogActor) {
  const row = await getActiveIntegration(actor);
  const settings = asRecord(row.settings);
  const testPath = asString(settings.testPath);
  if (!testPath) {
    throw new TdSynnexDigitalBridgeError('TD SYNNEX test endpoint path is not configured', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
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
    throw new TdSynnexDigitalBridgeError('TD SYNNEX search endpoint path is not configured', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  }
  const accountId = asString(settings.accountId);
  const method = asMethod(settings.searchMethod);
  const payload = await requestDigitalBridge(row, searchPath, {
    method,
    query: { q: query.q, query: query.q, limit: query.limit, region: row.region, accountId },
    body: { q: query.q, query: query.q, limit: query.limit, region: row.region, accountId }
  });
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
}

export async function importTdSynnexCatalogItem(input: ImportTdSynnexCatalogItemInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  await getActiveIntegration(actor);
  const existingSku = input.item.sku?.trim();
  if (existingSku) {
    const existing = await db
      .select({ id: catalogItems.id })
      .from(catalogItems)
      .where(and(eq(catalogItems.partnerId, partnerId), eq(catalogItems.sku, existingSku)))
      .limit(1);
    if (existing.length > 0) {
      throw new TdSynnexDigitalBridgeError('An item with this SKU already exists', 409, 'TD_SYNNEX_DUPLICATE_SKU');
    }
  }
  const catalogInput: CreateCatalogItemInput = {
    itemType: 'hardware',
    name: input.item.name,
    sku: existingSku || null,
    description: input.item.description ?? input.product.description ?? null,
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
        lastRefreshedAt: input.product.lastRefreshedAt
      }
    }
  };
  return createCatalogItem(catalogInput, actor);
}
