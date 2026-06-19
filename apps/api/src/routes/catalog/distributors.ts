import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
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

export const catalogDistributorRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);

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
  })
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
      const data = await importTdSynnexCatalogItem(c.req.valid('json'), catalogActorFrom(c));
      return c.json({ data });
    } catch (err) {
      return handleTdSynnexError(c, err);
    }
  }
);
