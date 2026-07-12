import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));
vi.mock('./tenantLifecycle', () => ({
  revokeOrganizationTenantAccess: vi.fn(async () => undefined),
  restoreOrganizationTenantAccess: vi.fn(async () => undefined),
}));

import { and, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, sites } from '../db/schema';
import { writeAuditEvent } from './auditEvents';
import {
  revokeOrganizationTenantAccess,
  restoreOrganizationTenantAccess,
} from './tenantLifecycle';
import { registerOrgTools, slugifyOrgName, generateUniqueOrgSlug } from './aiToolsOrgs';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { validateToolInput } from './aiToolSchemas';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const SITE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARTNER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// ── DB chain mocks ───────────────────────────────────────────────────────────
// Select chains in this file are awaited at three different depths:
//   orgs list  → from().where().orderBy().limit()
//   sites list → from().where().orderBy()          (no limit)
//   slug read  → from().where()                    (awaited directly)
// One thenable chain object covers all three; results are consumed FIFO.
const selectQueue: unknown[][] = [];
const insertQueue: unknown[][] = [];
const updateQueue: unknown[][] = [];
const whereSpy = vi.fn();
const insertValuesSpy = vi.fn();
const updateSetSpy = vi.fn();

function makeSelectChain() {
  let consumed: unknown[] | null = null;
  const rows = () => {
    if (consumed === null) consumed = selectQueue.shift() ?? [];
    return consumed;
  };
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn((cond: unknown) => {
    whereSpy(cond);
    return chain;
  });
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows()));
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows()).then(res, rej);
  return chain;
}

function primeDb() {
  mockDb.select.mockImplementation(() => makeSelectChain());
  mockDb.insert.mockImplementation((table: unknown) => ({
    values: (v: unknown) => {
      insertValuesSpy(table, v);
      return { returning: () => Promise.resolve(insertQueue.shift() ?? []) };
    },
  }));
  mockDb.update.mockImplementation(() => ({
    set: (u: unknown) => {
      updateSetSpy(u);
      return {
        where: (cond: unknown) => {
          whereSpy(cond);
          return { returning: () => Promise.resolve(updateQueue.shift() ?? []) };
        },
      };
    },
  }));
}

// ── Auth fixtures ────────────────────────────────────────────────────────────
function partnerAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  const accessible = [ORG_1, ORG_2];
  return {
    user: { id: 'de305d54-75b4-431b-adb2-eb6b9e546014', email: 'tech@msp.example', name: 'Tech', isPlatformAdmin: false },
    token: {} as never,
    partnerId: PARTNER_ID,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: accessible,
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: (id: string) => accessible.includes(id),
    ...overrides,
  } as unknown as AuthContext;
}

function orgAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'de305d54-75b4-431b-adb2-eb6b9e546015', email: 'user@customer.example', name: 'User', isPlatformAdmin: false },
    token: {} as never,
    partnerId: PARTNER_ID,
    orgId: ORG_1,
    scope: 'organization',
    accessibleOrgIds: [ORG_1],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: (id: string) => id === ORG_1,
    ...overrides,
  } as unknown as AuthContext;
}

function getTools(): { list: AiTool; manage: AiTool } {
  const reg = new Map<string, AiTool>();
  registerOrgTools(reg);
  const list = reg.get('list_organizations');
  const manage = reg.get('manage_organizations');
  if (!list || !manage) throw new Error('org tools not registered');
  return { list, manage };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  primeDb();
});

// ── Registration ─────────────────────────────────────────────────────────────

describe('org tools registration', () => {
  it('registers list_organizations at tier 1 and manage_organizations at tier 2 with no device args', () => {
    const { list, manage } = getTools();
    expect(list.tier).toBe(1);
    expect(manage.tier).toBe(2);
    expect(list.deviceArgs).toEqual([]);
    expect(manage.deviceArgs).toEqual([]);
  });

  it('validates inputs through the shared Zod schema map', () => {
    expect(validateToolInput('manage_organizations', { action: 'create_org', name: 'Acme Dental' }).success).toBe(true);
    expect(validateToolInput('manage_organizations', { action: 'drop_all_orgs' }).success).toBe(false);
    expect(validateToolInput('manage_organizations', { action: 'update_org', orgId: 'not-a-uuid' }).success).toBe(false);
    expect(validateToolInput('list_organizations', { search: 'acme', limit: 10 }).success).toBe(true);
    expect(validateToolInput('list_organizations', { limit: 0 }).success).toBe(false);
  });
});

// ── list_organizations ───────────────────────────────────────────────────────

describe('list_organizations', () => {
  it('partner scope lists all accessible orgs with their sites grouped', async () => {
    selectQueue.push([
      { id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' },
      { id: ORG_2, name: 'Beta Corp', slug: 'beta-corp', status: 'trial' },
    ]);
    selectQueue.push([
      { id: SITE_1, name: 'Main Office', orgId: ORG_1 },
      { id: SITE_2, name: 'Warehouse', orgId: ORG_2 },
    ]);

    const out = JSON.parse(await getTools().list.handler({}, partnerAuth()));
    expect(out.showing).toBe(2);
    expect(out.organizations).toHaveLength(2);
    expect(out.organizations[0]).toEqual({
      id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active',
      sites: [{ id: SITE_1, name: 'Main Office' }],
    });
    expect(out.organizations[1].sites).toEqual([{ id: SITE_2, name: 'Warehouse' }]);

    // The org query is narrowed to the caller's accessible orgs.
    expect(whereSpy.mock.calls[0]![0]).toEqual(
      and(isNull(organizations.deletedAt), inArray(organizations.id, [ORG_1, ORG_2]))
    );
  });

  it('applies the name-substring search filter', async () => {
    selectQueue.push([{ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' }]);
    selectQueue.push([]);

    await getTools().list.handler({ search: 'acme' }, partnerAuth());
    expect(whereSpy.mock.calls[0]![0]).toEqual(
      and(
        isNull(organizations.deletedAt),
        ilike(organizations.name, '%acme%'),
        inArray(organizations.id, [ORG_1, ORG_2])
      )
    );
  });

  it('org scope sees only its own org', async () => {
    selectQueue.push([{ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' }]);
    selectQueue.push([{ id: SITE_1, name: 'Main Office', orgId: ORG_1 }]);

    const out = JSON.parse(await getTools().list.handler({}, orgAuth()));
    expect(out.organizations).toHaveLength(1);
    expect(out.organizations[0].id).toBe(ORG_1);
    // The org query is pinned to the caller's own org id.
    expect(whereSpy.mock.calls[0]![0]).toEqual(
      and(isNull(organizations.deletedAt), eq(organizations.id, ORG_1))
    );
  });

  it('org scope with no orgId returns empty without querying', async () => {
    const out = JSON.parse(await getTools().list.handler({}, orgAuth({ orgId: null })));
    expect(out).toEqual({ organizations: [], showing: 0 });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('partner scope with no accessible orgs returns empty without querying', async () => {
    const out = JSON.parse(
      await getTools().list.handler({}, partnerAuth({ accessibleOrgIds: [], canAccessOrg: () => false }))
    );
    expect(out).toEqual({ organizations: [], showing: 0 });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('site-restricted caller with an empty site allowlist gets orgs with no sites (single query)', async () => {
    selectQueue.push([{ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' }]);

    const out = JSON.parse(
      await getTools().list.handler({}, orgAuth({ allowedSiteIds: [] }))
    );
    expect(out.organizations[0].sites).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('site-restricted caller only sees allowed sites', async () => {
    selectQueue.push([{ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' }]);
    selectQueue.push([{ id: SITE_1, name: 'Main Office', orgId: ORG_1 }]);

    await getTools().list.handler({}, orgAuth({ allowedSiteIds: [SITE_1] }));
    expect(whereSpy.mock.calls[1]![0]).toEqual(
      and(inArray(sites.orgId, [ORG_1]), inArray(sites.id, [SITE_1]))
    );
  });
});

// ── manage_organizations: create_org ─────────────────────────────────────────

describe('manage_organizations create_org', () => {
  it('rejects an organization-scoped caller with a clean authorization error', async () => {
    const out = JSON.parse(
      await getTools().manage.handler({ action: 'create_org', name: 'Sneaky Org' }, orgAuth())
    );
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(out.error).toMatch(/partner-scoped/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('rejects a partner-scoped caller with no partnerId', async () => {
    const out = JSON.parse(
      await getTools().manage.handler(
        { action: 'create_org', name: 'Orphan Org' },
        partnerAuth({ partnerId: null })
      )
    );
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('creates the org under the caller partner with a default Main Office site (system db context)', async () => {
    selectQueue.push([{ slug: 'existing-org' }]); // slug-uniqueness read
    insertQueue.push([{ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' }]);
    insertQueue.push([{ id: SITE_1, name: 'Main Office' }]);

    const out = JSON.parse(
      await getTools().manage.handler({ action: 'create_org', name: 'Acme Dental' }, partnerAuth())
    );

    expect(out.organization).toEqual({ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental', status: 'active' });
    expect(out.defaultSite).toEqual({ id: SITE_1, name: 'Main Office' });

    // Org insert pinned to the CALLER's partner, slug derived from the name.
    expect(insertValuesSpy).toHaveBeenNthCalledWith(1, organizations, {
      partnerId: PARTNER_ID,
      name: 'Acme Dental',
      slug: 'acme-dental',
      type: 'customer',
      status: 'active',
    });
    // Default site insert for the new org.
    expect(insertValuesSpy).toHaveBeenNthCalledWith(2, sites, {
      orgId: ORG_1,
      name: 'Main Office',
      timezone: 'UTC',
    });
    // Tenant creation escapes the request RLS context.
    expect(runOutsideDbContext).toHaveBeenCalled();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
    // Audit events for both created resources.
    expect(writeAuditEvent).toHaveBeenCalledTimes(2);
  });

  it('suffixes the slug when the base is already taken', async () => {
    selectQueue.push([{ slug: 'acme-dental' }, { slug: 'acme-dental-2' }]);
    insertQueue.push([{ id: ORG_1, name: 'Acme Dental', slug: 'acme-dental-3', status: 'active' }]);
    insertQueue.push([{ id: SITE_1, name: 'Main Office' }]);

    await getTools().manage.handler({ action: 'create_org', name: 'Acme Dental' }, partnerAuth());
    expect(insertValuesSpy.mock.calls[0]![1]).toMatchObject({ slug: 'acme-dental-3' });
  });

  it('rejects a blank name', async () => {
    const out = JSON.parse(
      await getTools().manage.handler({ action: 'create_org', name: '   ' }, partnerAuth())
    );
    expect(out.error).toMatch(/name is required/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

// ── manage_organizations: update_org ─────────────────────────────────────────

describe('manage_organizations update_org', () => {
  it('rejects an organization-scoped caller', async () => {
    const out = JSON.parse(
      await getTools().manage.handler(
        { action: 'update_org', orgId: ORG_1, name: 'Renamed' },
        orgAuth()
      )
    );
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('denies a partner caller updating an org outside its accessible set', async () => {
    const out = JSON.parse(
      await getTools().manage.handler(
        { action: 'update_org', orgId: OTHER_ORG, name: 'Hijack' },
        partnerAuth()
      )
    );
    expect(out.error).toMatch(/not found or access denied/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('patches name and returns the safe projection', async () => {
    updateQueue.push([{ id: ORG_1, name: 'Renamed', slug: 'acme-dental', status: 'active' }]);
    const out = JSON.parse(
      await getTools().manage.handler({ action: 'update_org', orgId: ORG_1, name: 'Renamed' }, partnerAuth())
    );
    expect(out.organization.name).toBe('Renamed');
    expect(updateSetSpy.mock.calls[0]![0]).toMatchObject({ name: 'Renamed' });
    expect(revokeOrganizationTenantAccess).not.toHaveBeenCalled();
    expect(restoreOrganizationTenantAccess).not.toHaveBeenCalled();
  });

  it('suspending an org severs tenant access; reactivating restores it', async () => {
    updateQueue.push([{ id: ORG_1, name: 'Acme', slug: 'acme', status: 'suspended' }]);
    await getTools().manage.handler({ action: 'update_org', orgId: ORG_1, status: 'suspended' }, partnerAuth());
    expect(revokeOrganizationTenantAccess).toHaveBeenCalledWith(ORG_1);

    updateQueue.push([{ id: ORG_1, name: 'Acme', slug: 'acme', status: 'active' }]);
    await getTools().manage.handler({ action: 'update_org', orgId: ORG_1, status: 'active' }, partnerAuth());
    expect(restoreOrganizationTenantAccess).toHaveBeenCalledWith(ORG_1);
  });

  it('rejects an invalid status and an empty patch', async () => {
    const bad = JSON.parse(
      await getTools().manage.handler({ action: 'update_org', orgId: ORG_1, status: 'deleted' }, partnerAuth())
    );
    expect(bad.error).toMatch(/status must be one of/i);

    const empty = JSON.parse(
      await getTools().manage.handler({ action: 'update_org', orgId: ORG_1 }, partnerAuth())
    );
    expect(empty.error).toMatch(/no updates provided/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('returns not-found when the update matches no row (deleted org / RLS deny)', async () => {
    updateQueue.push([]);
    const out = JSON.parse(
      await getTools().manage.handler({ action: 'update_org', orgId: ORG_1, name: 'Ghost' }, partnerAuth())
    );
    expect(out.error).toMatch(/not found or access denied/i);
  });
});

// ── manage_organizations: create_site ────────────────────────────────────────

describe('manage_organizations create_site', () => {
  it('creates a site in an accessible org (partner scope) with optional address', async () => {
    insertQueue.push([{ id: SITE_2, name: 'Warehouse', orgId: ORG_2 }]);
    const address = { addressLine1: '1 Dock St', city: 'Springfield' };
    const out = JSON.parse(
      await getTools().manage.handler(
        { action: 'create_site', orgId: ORG_2, name: 'Warehouse', address },
        partnerAuth()
      )
    );
    expect(out.site).toEqual({ id: SITE_2, name: 'Warehouse', orgId: ORG_2 });
    expect(insertValuesSpy).toHaveBeenCalledWith(sites, {
      orgId: ORG_2,
      name: 'Warehouse',
      address,
    });
  });

  it('denies a partner caller targeting an org outside its accessible set', async () => {
    const out = JSON.parse(
      await getTools().manage.handler(
        { action: 'create_site', orgId: OTHER_ORG, name: 'Rogue Site' },
        partnerAuth()
      )
    );
    expect(out.error).toMatch(/access denied/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('org scope may create a site in its OWN org only', async () => {
    insertQueue.push([{ id: SITE_1, name: 'Branch', orgId: ORG_1 }]);
    const ok = JSON.parse(
      await getTools().manage.handler({ action: 'create_site', name: 'Branch' }, orgAuth())
    );
    expect(ok.site.orgId).toBe(ORG_1);
    expect(insertValuesSpy.mock.calls[0]![1]).toMatchObject({ orgId: ORG_1 });

    const denied = JSON.parse(
      await getTools().manage.handler(
        { action: 'create_site', orgId: ORG_2, name: 'Cross-org site' },
        orgAuth()
      )
    );
    expect(denied.error).toMatch(/cannot access another organization/i);
  });

  it('surfaces a 0-row insert (RLS deny) as an error instead of silent success', async () => {
    insertQueue.push([]);
    const out = JSON.parse(
      await getTools().manage.handler({ action: 'create_site', orgId: ORG_1, name: 'Phantom' }, partnerAuth())
    );
    expect(out.error).toMatch(/failed to create site/i);
  });

  it('requires a name', async () => {
    const out = JSON.parse(
      await getTools().manage.handler({ action: 'create_site', orgId: ORG_1 }, partnerAuth())
    );
    expect(out.error).toMatch(/name is required/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

// ── manage_organizations: add_contact ────────────────────────────────────────

describe('manage_organizations add_contact', () => {
  it('returns a structured not-supported note without touching the database', async () => {
    const out = JSON.parse(
      await getTools().manage.handler(
        { action: 'add_contact', orgId: ORG_1, name: 'Pat', email: 'pat@customer.example' },
        partnerAuth()
      )
    );
    expect(out.status).toBe('not_supported');
    expect(out.code).toBe('CONTACT_ENTITY_UNDEFINED');
    expect(out.note).toMatch(/product decision/i);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── slug helpers ─────────────────────────────────────────────────────────────

describe('slug helpers', () => {
  it('slugifies names like the accounting importer', () => {
    expect(slugifyOrgName('Acme Dental, LLC.')).toBe('acme-dental-llc');
    expect(slugifyOrgName('---')).toBe('org');
    expect(slugifyOrgName('Ünïcode & Co')).toBe('n-code-co');
  });

  it('appends numeric suffixes for taken slugs', () => {
    const taken = new Set(['acme', 'acme-2']);
    expect(generateUniqueOrgSlug('acme', taken)).toBe('acme-3');
    expect(generateUniqueOrgSlug('fresh', taken)).toBe('fresh');
  });
});
