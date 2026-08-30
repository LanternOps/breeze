import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
}));

vi.mock('../../db', () => ({
  db: { select: mocks.select, insert: mocks.insert, execute: mocks.execute },
  hasDbAccessContext: () => true,
  withDbAccessContext: async (ctx: unknown, fn: () => unknown) => {
    mocks.partnerContexts.push(ctx);
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    mocks.systemContextOpens += 1;
    return fn();
  },
}));
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

const keyRow = {
  id: KEY_ROW_ID,
  orgId: ORG_ID,
  siteId: null,
  name: 'migration key',
  usageCount: 0,
  maxUsage: 1,
  expiresAt: new Date('2026-09-01T12:00:00.000Z'),
  createdAt: CREATED_AT,
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
});
