import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireMfa, requirePermission, requireScope, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { checkSsrfSafe } from '../../services/ssrfGuard';
import { CatalogServiceError } from '../../services/catalogService';
import { catalogActorFrom } from './catalog';
import {
  getTdSynnexDigitalBridgeStatus,
  importTdSynnexCatalogItem,
  saveTdSynnexDigitalBridgeConfig,
  searchTdSynnexProducts,
  testTdSynnexDigitalBridgeConnection,
  TdSynnexDigitalBridgeError,
} from '../../services/tdSynnexDigitalBridge';
import {
  getEcExpressStatus,
  saveEcExpressConfig,
  testEcExpressConnection,
  lookupEcExpressProducts,
  importEcExpressCatalogItem,
  TdSynnexEcExpressError,
  REGION_ENDPOINTS,
  type EcRegion,
} from '../../services/tdSynnexEcExpress';
import {
  getPax8CatalogStatus,
  searchPax8Products,
  getPax8ProductPricing,
  importPax8CatalogItem,
  Pax8CatalogError,
} from '../../services/pax8CatalogService';
import {
  getSftpStatus,
  saveSftpConfig,
  testSftpConnection,
  listSftpPriceRows,
  getSftpIntegrationId,
  TdSynnexSftpError,
} from '../../services/tdSynnexSftpSync';
import { enqueueTdSynnexSftpSync } from '../../jobs/tdSynnexSftpSyncWorker';

export const catalogDistributorRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);

// #2190 — the three import routes below opt out of the auth middleware's
// ambient request transaction (SELF_MANAGED_DB_CONTEXT_ROUTES) so the best-effort
// AI enrichment call the import services make doesn't hold a pooled connection
// idle-in-transaction across it. Rebuild the request's RLS DbAccessContext here
// (mirroring `dbAccessContextFromAuth`'s single-source-of-truth mapping from
// `auth`) and pass it into the import service, which wraps its own short DB ops
// in it AFTER enrichment completes.
function catalogDbContextFrom(c: { get: (k: string) => unknown }) {
  return dbAccessContextFromAuth(c.get('auth') as AuthContext);
}

const baseUrlSchema = z.string().url().max(2000).superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  if (parsed.username || parsed.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Base URL cannot include credentials' });
    return;
  }
  const result = checkSsrfSafe(value, { mode: 'strict-https' });
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason ?? 'Base URL is not allowed' });
  }
});

const pathSchema = z.string().max(500).optional()
  .transform((v) => v?.trim() || undefined)
  .refine(
    (value) => !value || (
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !/[\r\n]/.test(value) &&
      !/^[a-z][a-z0-9+.-]*:/i.test(value)
    ),
    { message: 'Endpoint path must be a relative path beginning with /' }
  );
const configSchema = z.object({
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  region: z.string().min(1).max(50).default('US'),
  baseUrl: baseUrlSchema,
  authType: z.enum(['api_key', 'bearer', 'basic']).default('api_key'),
  enabled: z.boolean().default(false),
  credentials: z.object({
    apiKey: z.string().max(10_000).nullable().optional(),
    apiSecret: z.string().max(10_000).nullable().optional(),
  }).optional(),
  settings: z.object({
    accountId: z.string().max(100).optional(),
    testPath: pathSchema,
    searchPath: pathSchema,
    searchMethod: z.enum(['GET', 'POST']).default('GET'),
    detailsPath: pathSchema,
    availabilityPath: pathSchema,
  }).optional()
});

const searchQuerySchema = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const productSchema = z.object({
  source: z.literal('td_synnex_digital_bridge'),
  sourceProductId: z.string().min(1).max(255),
  sku: z.string().max(255).nullable(),
  manufacturerPartNumber: z.string().max(255).nullable(),
  vendor: z.string().max(255).nullable(),
  name: z.string().min(1).max(500),
  description: z.string().max(10_000).nullable(),
  // Normalized money string (matches normalizeTdSynnexProducts' toFixed(2) output).
  cost: z.string().regex(/^-?\d+\.\d{2}$/).max(30).nullable(),
  currency: z.string().max(10).nullable(),
  availability: z.number().nullable(),
  warehouses: z.array(z.record(z.string(), z.unknown())).max(200),
  // Provider passthrough — not persisted, but bound the inbound size so a partner
  // can't post a multi-MB blob through the import endpoint.
  raw: z.record(z.string(), z.unknown()).refine(
    (v) => JSON.stringify(v).length <= 200_000,
    { message: 'raw product payload is too large' }
  ),
  lastRefreshedAt: z.string().max(100)
});

const money = z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01);
const importSchema = z.object({
  product: productSchema,
  item: z.object({
    name: z.string().min(1).max(255),
    sku: z.string().max(100).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    unitPrice: money,
    costBasis: money.nullable().optional(),
    markupPercent: z.number().min(0).max(9999.99).multipleOf(0.01).nullable().optional(),
    taxable: z.boolean().default(true),
  }),
  aiCleanup: z.boolean().optional(),
});

function handleTdSynnexError(c: { json: (body: unknown, status: number) => Response }, err: unknown): Response {
  if (err instanceof TdSynnexDigitalBridgeError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  // createCatalogItem (used by import) surfaces duplicate-SKU / price-range as a
  // typed CatalogServiceError — map it instead of letting it fall through to a 500.
  if (err instanceof CatalogServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  // Genuinely unexpected (DB outage, etc.): tag it so the Sentry entry from the
  // global onError handler is attributable to this integration, then re-throw.
  console.error('[td-synnex] unexpected error', err);
  throw err;
}

catalogDistributorRoutes.get('/distributors/td-synnex/status', scopes, readPerm, async (c) => {
  try {
    const data = await getTdSynnexDigitalBridgeStatus(catalogActorFrom(c));
    return c.json({ data });
  } catch (err) {
    return handleTdSynnexError(c, err);
  }
});

catalogDistributorRoutes.put(
  '/distributors/td-synnex/config',
  scopes,
  writePerm,
  requireMfa(),
  zValidator('json', configSchema),
  async (c) => {
    try {
      const data = await saveTdSynnexDigitalBridgeConfig(c.req.valid('json'), catalogActorFrom(c));
      return c.json({ data });
    } catch (err) {
      return handleTdSynnexError(c, err);
    }
  }
);

catalogDistributorRoutes.post('/distributors/td-synnex/test', scopes, writePerm, requireMfa(), async (c) => {
  try {
    const data = await testTdSynnexDigitalBridgeConnection(catalogActorFrom(c));
    return c.json({ data });
  } catch (err) {
    return handleTdSynnexError(c, err);
  }
});

catalogDistributorRoutes.get(
  '/distributors/td-synnex/search',
  scopes,
  readPerm,
  zValidator('query', searchQuerySchema),
  async (c) => {
    try {
      const data = await searchTdSynnexProducts(c.req.valid('query'), catalogActorFrom(c));
      return c.json({ data });
    } catch (err) {
      return handleTdSynnexError(c, err);
    }
  }
);

catalogDistributorRoutes.post(
  '/distributors/td-synnex/import',
  scopes,
  writePerm,
  requireMfa(),
  zValidator('json', importSchema),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const data = await importTdSynnexCatalogItem(
        { product: body.product, item: body.item, aiCleanup: body.aiCleanup },
        catalogActorFrom(c),
        catalogDbContextFrom(c),
      );
      return c.json({ data });
    } catch (err) {
      return handleTdSynnexError(c, err);
    }
  }
);

// ─── TD SYNNEX EC Express ─────────────────────────────────────────────────────

const ecConfigSchema = z.object({
  region: z.enum(Object.keys(REGION_ENDPOINTS) as [EcRegion, ...EcRegion[]]).default('US'),
  enabled: z.boolean().default(false),
  credentials: z.object({
    email: z.string().max(320).nullable().optional(),
    password: z.string().max(1000).nullable().optional(),
    customerNo: z.string().max(64).nullable().optional(),
  }).optional(),
  settings: z.object({
    defaultWarehouse: z.string().max(16).optional(),
    hideZeroInv: z.boolean().optional(),
    defaultMarkupPercent: z.number().min(0).max(9999.99).optional(),
  }).optional(),
});

const ecLookupSchema = z.object({ q: z.string().min(1).max(40) });

// Typed, bounded mirror of TdSynnexEcProduct — mirrors the Digital Bridge
// productSchema above. Replaces the prior `z.record(z.string(), z.unknown())`
// so the import endpoint validates shape and bounds the inbound payload size.
const ecProductSchema = z.object({
  source: z.literal('td_synnex_ec_express'),
  synnexSku: z.string().min(1).max(64),
  mfgPartNo: z.string().max(255).nullable(),
  status: z.string().max(64).nullable(),
  name: z.string().min(1).max(500),
  description: z.string().max(10_000).nullable(),
  currency: z.string().max(10).nullable(),
  cost: z.number().nullable(),
  msrp: z.number().nullable(),
  discount: z.number().nullable(),
  totalQty: z.number().nullable(),
  weight: z.number().nullable(),
  parcelShippable: z.string().max(16).nullable(),
  warehouses: z.array(z.object({
    code: z.string().max(64).nullable(),
    available: z.number(),
    onOrder: z.number(),
    bo: z.number(),
    eta: z.string().max(64).nullable(),
  })).max(200),
  // Provider passthrough — not persisted as-is, but bound the inbound size so a
  // partner can't post a multi-MB blob through the import endpoint.
  raw: z.record(z.string(), z.unknown()).refine(
    (v) => JSON.stringify(v).length <= 200_000,
    { message: 'raw payload too large' }
  ),
});

const ecImportSchema = z.object({
  product: ecProductSchema,
  item: z.object({
    name: z.string().min(1).max(255),
    sku: z.string().max(100).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    unitPrice: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01),
    costBasis: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01).nullable().optional(),
    markupPercent: z.number().min(0).max(9999.99).multipleOf(0.01).nullable().optional(),
    taxable: z.boolean().optional(),
  }),
  aiCleanup: z.boolean().optional(),
});

function handleEcError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TdSynnexEcExpressError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error('[td-synnex-ec] unexpected error', err);
  throw err;
}

catalogDistributorRoutes.get('/distributors/td-synnex-ec/status', scopes, readPerm, async (c) => {
  try { return c.json({ data: await getEcExpressStatus(catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});

catalogDistributorRoutes.put('/distributors/td-synnex-ec/config', scopes, writePerm, requireMfa(), zValidator('json', ecConfigSchema), async (c) => {
  try { return c.json({ data: await saveEcExpressConfig(c.req.valid('json'), catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});

catalogDistributorRoutes.post('/distributors/td-synnex-ec/test', scopes, writePerm, requireMfa(), async (c) => {
  try { return c.json({ data: await testEcExpressConnection(catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});

catalogDistributorRoutes.get('/distributors/td-synnex-ec/lookup', scopes, readPerm, zValidator('query', ecLookupSchema), async (c) => {
  try { return c.json({ data: await lookupEcExpressProducts(c.req.valid('query').q, catalogActorFrom(c)) }); } catch (err) { return handleEcError(c, err); }
});

catalogDistributorRoutes.post('/distributors/td-synnex-ec/import', scopes, writePerm, requireMfa(), zValidator('json', ecImportSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await importEcExpressCatalogItem({ product: body.product, item: body.item, aiCleanup: body.aiCleanup }, catalogActorFrom(c), catalogDbContextFrom(c));
    return c.json({ data });
  } catch (err) { return handleEcError(c, err); }
});

// ─── TD SYNNEX nightly SFTP P&A file ──────────────────────────────────────────

const sftpConfigSchema = z.object({
  region: z.enum(['US', 'CA']).optional(),
  // Numeric-only: the username ('u'/'c' + account) and remote filename
  // (<account>.zip) are derived from it, so a stray character breaks both.
  accountNumber: z.string().regex(/^\d{1,32}$/).nullable().optional(),
  password: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

const sftpListSchema = z.object({
  q: z.string().max(120).optional(),
  inStockOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function handleSftpError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TdSynnexSftpError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error('[td-synnex-sftp] unexpected error', err);
  throw err;
}

catalogDistributorRoutes.get('/distributors/td-synnex-sftp/status', scopes, readPerm, async (c) => {
  try { return c.json({ data: await getSftpStatus(catalogActorFrom(c)) }); } catch (err) { return handleSftpError(c, err); }
});

catalogDistributorRoutes.put('/distributors/td-synnex-sftp/config', scopes, writePerm, requireMfa(), zValidator('json', sftpConfigSchema), async (c) => {
  try { return c.json({ data: await saveSftpConfig(catalogActorFrom(c), c.req.valid('json')) }); } catch (err) { return handleSftpError(c, err); }
});

// Registered in SELF_MANAGED_DB_CONTEXT_ROUTES: no ambient transaction is open
// for this handler, so the SSH handshake never pins a pooled connection (#1448).
catalogDistributorRoutes.post('/distributors/td-synnex-sftp/test', scopes, writePerm, requireMfa(), async (c) => {
  try {
    return c.json({ data: await testSftpConnection(catalogActorFrom(c), catalogDbContextFrom(c)) });
  } catch (err) { return handleSftpError(c, err); }
});

// Manual "sync now". Enqueues rather than running inline: the download+parse can
// take minutes and must not hold the request's DB connection open (#1105).
catalogDistributorRoutes.post('/distributors/td-synnex-sftp/sync', scopes, writePerm, requireMfa(), async (c) => {
  try {
    const integrationId = await getSftpIntegrationId(catalogActorFrom(c));
    const jobId = await enqueueTdSynnexSftpSync(integrationId);
    return c.json({ data: { queued: true, jobId } });
  } catch (err) { return handleSftpError(c, err); }
});

catalogDistributorRoutes.get('/distributors/td-synnex-sftp/products', scopes, readPerm, zValidator('query', sftpListSchema), async (c) => {
  try {
    const { q, limit, offset, inStockOnly } = c.req.valid('query');
    return c.json({ data: await listSftpPriceRows(catalogActorFrom(c), { q, limit, offset, inStockOnly }) });
  } catch (err) { return handleSftpError(c, err); }
});

// ─── Pax8 product catalog ─────────────────────────────────────────────────────

const pax8SearchSchema = z.object({
  q: z.string().min(2).max(200),
  vendor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const pax8PricingSchema = z.object({ productId: z.string().min(1).max(64) });

const pax8ProductSchema = z.object({
  source: z.literal('pax8'),
  pax8ProductId: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  vendorName: z.string().max(255).nullable(),
  vendorSku: z.string().max(255).nullable(),
  commitmentTerm: z.string().max(120).nullable(),
  billingTerm: z.string().max(120).nullable(),
  partnerBuyRate: z.string().regex(/^-?\d+\.\d{2}$/).max(30).nullable(),
  currency: z.string().max(10).nullable(),
  raw: z.record(z.string(), z.unknown()).refine(
    (v) => JSON.stringify(v).length <= 200_000,
    { message: 'raw product payload is too large' },
  ),
});

const pax8ImportSchema = z.object({
  product: pax8ProductSchema,
  item: z.object({
    name: z.string().min(1).max(255),
    sku: z.string().max(100).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    unitPrice: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01),
    costBasis: z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01).nullable().optional(),
    taxable: z.boolean().optional(),
  }),
  aiCleanup: z.boolean().optional(),
});

function handlePax8Error(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof Pax8CatalogError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error('[pax8-catalog] unexpected error', err);
  throw err;
}

catalogDistributorRoutes.get('/distributors/pax8/status', scopes, readPerm, async (c) => {
  try { return c.json({ data: await getPax8CatalogStatus(catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});

catalogDistributorRoutes.get('/distributors/pax8/search', scopes, readPerm, zValidator('query', pax8SearchSchema), async (c) => {
  try { return c.json({ data: await searchPax8Products(c.req.valid('query'), catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});

catalogDistributorRoutes.get('/distributors/pax8/pricing', scopes, readPerm, zValidator('query', pax8PricingSchema), async (c) => {
  try { return c.json({ data: await getPax8ProductPricing(c.req.valid('query').productId, catalogActorFrom(c)) }); } catch (err) { return handlePax8Error(c, err); }
});

catalogDistributorRoutes.post('/distributors/pax8/import', scopes, writePerm, requireMfa(), zValidator('json', pax8ImportSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await importPax8CatalogItem(
      { product: body.product, item: body.item, aiCleanup: body.aiCleanup },
      catalogActorFrom(c),
      catalogDbContextFrom(c),
    );
    return c.json({ data });
  } catch (err) { return handlePax8Error(c, err); }
});
