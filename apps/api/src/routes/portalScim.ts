/**
 * The public SCIM 2.0 Users endpoint for the customer portal (portal
 * registration W9 #11386, plan D8, D9). Mounted at
 * `/api/v1/scim/portal/v2` — the Tenant URL an Entra enterprise app is given.
 *
 * No session auth: the caller authenticates with an org's SCIM bearer token
 * (services/portalScim/tokens.ts). Classified as a public router in
 * routerAuthGate.contract.test.ts and writeRoutePermissionGate.contract.test.ts;
 * partnerGuard skips the path (middleware/partnerGuard.ts) and the global
 * limiter meters it in its own per-IP bucket (middleware/globalRateLimit.ts).
 *
 * ORDER (D9): body limit → well-formedness (no Redis, no DB) → failure bucket per (token id, IP)
 * (over the limit ⇒ 429 before any lookup) → token lookup + compare → tenant
 * and org checks → per-org bucket → handler. Every authentication failure is
 * ONE fixed 401 body, whatever the reason.
 *
 * The router holds no DB context; the services open their own.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getRedis, rateLimiter } from '../services';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { captureException } from '../services/sentry';
import {
  SCIM_CONTENT_TYPE,
  SCIM_USER_SCHEMA,
  ScimError,
  parseCreateBody,
  parseListParams,
  parsePatchBody,
  parsePutBody,
  parseScimFilter,
  scimErrorBody,
  scimListResponse,
  toScimUser,
} from '../services/portalScim/protocol';
import { authenticatePortalScimToken, parseScimBearer, type VerifiedScimToken } from '../services/portalScim/tokens';
import {
  createScimUser,
  deleteScimUser,
  getScimUser,
  listScimUsers,
  patchScimUser,
  replaceScimUser,
} from '../services/portalScim/users';

export const PORTAL_SCIM_BASE_PATH = '/api/v1/scim/portal/v2';
const BODY_LIMIT_BYTES = 64 * 1024;
/** Failed authentications per (token id, normalized client IP) before lookups stop (OD4). */
const AUTH_FAIL_LIMIT = 300;
const AUTH_FAIL_WINDOW_S = 300;
/** Unknown-token-id failures per normalized client IP (id guessing) before lookups stop (OD4). */
const UNKNOWN_ID_LIMIT = 600;
/** Authenticated requests per org (OD4); Entra backs off on 429 + Retry-After. */
const ORG_LIMIT = 3000;
const ORG_WINDOW_S = 60;

type Env = { Variables: { scimToken: VerifiedScimToken } };

const AUTH_FAILED_DETAIL = 'Authentication failed.';

function scimJson(c: Context, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': `${SCIM_CONTENT_TYPE}; charset=utf-8`, 'Cache-Control': 'no-store' },
  });
}

function scimError(c: Context, status: number, detail: string, scimType?: ScimError['scimType'], headers?: Record<string, string>): Response {
  const res = scimJson(c, status, scimErrorBody(status, detail, scimType));
  for (const [k, v] of Object.entries(headers ?? {})) res.headers.set(k, v);
  return res;
}

/** The one 401 every authentication failure answers with (inv. 8 / Review Focus 2). */
const unauthorized = (c: Context) => scimError(c, 401, AUTH_FAILED_DETAIL, undefined, { 'WWW-Authenticate': 'Bearer' });

function tooMany(c: Context, retryAfterSeconds: number): Response {
  return scimError(c, 429, 'Too many requests.', undefined, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });
}

function retryAfter(resetAt: Date | undefined, fallbackSeconds: number): number {
  if (!resetAt) return fallbackSeconds;
  return (resetAt.getTime() - Date.now()) / 1000;
}

/**
 * Read-only: has this address spent its failure budget? Reads the same sorted
 * set `rateLimiter` writes (one member per failure, scored by time) without
 * adding to it, so a valid token's requests never consume the failure budget.
 * Redis unavailable or erroring fails closed, like `rateLimiter`.
 */
async function failureBudgetSpent(redis: ReturnType<typeof getRedis>, key: string, limit: number): Promise<boolean> {
  if (!redis) return true;
  try {
    const n = await redis.zcount(key, Date.now() - AUTH_FAIL_WINDOW_S * 1000, '+inf');
    return n >= limit;
  } catch {
    return true;
  }
}

const scimAuth: MiddlewareHandler<Env> = async (c, next) => {
  // A missing or malformed token never reaches Redis or the database: the same
  // 401. It costs nothing to answer, so it spends no budget.
  const authorization = c.req.header('Authorization');
  const parsed = parseScimBearer(authorization);
  if (!parsed) return unauthorized(c);

  // Two failure budgets (D9):
  //  - per (token id, address), checked BEFORE the lookup: a real token
  //    refused (wrong secret, revoked, proof or org changed). Keyed on the id
  //    too, so another tenant's bad token on Microsoft's shared egress never
  //    locks out this org's token, and someone who learns a token id cannot
  //    lock out the address Entra uses. It is the only gate a real token id
  //    ever meets;
  //  - per address, applied only AFTER a lookup miss: ids that name no row
  //    (guessing). A real token id is never refused because of it. Lookup
  //    volume per address is bounded by the global limiter's isolated 'scim'
  //    bucket; a primary-key miss is cheap.
  const redis = getRedis();
  const ip = rateLimitIpKey(getTrustedClientIp(c, 'unknown'));
  const tokenFailKey = `portal_scim_auth_fail:${parsed.tokenId}:${ip}`;
  const unknownIdKey = `portal_scim_unknown_id:${ip}`;
  if (await failureBudgetSpent(redis, tokenFailKey, AUTH_FAIL_LIMIT)) return tooMany(c, AUTH_FAIL_WINDOW_S);

  const auth = await authenticatePortalScimToken(authorization);
  if (!auth.ok) {
    if (auth.unknownId) {
      if (await failureBudgetSpent(redis, unknownIdKey, UNKNOWN_ID_LIMIT)) return tooMany(c, AUTH_FAIL_WINDOW_S);
      await rateLimiter(redis, unknownIdKey, UNKNOWN_ID_LIMIT, AUTH_FAIL_WINDOW_S);
    } else {
      await rateLimiter(redis, tokenFailKey, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_S);
    }
    return unauthorized(c);
  }
  const token = auth.token;

  const perOrg = await rateLimiter(redis, `portal_scim_org:${token.orgId}`, ORG_LIMIT, ORG_WINDOW_S, 1, { refundOnReject: true });
  if (!perOrg.allowed) return tooMany(c, retryAfter(perOrg.resetAt, ORG_WINDOW_S));

  c.set('scimToken', token);
  await next();
};

/** A ScimError → its SCIM body (a 401 from a service, e.g. a token revoked mid-request, is the uniform 401). */
function handleError(err: unknown, c: Context): Response {
  if (err instanceof ScimError) {
    if (err.status === 401) return unauthorized(c);
    return scimError(c, err.status, err.message, err.scimType);
  }
  // This router's onError replaces the app-level handler, so report here. The
  // response body stays generic; the error goes to logs and Sentry (no PII is
  // put in these messages — services log ids only).
  console.error('[portal-scim] request failed', {
    error: err instanceof Error ? err.name : 'unknown',
    message: err instanceof Error ? err.message : String(err),
  });
  captureException(err instanceof Error ? err : new Error(String(err)), c, { area: 'portal_scim' });
  return scimError(c, 500, 'The request could not be completed.');
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ScimError(400, 'The request body must be JSON.', 'invalidSyntax');
  }
}

const SERVICE_PROVIDER_CONFIG = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://docs.breezermm.com/features/portal-entra-scim/',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 100 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{
    type: 'oauthbearertoken',
    name: 'Bearer token',
    description: 'The provisioning token created on the organization\'s Portal settings.',
  }],
};

const RESOURCE_TYPES = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
  totalResults: 1,
  startIndex: 1,
  itemsPerPage: 1,
  Resources: [{
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    schema: SCIM_USER_SCHEMA,
  }],
};

const USER_SCHEMA_DOC = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
  totalResults: 1,
  startIndex: 1,
  itemsPerPage: 1,
  Resources: [{
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: SCIM_USER_SCHEMA,
    name: 'User',
    attributes: [
      { name: 'userName', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'server' },
      { name: 'externalId', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'immutable', returned: 'default', uniqueness: 'server' },
      { name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
      { name: 'displayName', type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default' },
      {
        name: 'name', type: 'complex', multiValued: false, required: false, mutability: 'readWrite', returned: 'default',
        subAttributes: [
          { name: 'givenName', type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default' },
          { name: 'familyName', type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default' },
        ],
      },
    ],
  }],
};

export function createPortalScimRoutes(): Hono<Env> {
  const routes = new Hono<Env>();

  routes.use('*', bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => scimError(c, 413, 'The request body is too large.'),
  }));
  routes.use('*', scimAuth);
  routes.onError(handleError);

  routes.get('/ServiceProviderConfig', (c) => scimJson(c, 200, SERVICE_PROVIDER_CONFIG));
  routes.get('/ResourceTypes', (c) => scimJson(c, 200, RESOURCE_TYPES));
  routes.get('/Schemas', (c) => scimJson(c, 200, USER_SCHEMA_DOC));

  routes.get('/Users', async (c) => {
    const token = c.get('scimToken');
    const filterParam = c.req.query('filter');
    const filter = filterParam === undefined ? null : parseScimFilter(filterParam);
    const page = parseListParams({ startIndex: c.req.query('startIndex'), count: c.req.query('count') });
    const { total, records } = await listScimUsers(token, filter, page);
    return scimJson(c, 200, scimListResponse(records.map(toScimUser), total, page.startIndex));
  });

  routes.get('/Users/:id', async (c) => {
    const record = await getScimUser(c.get('scimToken'), c.req.param('id'));
    return scimJson(c, 200, toScimUser(record));
  });

  routes.post('/Users', async (c) => {
    const attrs = parseCreateBody(await readJson(c));
    const { record } = await createScimUser(c.get('scimToken'), attrs);
    return scimJson(c, 201, toScimUser(record));
  });

  routes.put('/Users/:id', async (c) => {
    const attrs = parsePutBody(await readJson(c));
    const record = await replaceScimUser(c.get('scimToken'), c.req.param('id'), attrs);
    return scimJson(c, 200, toScimUser(record));
  });

  routes.patch('/Users/:id', async (c) => {
    const patch = parsePatchBody(await readJson(c));
    const record = await patchScimUser(c.get('scimToken'), c.req.param('id'), patch);
    return scimJson(c, 200, toScimUser(record));
  });

  routes.delete('/Users/:id', async (c) => {
    await deleteScimUser(c.get('scimToken'), c.req.param('id'));
    return new Response(null, { status: 204 });
  });

  // Groups, Bulk, /Me and anything else (Users only, spec §3 non-goal).
  routes.all('*', (c) => scimError(c, 404, 'Resource not found.'));

  return routes;
}

export const portalScimRoutes = createPortalScimRoutes();
