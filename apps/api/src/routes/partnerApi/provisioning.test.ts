import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
// Deliberately NOT mocked: asserting against the real peppered/unpeppered
// hashers is what makes a swap between them a test failure.
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';
const KEY_ROW_ID = '77777777-7777-4777-8777-777777777777';
const CREATED_AT = new Date('2026-08-01T12:00:00.000Z');
const UPDATED_AT = new Date('2026-08-02T12:00:00.000Z');

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  execute: vi.fn(),
  audit: vi.fn(async () => undefined),
  assertTtlWithinCap: vi.fn(async () => null as string | null),
  partnerContexts: [] as unknown[],
  systemContextOpens: 0,
  // Populated in beforeEach — vi.hoisted runs before module-level constants.
  accessibleOrgIds: [] as string[],
  principalExpiresAt: null as Date | null,
  sourceCidrs: [] as string[],
  rateLimiter: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    update: mocks.update,
    execute: mocks.execute,
    transaction: mocks.transaction,
  },
  hasDbAccessContext: () => true,
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (ctx: unknown, fn: () => unknown) => {
    mocks.partnerContexts.push(ctx);
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    mocks.systemContextOpens += 1;
    return fn();
  },
}));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: mocks.audit,
  requestLikeFromSnapshot: (value: unknown) => value,
}));
vi.mock('../../services/enrollmentDefaults', () => ({
  assertTtlWithinCap: mocks.assertTtlWithinCap,
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      name: 'migration-bot',
      rateLimit: 1000,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
      // enrollment-keys:write requires both of these; individual tests clear
      // them to assert the 403.
      principalExpiresAt: mocks.principalExpiresAt,
      sourceCidrs: mocks.sourceCidrs,
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));

import { partnerApiRoutes } from './index';
// The real index name, from the schema declaration itself — a hand-typed
// literal here could drift from the index the route actually has to match.
import { ORG_SLUG_UNIQUE_INDEX } from '../../db/schema/orgs';

type QueryResult = unknown[] | Error;

function selectBuilder(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return builder;
}

let selectResults: QueryResult[] = [];
let insertResults: QueryResult[] = [];
let insertedValues: unknown[] = [];

function primeDb() {
  mocks.select.mockImplementation(() => selectBuilder(selectResults.shift() ?? []));
  mocks.insert.mockImplementation(() => ({
    values: vi.fn((values: unknown) => {
      insertedValues.push(values);
      const result = insertResults.shift() ?? [];
      return {
        returning: vi.fn(() =>
          result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
        ),
      };
    }),
  }));
  mocks.execute.mockResolvedValue([]);
}

const app = new Hono();
app.route('/', partnerApiRoutes);

function post(path: string, scope: string, body: unknown, apiKey = 'test-key') {
  return app.request(path, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'X-Test-Scopes': scope, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * The error shape `drizzle-orm/postgres-js` actually throws — a wrapper whose
 * own `.code` is `undefined`, carrying the postgres.js `PostgresError`
 * (SQLSTATE + `constraint_name`) on `.cause`. `utils/pgErrors.ts` documents
 * why that shape matters; what matters HERE is that the old fixture was a flat
 * `{ code: '23505' }` object, which the driver never produces for a
 * Drizzle-issued statement. A check reading only the top-level `.code` passes
 * against such a fixture while being dead in production — that is how this bug
 * class survives its own tests. Every fixture in this file is built through
 * this helper so a regression cannot hide behind an unrealistic error object.
 *
 * Faithful in the fields the check reads — the cause chain, `code`,
 * `constraint_name`, and the message — not a `DrizzleQueryError` instance.
 * The real class leaves `.name` as `'Error'` (only `.constructor.name` says
 * `DrizzleQueryError`), so the wrapper here does the same rather than stamping
 * a `.name` the driver never sets.
 *
 * `dropConstraintName` models the wrappers that surface the SQLSTATE but lose
 * the structured constraint field, leaving the index name only in the message.
 */
function drizzleUniqueViolation(
  constraintName: string,
  { dropConstraintName = false }: { dropConstraintName?: boolean } = {},
): Error {
  const cause = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraintName}"`),
    {
      code: '23505',
      severity: 'ERROR',
      table_name: 'organizations',
      ...(dropConstraintName ? {} : { constraint_name: constraintName }),
    },
  );
  // postgres.js sets `this.name = this.constructor.name` on PostgresError;
  // DrizzleQueryError sets no name at all. Mirror both.
  cause.name = 'PostgresError';
  return new Error('Failed query: insert into "organizations" ...', { cause });
}

const orgRow = {
  id: ORG_ID,
  partnerId: PARTNER_ID,
  currencyCode: 'CAD',
  name: 'Acme',
  slug: 'acme',
  type: 'customer',
  status: 'active',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  partnerExportUpdatedAt: UPDATED_AT,
};

const siteRow = {
  id: SITE_ID,
  orgId: ORG_ID,
  name: 'HQ',
  timezone: 'UTC',
  address: { line1: '1 Main St', city: 'Denver' },
  contact: { name: 'NOC', email: 'noc@example.com' },
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  partnerExportUpdatedAt: UPDATED_AT,
};

/**
 * The row shape `.returning()` actually produces — every column of
 * `enrollment_keys` the route can see, INCLUDING the two credential columns
 * and `createdBy`.
 *
 * This matters more than it looks. An earlier fixture carried only the
 * metadata columns, which made every "the response omits the credentials"
 * assertion below structurally incapable of failing: the route could have
 * spread the whole row into `data` and the test would still have passed
 * because the fixture had nothing to leak. The values here are deliberately
 * recognizable so a leak shows up as itself in the assertion diff.
 */
const keyRow = {
  id: KEY_ROW_ID,
  orgId: ORG_ID,
  siteId: null,
  name: 'migration key',
  key: 'ROW-KEY-HASH-must-not-be-returned'.padEnd(64, '0'),
  keySecretHash: 'ROW-SECRET-HASH-must-not-be-returned'.padEnd(64, '0'),
  usageCount: 0,
  maxUsage: 1,
  expiresAt: new Date('2026-09-01T12:00:00.000Z'),
  createdAt: CREATED_AT,
  createdBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  insertResults = [];
  insertedValues = [];
  mocks.partnerContexts = [];
  mocks.systemContextOpens = 0;
  mocks.accessibleOrgIds = [ORG_ID];
  mocks.assertTtlWithinCap.mockResolvedValue(null);
  // A minting-capable principal by construction: both controls present.
  mocks.principalExpiresAt = new Date(Date.now() + 86_400_000);
  mocks.sourceCidrs = ['203.0.113.0/24'];
  mocks.rateLimiter.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 3_600_000),
  });
  primeDb();
});

describe('POST /organizations', () => {
  function primeSuccess({
    maxOrganizations = null as number | null,
    orgCount = 0,
    postInsertCount = null as number | null,
  } = {}) {
    // Select order with a cap configured: partner row → pre-insert count →
    // post-insert recount → export-stamp re-read. Without a cap the counts
    // are skipped entirely.
    selectResults = maxOrganizations === null
      ? [[{ maxOrganizations, currencyCode: 'CAD' }], [{ partnerExportUpdatedAt: UPDATED_AT }]]
      : [
        [{ maxOrganizations, currencyCode: 'CAD' }],
        [{ value: orgCount }],
        [{ value: postInsertCount ?? orgCount + 1 }],
        [{ partnerExportUpdatedAt: UPDATED_AT }],
      ];
    insertResults = [[orgRow]];
  }

  it('requires authentication', async () => {
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' }, 'wrong');
    expect(res.status).toBe(401);
  });

  it('requires the organizations:write scope', async () => {
    const res = await post('/organizations', 'organizations:read', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(403);
  });

  it('creates an organization under the principal partner in a system context', async () => {
    primeSuccess();
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.schemaVersion).toBe('1');
    expect(body.data).toMatchObject({ id: ORG_ID, orgId: ORG_ID, name: 'Acme', slug: 'acme', type: 'customer' });
    expect(body.data.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.systemContextOpens).toBe(1);
    expect(insertedValues[0]).toMatchObject({ partnerId: PARTNER_ID, currencyCode: 'CAD', name: 'Acme', slug: 'acme' });
  });

  it('ignores a body-supplied partnerId — the principal partner wins', async () => {
    primeSuccess();
    const res = await post('/organizations', 'organizations:write', {
      name: 'Acme', slug: 'acme', partnerId: OTHER_ORG_ID,
    });
    expect(res.status).toBe(201);
    expect((insertedValues[0] as { partnerId: string }).partnerId).toBe(PARTNER_ID);
  });

  it('refuses at the partner maxOrganizations cap with a specific error', async () => {
    primeSuccess({ maxOrganizations: 3, orgCount: 3 });
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.code).toBe('partner_provisioning_org_limit_reached');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('creates below the maxOrganizations cap', async () => {
    primeSuccess({ maxOrganizations: 3, orgCount: 2 });
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(201);
  });

  it('rolls back an insert a concurrent create raced past the cap', async () => {
    // Pre-insert count passes (2 < 3) but the post-insert recount sees 4 —
    // a concurrent transaction committed first. The insert must be rolled
    // back and reported as the same specific quota error.
    primeSuccess({ maxOrganizations: 3, orgCount: 2, postInsertCount: 4 });
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('partner_provisioning_org_limit_reached');
  });

  it('maps the slug unique violation to 409', async () => {
    selectResults = [[{ maxOrganizations: null, currencyCode: 'CAD' }]];
    insertResults = [drizzleUniqueViolation(ORG_SLUG_UNIQUE_INDEX)];
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('partner_provisioning_slug_conflict');
  });

  // #3982 — the discriminating half. An unconstrained `code === '23505'` check
  // answers 409 "slug conflict" here too, handing an unattended partner-API
  // caller a confident, WRONG diagnosis for a constraint that has nothing to do
  // with the slug it sent. The constraint used here is real: `organizations`
  // also carries organizations_id_partner_id_unique on (id, partner_id).
  it('does not report a NON-slug unique violation as a slug conflict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    selectResults = [[{ maxOrganizations: null, currencyCode: 'CAD' }]];
    insertResults = [drizzleUniqueViolation('organizations_id_partner_id_unique')];
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    // Rethrown, so this bare test app answers via Hono's DEFAULT error handler.
    // In the real app the same throw reaches `app.onError` (index.ts), which
    // logs and captures to Sentry — not asserted here, that is index.ts's
    // contract, not this route's.
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('partner_provisioning_slug_conflict');
    // The route still names the constraint that actually fired, so triage does
    // not have to unwrap `.cause` off a generic DrizzleQueryError by hand.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('organizations_id_partner_id_unique'));
    warn.mockRestore();
  });

  // Some wrappers hand back the SQLSTATE but drop `constraint_name`; the index
  // name still rides along in the driver's message. isPgUniqueViolation's
  // message-scan fallback is what keeps the 409 reachable in that shape.
  it('maps the slug violation when only the message names the index', async () => {
    selectResults = [[{ maxOrganizations: null, currencyCode: 'CAD' }]];
    insertResults = [drizzleUniqueViolation(ORG_SLUG_UNIQUE_INDEX, { dropConstraintName: true })];
    const res = await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('partner_provisioning_slug_conflict');
  });

  it('rejects lifecycle statuses the human API reserves', async () => {
    const res = await post('/organizations', 'organizations:write', {
      name: 'Acme', slug: 'acme', status: 'churned',
    });
    expect(res.status).toBe(400);
  });

  it('attributes the audit event to the service principal', async () => {
    primeSuccess();
    await post('/organizations', 'organizations:write', { name: 'Acme', slug: 'acme' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'organization.create',
      actorType: 'api_key',
      actorId: KEY_ID,
      orgId: ORG_ID,
      details: expect.objectContaining({
        principalType: 'partner_service_principal',
        partnerServicePrincipalId: PRINCIPAL_ID,
        partnerId: PARTNER_ID,
      }),
    }));
  });
});

describe('POST /sites', () => {
  function primeSuccess() {
    insertResults = [[siteRow]];
    // Two reads now, in order: the contacts mirror's existing-primary lookup
    // (none — the site was just created), then the partner-export stamp
    // re-read. Priming only the stamp would feed its row to the mirror, which
    // would read as an existing contact and take the update path.
    selectResults = [[], [{ partnerExportUpdatedAt: UPDATED_AT }]];
  }

  it('requires the sites:write scope', async () => {
    const res = await post('/sites', 'sites:read', { orgId: ORG_ID, name: 'HQ' });
    expect(res.status).toBe(403);
  });

  it('rejects an orgId outside the principal accessible set with 403', async () => {
    const res = await post('/sites', 'sites:write', { orgId: OTHER_ORG_ID, name: 'HQ' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('partner_provisioning_org_access_denied');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('creates a site inside a partner-scoped bounded context with a null userId', async () => {
    primeSuccess();
    const res = await post('/sites', 'sites:write', {
      orgId: ORG_ID, name: 'HQ', address: { line1: '1 Main St', city: 'Denver' }, contact: { name: 'NOC' },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data).toMatchObject({
      id: SITE_ID, orgId: ORG_ID, siteId: SITE_ID, name: 'HQ', timezone: 'UTC',
    });
    expect(body.data.address).toMatchObject({ line1: '1 Main St', city: 'Denver' });
    expect(body.data.contact).toMatchObject({ name: 'NOC', email: 'noc@example.com' });
    expect(mocks.partnerContexts[0]).toMatchObject({
      scope: 'partner',
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [PARTNER_ID],
      currentPartnerId: PARTNER_ID,
      userId: null,
    });
    expect(insertedValues[0]).toMatchObject({ orgId: ORG_ID, name: 'HQ', timezone: 'UTC' });
  });

  it('attributes the audit event to the service principal', async () => {
    primeSuccess();
    await post('/sites', 'sites:write', { orgId: ORG_ID, name: 'HQ' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'site.create',
      actorType: 'api_key',
      actorId: KEY_ID,
    }));
  });
});

describe('POST /enrollment-keys', () => {
  function primeSuccess({ withSite = false } = {}) {
    selectResults = withSite ? [[{ id: SITE_ID }]] : [];
    insertResults = [[keyRow]];
  }

  it('requires the enrollment-keys:write scope', async () => {
    const res = await post('/enrollment-keys', 'organizations:write', { orgId: ORG_ID, name: 'k' });
    expect(res.status).toBe(403);
  });

  it('rejects an orgId outside the principal accessible set with 403', async () => {
    const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: OTHER_ORG_ID, name: 'k' });
    expect(res.status).toBe(403);
  });

  it('rejects ttlMinutes and expiresAt together', async () => {
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'k', ttlMinutes: 60, expiresAt: '2026-09-01T00:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown keys via .strict()', async () => {
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'k', maxUses: 5,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('maxUses');
  });

  it('rejects a TTL above the partner cap', async () => {
    mocks.assertTtlWithinCap.mockResolvedValue('ttlMinutes exceeds the partner maximum of 60 minutes');
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'k', ttlMinutes: 120,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('partner_provisioning_ttl_exceeds_cap');
    expect(mocks.assertTtlWithinCap).toHaveBeenCalledWith(ORG_ID, 120);
  });

  it('rejects a siteId that does not belong to the org', async () => {
    selectResults = [[]];
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, siteId: SITE_ID, name: 'k',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('partner_provisioning_site_mismatch');
  });

  it('returns the raw key exactly once with a hashed row and no createdBy user', async () => {
    primeSuccess();
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'migration key', ttlMinutes: 60,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.key).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data).toMatchObject({ id: KEY_ROW_ID, orgId: ORG_ID, name: 'migration key', maxUsage: 1 });
    // The stored value must be the HASH, never the raw key.
    const stored = insertedValues[0] as { key: string; createdBy: unknown };
    expect(stored.key).not.toBe(body.key);
    expect(stored.key).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.createdBy).toBeNull();
    // The raw key never appears inside the DTO record.
    expect(JSON.stringify(body.data)).not.toContain(body.key);
    // And the row's own credential columns never reach the client, even though
    // the fixture returns them (see the keyRow comment).
    expect(JSON.stringify(body)).not.toContain(keyRow.key);
    expect(JSON.stringify(body)).not.toContain(keyRow.keySecretHash);
  });

  // `expiresAt` is the whole security value of a mint TTL, and nothing pinned
  // what actually got persisted: the three expiry branches could be swapped for
  // each other, or the column pinned to a constant, without failing anything.
  it('persists expiresAt derived from ttlMinutes, not the default', async () => {
    primeSuccess();
    const before = Date.now();
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'k', ttlMinutes: 60,
    });
    expect(res.status).toBe(201);
    const stored = insertedValues[0] as { expiresAt: Date };
    expect(stored.expiresAt).toBeInstanceOf(Date);
    const ttlMs = stored.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(59 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(61 * 60_000);
  });

  it('persists expiresAt taken verbatim from the expiresAt branch', async () => {
    primeSuccess();
    const explicit = '2027-01-02T03:04:05.000Z';
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'k', expiresAt: explicit,
    });
    expect(res.status).toBe(201);
    const stored = insertedValues[0] as { expiresAt: Date };
    expect(stored.expiresAt.toISOString()).toBe(explicit);
  });

  it('persists the validated siteId when one is supplied', async () => {
    primeSuccess({ withSite: true });
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, siteId: SITE_ID, name: 'k',
    });
    expect(res.status).toBe(201);
    expect(insertedValues[0]).toMatchObject({ orgId: ORG_ID, siteId: SITE_ID, name: 'k' });
  });

  it('persists a null siteId when none is supplied', async () => {
    primeSuccess();
    const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
    expect(res.status).toBe(201);
    expect((insertedValues[0] as { siteId: unknown }).siteId).toBeNull();
  });

  // `body.data.maxUsage` comes from the canned returning-row fixture, so it
  // proves nothing about what the handler asked Postgres to store: pinning the
  // column to 1 and ignoring the request passed the whole suite.
  it('persists the requested maxUsage rather than the default', async () => {
    primeSuccess();
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'k', maxUsage: 250,
    });
    expect(res.status).toBe(201);
    expect((insertedValues[0] as { maxUsage: unknown }).maxUsage).toBe(250);
  });

  it('persists maxUsage 1 when the caller omits it', async () => {
    primeSuccess();
    const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
    expect(res.status).toBe(201);
    expect((insertedValues[0] as { maxUsage: unknown }).maxUsage).toBe(1);
  });

  it('persists the request name verbatim', async () => {
    primeSuccess();
    const res = await post('/enrollment-keys', 'enrollment-keys:write', {
      orgId: ORG_ID, name: 'a distinctive key name',
    });
    expect(res.status).toBe(201);
    expect((insertedValues[0] as { name: unknown }).name).toBe('a distinctive key name');
  });

  it('persists the orgId from the request, inside the principal partner context', async () => {
    primeSuccess();
    await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
    expect((insertedValues[0] as { orgId: unknown }).orgId).toBe(ORG_ID);
    expect(mocks.partnerContexts.at(-1)).toMatchObject({
      scope: 'partner',
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [PARTNER_ID],
      currentPartnerId: PARTNER_ID,
      userId: null,
    });
  });

  it('attributes the audit event to the service principal', async () => {
    primeSuccess();
    await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'enrollment_key.create',
      actorType: 'api_key',
      actorId: KEY_ID,
      details: expect.objectContaining({ partnerServicePrincipalId: PRINCIPAL_ID }),
    }));
  });

  describe('credential-minting controls', () => {
    it.each([
      ['no principal expiry', { principalExpiresAt: null, sourceCidrs: ['203.0.113.0/24'] }],
      ['no source CIDRs', { principalExpiresAt: new Date(Date.now() + 86_400_000), sourceCidrs: [] }],
      ['neither control', { principalExpiresAt: null, sourceCidrs: [] }],
    ])('refuses to mint with %s', async (_label, overrides) => {
      mocks.principalExpiresAt = overrides.principalExpiresAt;
      mocks.sourceCidrs = overrides.sourceCidrs;
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('partner_provisioning_principal_restrictions_required');
      expect(insertedValues).toHaveLength(0);
    });

    it('fails closed on the dedicated mint rate limit', async () => {
      mocks.rateLimiter.mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 120_000),
      });
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(res.status).toBe(429);
      expect((await res.json()).code).toBe('partner_provisioning_rate_limited');
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(insertedValues).toHaveLength(0);
    });

    it('uses a mint bucket keyed to the service principal, not the generic budget', async () => {
      primeSuccess();
      await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(mocks.rateLimiter).toHaveBeenCalledWith(
        expect.anything(),
        `rl:partner-enrollment-key-mint:${PRINCIPAL_ID}`,
        expect.any(Number),
        3600,
      );
    });

    // A partner admin can create service principals, so the per-principal
    // bucket alone is multiplied by however many principals they mint.
    it('also charges a partner-wide bucket the principal count cannot multiply', async () => {
      primeSuccess();
      await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(mocks.rateLimiter).toHaveBeenCalledWith(
        expect.anything(),
        `rl:partner-enrollment-key-mint:partner:${PARTNER_ID}`,
        expect.any(Number),
        3600,
      );
    });

    it('429s on the partner bucket even when the principal bucket allows', async () => {
      mocks.rateLimiter
        .mockResolvedValueOnce({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000) })
        .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) });
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(res.status).toBe(429);
      expect(insertedValues).toHaveLength(0);
    });

    // Two operator knobs, both of which used to be unreadable: the write limit
    // was read through a local parser that THREW inside the handler (a typo'd
    // value 500'd every mint instead of failing at deploy), and the TTL ceiling
    // was documented in .env.example and threaded through compose while no file
    // in apps/api read it at all.
    it('reads the per-principal mint limit from the environment', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_WRITE_RATE_LIMIT', '3');
      primeSuccess();
      await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(mocks.rateLimiter).toHaveBeenCalledWith(
        expect.anything(),
        `rl:partner-enrollment-key-mint:${PRINCIPAL_ID}`,
        3,
        3600,
      );
    });

    it('falls back to the default limit instead of 500ing on a malformed value', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_WRITE_RATE_LIMIT', 'ten-per-hour');
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(res.status).toBe(201);
      expect(mocks.rateLimiter).toHaveBeenCalledWith(
        expect.anything(),
        `rl:partner-enrollment-key-mint:${PRINCIPAL_ID}`,
        10,
        3600,
      );
    });

    it('rejects a ttlMinutes above PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', '60');
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', ttlMinutes: 61,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('partner_provisioning_ttl_exceeds_cap');
      expect(insertedValues).toHaveLength(0);
    });

    // Capping only ttlMinutes would leave expiresAt as an open bypass.
    it('rejects an expiresAt beyond the operator ceiling too', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', '60');
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID,
        name: 'k',
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('partner_provisioning_ttl_exceeds_cap');
      expect(insertedValues).toHaveLength(0);
    });

    it('allows a ttlMinutes at exactly the operator ceiling', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', '60');
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', ttlMinutes: 60,
      });
      expect(res.status).toBe(201);
    });

    // Unset must mean the pre-existing hard bound, not a narrower one: this
    // endpoint has shipped since v0.105.1 and partners already mint through it.
    it('leaves the 365-day bound in place when the ceiling is unset', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', '');
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', ttlMinutes: 525_600,
      });
      expect(res.status).toBe(201);
    });

    // The env knob may only narrow the hard ceiling, never widen it.
    it('cannot be used to widen the hard 365-day bound', async () => {
      vi.stubEnv('PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', '9999999');
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', ttlMinutes: 525_601,
      });
      // Rejected by the schema bound, which the env value never relaxes.
      expect(res.status).toBe(400);
      expect(insertedValues).toHaveLength(0);
    });

    // The two columns use different hashers and are NOT interchangeable:
    // `key` is peppered, `key_secret_hash` is plain SHA-256 because
    // routes/agents/enrollment.ts verifies it with hashEnrollmentSecret().
    // Asserting the concrete unpeppered digest is what makes a regression to
    // hashEnrollmentKey() here fail instead of silently 403-ing every agent.
    it('stores the enrollment secret unpeppered and the key peppered', async () => {
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', issueEnrollmentSecret: true,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.key).toMatch(/^[0-9a-f]{64}$/);
      expect(body.enrollmentSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.enrollmentSecret).not.toBe(body.key);

      const inserted = insertedValues[0] as Record<string, unknown>;
      const plainSecretDigest = createHash('sha256').update(body.enrollmentSecret).digest('hex');
      expect(inserted.keySecretHash).toBe(plainSecretDigest);
      // The peppered hasher must NOT have been used for the secret column.
      expect(inserted.keySecretHash).not.toBe(hashEnrollmentKey(body.enrollmentSecret));
      // ...and the key column must be peppered, i.e. not a bare digest.
      expect(inserted.key).toBe(hashEnrollmentKey(body.key));
      expect(inserted.key).not.toBe(createHash('sha256').update(body.key).digest('hex'));
      // Neither raw credential is ever persisted.
      expect(inserted.key).not.toBe(body.key);
      expect(inserted.keySecretHash).not.toBe(body.enrollmentSecret);
    });

    it('never returns a hash or createdBy in the response body', async () => {
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', issueEnrollmentSecret: true,
      });
      const body = await res.json();
      expect(body.data).not.toHaveProperty('keySecretHash');
      expect(body.data).not.toHaveProperty('createdBy');
      expect(JSON.stringify(body)).not.toContain('hash');
      expect((insertedValues[0] as Record<string, unknown>).createdBy).toBeNull();
      // Non-vacuous only because keyRow carries both credential columns.
      expect(JSON.stringify(body)).not.toContain(keyRow.key);
      expect(JSON.stringify(body)).not.toContain(keyRow.keySecretHash);
    });
  });

  /**
   * `enrollment_keys.key_secret_hash` is a switch on the agent enrollment path:
   * once it is set, that key REQUIRES the per-key secret and the global
   * AGENT_ENROLLMENT_SECRET no longer satisfies it. This endpoint shipped in
   * v0.105.1 never writing that column, so setting it unconditionally would
   * break every integration already minting through it. The default below is
   * the shipped contract; `issueEnrollmentSecret: true` is the opt-in.
   */
  describe('per-key enrollment secret is opt-in', () => {
    it('leaves key_secret_hash null and omits the secret by default', async () => {
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', { orgId: ORG_ID, name: 'k' });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.key).toMatch(/^[0-9a-f]{64}$/);
      expect(body).not.toHaveProperty('enrollmentSecret');
      expect((insertedValues[0] as Record<string, unknown>).keySecretHash).toBeNull();
    });

    /**
     * Round-four finding 5: an integrator gets a clean 201 here and then a
     * `403 Enrollment secret required` from the agent enrollment route, with
     * nothing connecting the two. The response says which secret the agent
     * will need, on every path including a replay that carries no secret.
     */
    it.each([
      ['global', undefined],
      ['global', false],
      ['per_key', true],
    ])('reports enrollmentSecretSource=%s to the caller', async (expected, flag) => {
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID,
        name: 'k',
        ...(flag === undefined ? {} : { issueEnrollmentSecret: flag }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).enrollmentSecretSource).toBe(expected);
    });

    it('leaves key_secret_hash null when the flag is explicitly false', async () => {
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', issueEnrollmentSecret: false,
      });
      expect(res.status).toBe(201);
      expect(await res.json()).not.toHaveProperty('enrollmentSecret');
      expect((insertedValues[0] as Record<string, unknown>).keySecretHash).toBeNull();
    });

    it('writes key_secret_hash and returns the secret when opted in', async () => {
      primeSuccess();
      const res = await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID, name: 'k', issueEnrollmentSecret: true,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.enrollmentSecret).toMatch(/^[0-9a-f]{64}$/);
      expect((insertedValues[0] as Record<string, unknown>).keySecretHash)
        .toBe(createHash('sha256').update(body.enrollmentSecret).digest('hex'));
    });

    // Which credential model a key was minted under decides whether it accepts
    // the global secret, so it belongs in the audit trail.
    it.each([
      [false, undefined],
      [false, false],
      [true, true],
    ])('audits issuedEnrollmentSecret=%s for issueEnrollmentSecret=%s', async (expected, flag) => {
      primeSuccess();
      await post('/enrollment-keys', 'enrollment-keys:write', {
        orgId: ORG_ID,
        name: 'k',
        ...(flag === undefined ? {} : { issueEnrollmentSecret: flag }),
      });
      expect(mocks.audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        action: 'enrollment_key.create',
        details: expect.objectContaining({ issuedEnrollmentSecret: expected }),
      }));
    });
  });

  describe('durable idempotency', () => {
    function postIdem(body: unknown, idempotencyKey: string) {
      return app.request('/enrollment-keys', {
        method: 'POST',
        headers: {
          'X-API-Key': 'test-key',
          'X-Test-Scopes': 'enrollment-keys:write',
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    }

    it.each([
      ['empty', ''],
      ['too long', 'a'.repeat(129)],
      ['non-ASCII', 'idem-é'],
    ])('rejects a %s idempotency key before any I/O', async (_label, key) => {
      primeSuccess();
      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, key);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('partner_provisioning_invalid_idempotency_key');
      expect(mocks.rateLimiter).not.toHaveBeenCalled();
      expect(insertedValues).toHaveLength(0);
    });

    it('replays a completed claim as metadata only, minting nothing', async () => {
      // Claim lookup hits, then the stored key is re-read.
      selectResults = [
        [{
          id: 'claim-1',
          partnerServicePrincipalId: PRINCIPAL_ID,
          idempotencyKey: 'idem-1',
          requestFingerprint: createHash('sha256')
            .update(JSON.stringify({ orgId: ORG_ID, name: 'k' }))
            .digest('hex'),
          enrollmentKeyId: KEY_ROW_ID,
        }],
        [keyRow],
      ];
      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, 'idem-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.idempotencyReplay).toBe(true);
      expect(body.data.id).toBe(KEY_ROW_ID);
      // One-time credentials are unrecoverable by design. Non-vacuous because
      // the replayed row carries both of them (see the keyRow comment).
      expect(body).not.toHaveProperty('key');
      expect(body).not.toHaveProperty('enrollmentSecret');
      expect(JSON.stringify(body)).not.toContain(keyRow.key);
      expect(JSON.stringify(body)).not.toContain(keyRow.keySecretHash);
      expect(insertedValues).toHaveLength(0);
    });

    // A replay mints nothing, so charging it against the mint budget lets a
    // client's own retries 429 the replay they are entitled to.
    it('answers a replay without charging the mint budget', async () => {
      selectResults = [
        [{
          id: 'claim-1',
          partnerServicePrincipalId: PRINCIPAL_ID,
          idempotencyKey: 'idem-1',
          requestFingerprint: createHash('sha256')
            .update(JSON.stringify({ orgId: ORG_ID, name: 'k' }))
            .digest('hex'),
          enrollmentKeyId: KEY_ROW_ID,
        }],
        [keyRow],
      ];
      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, 'idem-1');
      expect(res.status).toBe(200);
      expect(mocks.rateLimiter).not.toHaveBeenCalled();
    });

    it('still replays when the mint budget is already exhausted', async () => {
      mocks.rateLimiter.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 3_600_000),
      });
      selectResults = [
        [{
          id: 'claim-1',
          partnerServicePrincipalId: PRINCIPAL_ID,
          idempotencyKey: 'idem-1',
          requestFingerprint: createHash('sha256')
            .update(JSON.stringify({ orgId: ORG_ID, name: 'k' }))
            .digest('hex'),
          enrollmentKeyId: KEY_ROW_ID,
        }],
        [keyRow],
      ];
      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, 'idem-1');
      expect(res.status).toBe(200);
      expect((await res.json()).idempotencyReplay).toBe(true);
    });

    // A mismatch and an unreadable claim are also decided from the durable
    // claim alone; neither mints, so neither charges the budget.
    it('returns 409 on a body mismatch without charging the mint budget', async () => {
      selectResults = [[{
        id: 'claim-1',
        partnerServicePrincipalId: PRINCIPAL_ID,
        idempotencyKey: 'idem-1',
        requestFingerprint: 'a-fingerprint-from-a-different-body',
        enrollmentKeyId: KEY_ROW_ID,
      }]];
      const res = await postIdem({ orgId: ORG_ID, name: 'different' }, 'idem-1');
      expect(res.status).toBe(409);
      expect(mocks.rateLimiter).not.toHaveBeenCalled();
    });

    it('returns 503 when the claim exists but its key row is unreadable', async () => {
      selectResults = [
        [{
          id: 'claim-1',
          partnerServicePrincipalId: PRINCIPAL_ID,
          idempotencyKey: 'idem-1',
          requestFingerprint: createHash('sha256')
            .update(JSON.stringify({ orgId: ORG_ID, name: 'k' }))
            .digest('hex'),
          enrollmentKeyId: KEY_ROW_ID,
        }],
        [],
      ];
      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, 'idem-1');
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('partner_provisioning_idempotency_state_invalid');
      expect(insertedValues).toHaveLength(0);
    });

    it('returns 409 when the same key is reused with a different body', async () => {
      selectResults = [[{
        id: 'claim-1',
        partnerServicePrincipalId: PRINCIPAL_ID,
        idempotencyKey: 'idem-1',
        requestFingerprint: 'a-fingerprint-from-a-different-body',
        enrollmentKeyId: KEY_ROW_ID,
      }]];
      const res = await postIdem({ orgId: ORG_ID, name: 'different' }, 'idem-1');
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('partner_provisioning_idempotency_key_reused');
      expect(insertedValues).toHaveLength(0);
    });

    it('returns 409 rather than minting twice when concurrent requests race', async () => {
      selectResults = [[]];
      // The claim insert loses the unique-index race and returns no row.
      mocks.transaction.mockImplementation(async (fn: any) => fn({
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
          })),
        })),
        update: mocks.update,
        select: mocks.select,
      }));
      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, 'idem-race');
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('partner_provisioning_idempotency_in_flight');
    });

    it('commits the claim, the key, and the link in one transaction', async () => {
      selectResults = [[]];
      const txInserts: unknown[] = [];
      let linked = false;
      mocks.transaction.mockImplementation(async (fn: any) => fn({
        insert: vi.fn(() => ({
          values: vi.fn((values: unknown) => {
            txInserts.push(values);
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([{ id: 'claim-1' }]),
              })),
              returning: vi.fn().mockResolvedValue([keyRow]),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(() => {
                linked = true;
                return Promise.resolve([{ id: 'claim-1' }]);
              }),
            })),
          })),
        })),
        select: mocks.select,
      }));

      const res = await postIdem({ orgId: ORG_ID, name: 'k' }, 'idem-new');
      expect(res.status).toBe(201);
      expect(mocks.transaction).toHaveBeenCalledOnce();
      // Claim first, then the enrollment key, then the link — all inside the tx.
      expect(txInserts).toHaveLength(2);
      expect(txInserts[0]).toMatchObject({ idempotencyKey: 'idem-new', orgId: ORG_ID });
      expect(txInserts[1]).toMatchObject({ orgId: ORG_ID, name: 'k' });
      expect(linked).toBe(true);
    });
  });
});
