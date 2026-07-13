import { eq } from 'drizzle-orm';
import { XMLParser } from 'fast-xml-parser';
import { db, withDbAccessContext, type DbAccessContext } from '../db';
import { tdSynnexEcExpressIntegrations } from '../db/schema';
import { encryptSecret, decryptForColumn } from './secretCrypto';
import { safeFetch } from './urlSafety';
import { createCatalogItem, type CatalogActor } from './catalogService';
import { enrichDistributorListing } from './catalogEnrichmentService';
import type { CreateCatalogItemInput, EnrichmentProvenance } from '@breeze/shared';

const TABLE = 'td_synnex_ec_express_integrations';
const CREDENTIALS_COLUMN = 'credentials';
export const EC_MASKED_SECRET = '********';

export const REGION_ENDPOINTS = {
  US: 'https://ws.synnex.com/webservice/pnaserviceV05',
} as const;

export type EcRegion = keyof typeof REGION_ENDPOINTS;

// Single source of truth for the HTTP status each error code maps to.
const EC_ERROR_STATUS = {
  EC_PARTNER_REQUIRED: 400,
  EC_NOT_CONFIGURED: 404,
  EC_DISABLED: 400,
  EC_CREDENTIALS_INVALID: 400,
  EC_AUTH_FAILED: 422,
  EC_PROVIDER_ERROR: 502,
  EC_NO_RESULTS: 404,
  EC_DUPLICATE_SKU: 409,
  EC_UNSUPPORTED_REGION: 400,
} as const;

export type TdSynnexEcExpressErrorCode = keyof typeof EC_ERROR_STATUS;

export class TdSynnexEcExpressError extends Error {
  public readonly status: number;
  constructor(
    message: string,
    public readonly code: TdSynnexEcExpressErrorCode = 'EC_PROVIDER_ERROR'
  ) {
    super(message);
    this.name = 'TdSynnexEcExpressError';
    this.status = EC_ERROR_STATUS[code];
  }
}

export interface TdSynnexEcExpressCredentials {
  email?: string | null;
  password?: string | null;
  customerNo?: string | null;
}

export interface TdSynnexEcExpressSettings {
  defaultWarehouse?: string;
  hideZeroInv?: boolean;
  defaultMarkupPercent?: number;
}

export interface TdSynnexEcExpressConfigInput {
  region: EcRegion;
  enabled: boolean;
  credentials?: TdSynnexEcExpressCredentials;
  settings?: TdSynnexEcExpressSettings;
}

export interface EcWarehouseStock {
  code: string | null;
  available: number;
  onOrder: number;
  bo: number;
  eta: string | null;
}

export interface TdSynnexEcProduct {
  // 'td_synnex_price_file' rows come from the nightly SFTP snapshot and reuse
  // this shape + import path. Provenance must survive: a nightly row records
  // itself as such, never as a live EC Express lookup.
  source: 'td_synnex_ec_express' | 'td_synnex_price_file';
  synnexSku: string;
  mfgPartNo: string | null;
  status: string | null;
  name: string;
  description: string | null;
  currency: string | null;
  cost: number | null;       // <price> = reseller cost
  msrp: number | null;
  discount: number | null;
  totalQty: number | null;
  warehouses: EcWarehouseStock[];
  weight: number | null;
  parcelShippable: string | null;
  raw: Record<string, unknown>;
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new TdSynnexEcExpressError('EC Express integration is partner-scoped', 'EC_PARTNER_REQUIRED');
  }
  return actor.partnerId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decryptCredential(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // A present-but-non-string credential means the stored JSONB is corrupt — fail
  // loudly with an actionable code instead of silently treating it as "absent".
  if (typeof value !== 'string') {
    throw new TdSynnexEcExpressError(
      'Stored EC Express credentials are corrupt — re-enter them',
      'EC_CREDENTIALS_INVALID'
    );
  }
  if (value.length === 0) return null;
  return decryptForColumn(TABLE, CREDENTIALS_COLUMN, value);
}

function mergeCredentialField(
  output: Record<string, unknown>,
  key: 'email' | 'password' | 'customerNo',
  value: unknown
) {
  if (value === undefined || value === EC_MASKED_SECRET) return;
  if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
    delete output[key];
    return;
  }
  if (typeof value === 'string') {
    output[key] = encryptSecret(value.trim());
  }
}

function mergeCredentials(
  existing: unknown,
  next: TdSynnexEcExpressCredentials | undefined
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...asRecord(existing) };
  if (!next) return output;
  mergeCredentialField(output, 'email', next.email);
  mergeCredentialField(output, 'password', next.password);
  mergeCredentialField(output, 'customerNo', next.customerNo);
  return output;
}

function maskConfig(row: typeof tdSynnexEcExpressIntegrations.$inferSelect | null) {
  if (!row) {
    return { configured: false, enabled: false };
  }
  const c = asRecord(row.credentials);
  const hasEmail = typeof c.email === 'string' && c.email.length > 0;
  const hasPassword = typeof c.password === 'string' && c.password.length > 0;
  const hasCustomerNo = typeof c.customerNo === 'string' && c.customerNo.length > 0;
  return {
    configured: hasEmail && hasPassword && hasCustomerNo,
    id: row.id,
    region: row.region,
    enabled: row.enabled,
    credentials: {
      email: hasEmail ? EC_MASKED_SECRET : '',
      password: hasPassword ? EC_MASKED_SECRET : '',
      customerNo: hasCustomerNo ? EC_MASKED_SECRET : '',
    },
    settings: asRecord(row.settings),
    lastTestStatus: row.lastTestStatus,
    lastTestAt: row.lastTestAt,
    lastTestError: row.lastTestError,
  };
}

export async function getEcExpressStatus(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(tdSynnexEcExpressIntegrations)
    .where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId))
    .limit(1);
  return maskConfig(row ?? null);
}

export async function saveEcExpressConfig(input: TdSynnexEcExpressConfigInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  if (!REGION_ENDPOINTS[input.region]) {
    throw new TdSynnexEcExpressError(`Unsupported region: ${input.region}`, 'EC_UNSUPPORTED_REGION');
  }
  const [current] = await db
    .select()
    .from(tdSynnexEcExpressIntegrations)
    .where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId))
    .limit(1);
  const credentials = mergeCredentials(current?.credentials, input.credentials);
  const settings = {
    defaultWarehouse: 'ANY',
    hideZeroInv: false,
    ...asRecord(current?.settings),
    ...asRecord(input.settings),
  };
  const [row] = await db
    .insert(tdSynnexEcExpressIntegrations)
    .values({
      partnerId,
      region: input.region,
      credentials,
      settings,
      enabled: input.enabled,
      createdBy: actor.userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tdSynnexEcExpressIntegrations.partnerId,
      set: {
        region: input.region,
        credentials,
        settings,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return maskConfig(row ?? null);
}

// Region endpoint resolution + credential decryption, shared by the SOAP
// price-availability call (lookup + connection test) and config validation.

export function endpointForRegion(region: string): string {
  const url = (REGION_ENDPOINTS as Record<string, string>)[region];
  if (!url) {
    throw new TdSynnexEcExpressError(`Unsupported region: ${region}`, 'EC_UNSUPPORTED_REGION');
  }
  return url;
}

export function decryptCredentials(
  row: typeof tdSynnexEcExpressIntegrations.$inferSelect
): { email: string; password: string; customerNo: string } {
  const c = asRecord(row.credentials);
  const email = decryptCredential(c.email);
  const password = decryptCredential(c.password);
  const customerNo = decryptCredential(c.customerNo);
  if (!email || !password || !customerNo) {
    throw new TdSynnexEcExpressError(
      'EC Express credentials are not fully configured',
      'EC_CREDENTIALS_INVALID'
    );
  }
  return { email, password, customerNo };
}

// SOAP envelope build, response parse, product lookup, and connection test
// against the TD SYNNEX PriceAvailability (PNA) web service.

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PNA_NS = 'http://pnaV05.model.ws.synnex.com/';
const REQUEST_TIMEOUT_MS = 15_000;

export type LookupItem =
  | { kind: 'sku'; synnexSku: string }
  | { kind: 'mpn'; mfgPartNo: string };

// Strip any occurrence of partner credentials from provider-originated fault /
// error text before it is thrown, persisted (last_test_error), or returned to
// the client. The PNA WS-Security username is `${email};${customerNo}` — redact
// that combined form too, not just the parts.
export function redactProviderError(
  msg: string,
  creds?: { email?: string | null; password?: string | null; customerNo?: string | null }
): string {
  if (!creds) return msg;
  const secrets = [
    creds.email && creds.customerNo ? `${creds.email};${creds.customerNo}` : null,
    creds.email,
    creds.customerNo,
    creds.password,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  let out = msg;
  for (const secret of secrets) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function xmlEscape(v: string): string {
  return v.replace(/[<>&'"]/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === "'" ? '&apos;' : '&quot;'
  );
}

export function buildSoapEnvelope(
  creds: { email: string; password: string; customerNo: string },
  items: LookupItem[],
  settings: TdSynnexEcExpressSettings
): string {
  const username = xmlEscape(`${creds.email};${creds.customerNo}`);
  const password = xmlEscape(creds.password);
  const warehouse = xmlEscape(settings.defaultWarehouse ?? 'ANY');
  const hideZeroInv = settings.hideZeroInv ? 'true' : 'false';
  const skuXml = items
    .map((it) =>
      it.kind === 'sku'
        ? `<skuList><synnexSku>${xmlEscape(it.synnexSku)}</synnexSku></skuList>`
        : `<skuList><mfgPartNo>${xmlEscape(it.mfgPartNo)}</mfgPartNo></skuList>`
    )
    .join('');
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:pna="${PNA_NS}">`
    + `<soapenv:Header><wsse:Security xmlns:wsse="${WSSE}"><wsse:UsernameToken>`
    + `<wsse:Username>${username}</wsse:Username><wsse:Password>${password}</wsse:Password>`
    + `</wsse:UsernameToken></wsse:Security></soapenv:Header>`
    + `<soapenv:Body><pna:getPriceAvailability><arg0>${skuXml}`
    + `<warehouse>${warehouse}</warehouse><hideZeroInv>${hideZeroInv}</hideZeroInv>`
    + `</arg0></pna:getPriceAvailability></soapenv:Body></soapenv:Envelope>`
  );
}

const pnaParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
});

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Parse a provider value into a finite number, or null. An absent / empty /
// non-numeric value (including NaN / Infinity) collapses to null.
function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

function normalizeDetail(d: Record<string, unknown>): TdSynnexEcProduct {
  const rawStock = d.stock === undefined ? [] : Array.isArray(d.stock) ? d.stock : [d.stock];
  const warehouses: EcWarehouseStock[] = (rawStock as Record<string, unknown>[]).map((s) => ({
    code: str(s['@_code']),
    available: num(s.available) ?? 0,
    onOrder: num(s.onOrder) ?? 0,
    bo: num(s.bo) ?? 0,
    eta: str(s.eta),
  }));
  // live response spells it parcelShippable (two p's); WSDL says parcelShipable — accept both.
  const parcel = str(d.parcelShippable) ?? str(d.parcelShipable);
  const msrp = numOrNull(d.msrp);
  return {
    source: 'td_synnex_ec_express',
    synnexSku: String(d.synnexSku ?? ''),
    mfgPartNo: str(d.mfgPartNo),
    status: str(d.status),
    name: str(d.description) ?? String(d.synnexSku ?? ''),
    description: str(d.description),
    currency: str(d.currency),
    cost: numOrNull(d.price),
    msrp: msrp === 0 ? null : msrp,
    discount: numOrNull(d.discount),
    totalQty: num(d.totalQty),
    warehouses,
    weight: numOrNull(d.weight),
    parcelShippable: parcel,
    raw: d,
  };
}

export function parsePnaResponse(
  xml: string,
  creds?: { email?: string | null; password?: string | null; customerNo?: string | null }
): TdSynnexEcProduct[] {
  const doc = pnaParser.parse(xml) as Record<string, any>;
  const body = doc?.Envelope?.Body;
  if (!body) throw new TdSynnexEcExpressError('Malformed TD SYNNEX response', 'EC_PROVIDER_ERROR');
  const fault = body.Fault;
  if (fault) {
    const raw = String(fault.faultstring ?? 'TD SYNNEX PA fault');
    // Auth faults surface a generic message — never echo provider auth text,
    // which may embed or reflect the submitted credentials.
    if (/login failed/i.test(raw)) {
      throw new TdSynnexEcExpressError('TD SYNNEX authentication failed', 'EC_AUTH_FAILED');
    }
    throw new TdSynnexEcExpressError(redactProviderError(raw, creds), 'EC_PROVIDER_ERROR');
  }
  const ret = body.getPriceAvailabilityResponse?.return;
  if (ret?.errorMessage) {
    throw new TdSynnexEcExpressError(redactProviderError(String(ret.errorMessage), creds), 'EC_PROVIDER_ERROR');
  }
  if (!ret?.priceAvail) return [];
  const details = Array.isArray(ret.priceAvail) ? ret.priceAvail : [ret.priceAvail];
  return (details as Record<string, unknown>[]).map(normalizeDetail);
}

async function getActiveIntegration(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(tdSynnexEcExpressIntegrations)
    .where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId))
    .limit(1);
  if (!row) throw new TdSynnexEcExpressError('EC Express is not configured', 'EC_NOT_CONFIGURED');
  if (!row.enabled) throw new TdSynnexEcExpressError('EC Express is disabled', 'EC_DISABLED');
  return row;
}

async function callPna(
  row: typeof tdSynnexEcExpressIntegrations.$inferSelect,
  items: LookupItem[]
): Promise<TdSynnexEcProduct[]> {
  const creds = decryptCredentials(row);
  const url = endpointForRegion(row.region);
  const envelope = buildSoapEnvelope(creds, items, asRecord(row.settings) as TdSynnexEcExpressSettings);
  let res: Response;
  try {
    res = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      body: envelope,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch {
    throw new TdSynnexEcExpressError('Could not reach TD SYNNEX', 'EC_PROVIDER_ERROR');
  }
  const text = await res.text();
  return parsePnaResponse(text, creds); // parse handles soap:Fault even on HTTP 500
}

export async function lookupEcExpressProducts(
  query: string,
  actor: CatalogActor
): Promise<TdSynnexEcProduct[]> {
  const row = await getActiveIntegration(actor);
  const token = query.trim();
  if (!token) throw new TdSynnexEcExpressError('Provide a SYNNEX SKU or mfg part #', 'EC_NO_RESULTS');
  const item: LookupItem = /^\d+$/.test(token)
    ? { kind: 'sku', synnexSku: token }
    : { kind: 'mpn', mfgPartNo: token };
  const products = await callPna(row, [item]);
  const found = products.filter((p) => p.status !== 'NOTFOUND');
  if (found.length === 0) throw new TdSynnexEcExpressError('No results for that SKU/part #', 'EC_NO_RESULTS');
  return found;
}

export async function testEcExpressConnection(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  // Load directly rather than via getActiveIntegration: a partner must be able to
  // run a connection test BEFORE enabling the integration, so we require it to be
  // configured but not enabled. On success/failure we persist the masked-status
  // contract that the web panel consumes (mirrors testTdSynnexDigitalBridgeConnection).
  const [row] = await db
    .select()
    .from(tdSynnexEcExpressIntegrations)
    .where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId))
    .limit(1);
  if (!row) throw new TdSynnexEcExpressError('EC Express is not configured', 'EC_NOT_CONFIGURED');
  try {
    // Any non-fault PA response (including NOTFOUND) means credentials authenticated.
    await callPna(row, [{ kind: 'sku', synnexSku: '1' }]);
    const [updated] = await db
      .update(tdSynnexEcExpressIntegrations)
      .set({ lastTestStatus: 'success', lastTestAt: new Date(), lastTestError: null, updatedAt: new Date() })
      .where(eq(tdSynnexEcExpressIntegrations.id, row.id))
      .returning();
    return maskConfig(updated ?? row);
  } catch (err) {
    await db
      .update(tdSynnexEcExpressIntegrations)
      .set({
        lastTestStatus: 'failed',
        lastTestAt: new Date(),
        lastTestError: err instanceof Error ? err.message : 'Connection test failed',
        updatedAt: new Date(),
      })
      .where(eq(tdSynnexEcExpressIntegrations.id, row.id));
    throw err;
  }
}

// Import a looked-up product into the partner catalog.

export interface EcImportInput {
  product: TdSynnexEcProduct;
  item: {
    name: string;
    sku?: string | null;
    description?: string | null;
    unitPrice: number;
    costBasis?: number | null;
    markupPercent?: number | null;
    taxable?: boolean;
  };
  /** When true, run a best-effort AI clean-up of the raw distributor title into a
   *  tidy name + description before persisting. Falls back to the raw values if
   *  the AI is rate-limited/unavailable, so import never fails because of it. */
  aiCleanup?: boolean;
}

// #2190 — this route (POST /distributors/td-synnex-ec/import) opts out of the
// auth middleware's ambient request transaction (SELF_MANAGED_DB_CONTEXT_ROUTES)
// so the up-to-12s enrichDistributorListing call below never runs inside a held
// DB transaction. `dbCtx` is the request's RLS DbAccessContext, rebuilt by the
// route from `auth` (dbAccessContextFromAuth) since it can no longer rely on an
// ambient one; the only DB op this function performs (createCatalogItem) is
// wrapped in a fresh short-lived withDbAccessContext AFTER enrichment completes.
export async function importEcExpressCatalogItem(input: EcImportInput, actor: CatalogActor, dbCtx: DbAccessContext) {
  const { product, item } = input;

  // The quote/catalog lookup flows pass the raw distributor title as item.name,
  // which is unreadable ("SPL Dell Pro 14 PC14250 ... DISTI"). When asked, run a
  // web-search enrichment to produce a clean name + a real, technical description;
  // on any failure keep the raw values (enriched == null).
  let name = item.name;
  let description = item.description ?? product.description ?? undefined;
  let aiProvenance: EnrichmentProvenance | undefined;
  if (input.aiCleanup) {
    // Anchor the lookup on the manufacturer part number when present — it pins the
    // web search to the exact SKU rather than a fuzzy title match.
    const query = product.mfgPartNo ? `${product.name} (MPN: ${product.mfgPartNo})` : product.name;
    const enriched = await enrichDistributorListing(query, 'hardware', {
      userId: actor.userId,
      orgId: actor.accessibleOrgIds?.[0] ?? null,
    });
    if (enriched) {
      name = enriched.name;
      // enrich can return a null description; keep the raw fallback in that case.
      if (enriched.description) description = enriched.description;
      aiProvenance = enriched.provenance;
    }
  }

  const payload: CreateCatalogItemInput = {
    itemType: 'hardware',
    name,
    sku: item.sku ?? product.synnexSku,
    description: description ?? undefined,
    billingType: 'one_time',
    unitPrice: item.unitPrice,
    // product.cost is numeric (numOrNull) — but guard a non-finite value out of
    // the catalog payload so it can never reach createCatalogItem as NaN.
    costBasis: item.costBasis ?? (Number.isFinite(product.cost as number) ? (product.cost as number) : undefined),
    markupPercent: item.markupPercent ?? undefined,
    unitOfMeasure: 'each',
    taxable: item.taxable ?? true,
    isBundle: false,
    attributes: {
      distributor: {
        source: product.source,
        synnexSku: product.synnexSku,
        mfgPartNo: product.mfgPartNo,
        status: product.status,
        currency: product.currency,
        cost: product.cost,
        msrp: product.msrp,
        totalQty: product.totalQty,
        weight: product.weight,
        parcelShippable: product.parcelShippable,
        warehouses: product.warehouses,
        raw: product.raw,
        importedAt: new Date().toISOString(),
        // Traceability: keep the original distributor title and, when AI
        // enrichment supplied the stored name/description, record its provenance
        // (model, query, suggestion) rather than just a boolean.
        rawName: product.name,
        aiEnriched: aiProvenance != null,
        ...(aiProvenance ? { aiProvenance } : {}),
      },
    },
  };
  return withDbAccessContext(dbCtx, () => createCatalogItem(payload, actor));
}
