/**
 * `identityProvisioning.ts` — onboarding discovery (W07 Task 7, Amendment B6,
 * B.0 items 12/15/16, B.9 item 7, D-R2-9).
 *
 * Its output is the part of snapshot 1's `facts` that discovery owns
 * (`collisions`, `seats`, `groups`, `modelAfter`, `flags`, `truncated`), which
 * `buildPlan` reads and E4 seals into the creation approval. So it must be:
 *  - THREE-WAY on collisions: a hit is `true` + the holder's id, not-found is
 *    `false`, a refusal is `null` + a flag — and a TRANSIENT fault RETHROWS so
 *    the wake retries (R1's rule; never "throw ⇒ null", B.0 item 16);
 *  - EVIDENCE-ONLY on seats: a live `m365.org.skus.list`, never the sync table;
 *    a SKU missing from a TRUNCATED list is `unknown`, not `not_subscribed`;
 *    a missing or malformed count is `unknown`, never zero;
 *  - HONEST on groups: `dynamic` from `groupTypes`, `roleAssignable: null`
 *    (unknown — never `false`, which would claim the group is safe);
 *  - TENANT-SCOPED: every Breeze read carries an `org_id` predicate, and a
 *    cross-tenant model-after / manager / site id is refused with no read of
 *    that person's provider accounts;
 *  - BOUNDED by `DISCOVERY_LIMITS` and `DISCOVERY_FACTS_MAX_BYTES`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityOnboardingInputSchema, type IdentityOnboardingInput } from '@breeze/shared';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  m365Read: vi.fn(),
  resolveContextByOrg: vi.fn(),
  dir: null as any,
  lic: null as any,
  /** Rows per table name; the db mock filters them by the rendered WHERE. */
  tables: {} as Record<string, Row[]>,
  wheres: [] as Array<{ table: string; where: unknown }>,
  inCtx: 0,
  contexts: [] as unknown[],
  providerCallDepths: [] as Array<[string, number]>,
}));

vi.mock('../m365ControlPlane/readActionService', () => ({
  executeM365ReadActionByOrg: (...args: unknown[]) => { h.providerCallDepths.push(['m365', h.inCtx]); return h.m365Read(...args); },
}));
vi.mock('../aiToolsGoogle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiToolsGoogle')>()),
  resolveContextByOrg: (...args: unknown[]) => { h.providerCallDepths.push(['google', h.inCtx]); return h.resolveContextByOrg(...args); },
}));
vi.mock('../googleClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../googleClient')>()),
  getDirectoryClient: () => h.dir,
  getLicensingClient: () => h.lic,
}));
vi.mock('../../db', async () => {
  const { PgDialect: Dialect } = await import('drizzle-orm/pg-core');
  const { getTableName: tableName } = await import('drizzle-orm');
  const chain = (table: unknown) => {
    const name = tableName(table as never);
    let where: unknown;
    const c: any = {
      where: (w: unknown) => { where = w; h.wheres.push({ table: name, where: w }); return c; },
      limit: async (n: number) => {
        const q = new Dialect().sqlToQuery(where as never);
        // Simulates the predicate the code actually wrote: WITH an org_id
        // predicate only this org's rows come back; WITHOUT one, any org's do.
        const orgScoped = /"org_id" = \$\d/.test(q.sql);
        return (h.tables[name] ?? []).filter((r) =>
          (!orgScoped || q.params.includes(r.orgId))
          && (q.params.includes(r.id) || q.params.includes(r.contactId))).slice(0, n);
      },
    };
    return c;
  };
  return {
    db: { select: () => ({ from: (t: unknown) => chain(t) }) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: async (ctx: unknown, fn: () => Promise<unknown>) => {
      h.contexts.push(ctx);
      h.inCtx += 1;
      try { return await fn(); } finally { h.inCtx -= 1; }
    },
  };
});

import { DISCOVERY_FACTS_MAX_BYTES, DISCOVERY_LIMITS, DiscoveryTransientError } from './identityDiscovery';
import { identityOnboardingCreateFactsSchema } from './recipes/identityOnboarding';
import { discoverOnboardingFacts, readOnboardingDraftFacts } from './identityProvisioning';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000ab';
const MA = '00000000-0000-4000-8000-0000000000d1';   // model-after contact
const MGR = '00000000-0000-4000-8000-0000000000d2';  // manager contact
const SITE = '00000000-0000-4000-8000-0000000000e1';
const MA_M365 = '00000000-0000-4000-8000-0000000000f1';
const MA_GOOGLE = '900100';
const HOLDER = '00000000-0000-4000-8000-0000000000f9';
const GR1 = '00000000-0000-4000-8000-0000000000c1';
const GR2 = '00000000-0000-4000-8000-0000000000c2';
const GR3 = '00000000-0000-4000-8000-0000000000c3';
const GR_FAR = '00000000-0000-4000-8000-0000000000c9';
const SKU_A = '00000000-0000-4000-8000-00000000a001';
const SKU_B = '00000000-0000-4000-8000-00000000a002';
const SKU_C = '00000000-0000-4000-8000-00000000a003';
const UPN = 'priya@customer.example';
const GMAIL = 'priya@customer.example';
const NOW = new Date('2026-10-24T12:00:00.000Z');

function input(over: Partial<Record<string, unknown>> = {}): IdentityOnboardingInput {
  return identityOnboardingInputSchema.parse({
    displayName: 'Priya Patel',
    modelAfterContactId: MA,
    m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', skuIds: [SKU_A], groupIds: [GR1, GR2] },
    google: {
      primaryEmail: GMAIL, givenName: 'Priya', familyName: 'Patel',
      groupEmails: ['all@customer.example', 'leads@customer.example'],
      licenses: [{ productId: 'Google-Apps', skuId: '1010020020' }],
    },
    ...over,
  });
}

function m365Default(over: Partial<Record<string, (action: any) => unknown>> = {}): void {
  h.m365Read.mockImplementation(async (_org: string, action: any) => {
    const o = over[action.type];
    if (o) return o(action);
    switch (action.type) {
      case 'm365.user.get':
        if (action.userIdOrUpn === MA_M365) {
          return { ok: true, kind: 'resource', resource: { id: MA_M365, userPrincipalName: 'sam@customer.example', assignedLicenses: [{ skuId: SKU_A }] } };
        }
        return { ok: false, code: 'graph_not_found', message: 'not found' };
      case 'm365.org.skus.list':
        return { ok: true, kind: 'collection', truncated: false, items: [
          { skuId: SKU_A, skuPartNumber: 'SPE_E3', consumedUnits: 13, prepaidUnits: { enabled: 25, suspended: 0, warning: 0 }, capabilityStatus: 'Enabled' },
          { skuId: SKU_B, skuPartNumber: 'EMS', consumedUnits: 10, prepaidUnits: { enabled: 10, suspended: 0, warning: 0 }, capabilityStatus: 'Enabled' },
        ] };
      case 'm365.group.list':
        return { ok: true, kind: 'collection', truncated: false, items: [
          { id: GR1, displayName: 'Marketing', groupTypes: ['Unified'] },
          { id: GR2, displayName: 'All Staff (dynamic)', groupTypes: ['DynamicMembership'], membershipRule: 'user.accountEnabled -eq true' },
          { id: GR3, displayName: 'Sales', groupTypes: [] },
        ] };
      case 'm365.group.get':
        return { ok: true, kind: 'resource', resource: { id: action.groupId, displayName: 'Far group', groupTypes: [] } };
      case 'm365.group.member.get':
        return { ok: true, kind: 'collection', truncated: false, items: action.groupId === GR1 || action.groupId === GR3 ? [{ id: MA_M365 }] : [] };
      default:
        return { ok: false, code: 'tools_disabled', message: `unexpected ${action.type}` };
    }
  });
}

function httpError(status: number, message = `http ${status}`): Error {
  return Object.assign(new Error(message), { code: status });
}

function googleDefault(over: { roles?: Record<string, string | number> } = {}): void {
  h.resolveContextByOrg.mockResolvedValue({ conn: { adminEmail: 'admin@customer.example' }, keyJson: '{}' });
  const roles = over.roles ?? { 'all@customer.example': 'MEMBER', 'leads@customer.example': 'OWNER' };
  h.dir = {
    users: {
      get: vi.fn(async ({ userKey }: { userKey: string }) => {
        if (userKey === MA_GOOGLE) return { data: { id: MA_GOOGLE, primaryEmail: 'Sam@customer.example' } };
        throw httpError(404, 'Resource Not Found: userKey');
      }),
    },
    groups: {
      get: vi.fn(async ({ groupKey }: { groupKey: string }) => ({ data: { id: `id-${groupKey}`, email: groupKey, name: groupKey.split('@')[0] } })),
      list: vi.fn(async () => ({ data: { groups: [
        { id: 'g1', email: 'all@customer.example', name: 'all' },
        { id: 'g2', email: 'Leads@customer.example', name: 'leads' },
      ] } })),
    },
    members: {
      get: vi.fn(async ({ groupKey }: { groupKey: string }) => {
        const role = roles[groupKey];
        if (role === undefined) throw httpError(404, 'Resource Not Found: memberKey');
        if (typeof role === 'number') throw httpError(role);
        return { data: { role } };
      }),
    },
  };
  h.lic = {
    licenseAssignments: {
      listForProduct: vi.fn(async ({ productId }: { productId: string }) => ({
        data: productId === 'Google-Apps'
          ? { items: [
            { userId: 'sam@customer.example', productId: 'Google-Apps', skuId: '1010020020' },
            { userId: 'other@customer.example', productId: 'Google-Apps', skuId: '1010020020' },
          ] }
          : { items: [] },
      })),
      listForProductAndSku: vi.fn(),
    },
  };
}

function tablesDefault(): void {
  h.tables = {
    contacts: [
      { id: MA, orgId: ORG, name: 'Sam Lee', email: 'sam@customer.example' },
      { id: MGR, orgId: ORG, name: 'Morgan Boss', email: 'morgan@customer.example' },
    ],
    contact_external_links: [
      { contactId: MA, orgId: ORG, system: 'm365', externalId: MA_M365 },
      { contactId: MA, orgId: ORG, system: 'google', externalId: MA_GOOGLE },
    ],
    sites: [{ id: SITE, orgId: ORG }],
  };
}

function discover(i: IdentityOnboardingInput = input()) {
  return discoverOnboardingFacts({ orgId: ORG, input: i, now: NOW });
}

function m365Calls(type: string): any[] {
  return h.m365Read.mock.calls.map((c) => c[1]).filter((a: any) => a.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.wheres = [];
  h.contexts = [];
  h.inCtx = 0;
  h.providerCallDepths = [];
  m365Default();
  googleDefault();
  tablesDefault();
});

describe('discoverOnboardingFacts — a clean pre-create pass', () => {
  it('returns both collisions strictly false, the seats, the requested groups and the model-after access', async () => {
    const f = await discover();
    expect(f.collisions).toEqual({
      m365: { upnTaken: false, existingObjectId: null },
      google: { emailTaken: false, existingUserId: null },
    });
    expect(f.seats.m365).toEqual([
      { skuId: SKU_A, skuPartNumber: 'SPE_E3', state: 'available', available: 12, observedAt: NOW.toISOString(), reason: null },
    ]);
    expect(f.groups.m365).toEqual([
      { id: GR1, name: 'Marketing', dynamic: false, roleAssignable: null },
      { id: GR2, name: 'All Staff (dynamic)', dynamic: true, roleAssignable: null },
    ]);
    expect(f.groups.google).toEqual([
      { email: 'all@customer.example', name: 'all', modelAfterRole: 'MEMBER' },
      { email: 'leads@customer.example', name: 'leads', modelAfterRole: 'OWNER' },
    ]);
    expect(f.modelAfter).toEqual({
      contactId: MA,
      label: 'Sam Lee',
      m365: { groupIds: [GR1, GR3], skuIds: [SKU_A] },
      google: {
        groupEmails: ['all@customer.example', 'leads@customer.example'],
        licenses: [{ productId: 'Google-Apps', skuId: '1010020020' }],
      },
    });
    expect(f.flags).toEqual([]);
    expect(f.truncated).toEqual([]);
  });

  it('returns EXACTLY the six keys snapshot 1 takes from discovery, and they satisfy the strict facts schema', async () => {
    const f = await discover();
    expect(Object.keys(f).sort()).toEqual(['collisions', 'flags', 'groups', 'modelAfter', 'seats', 'truncated']);
    const parsed = identityOnboardingCreateFactsSchema.safeParse({
      stage: 'create',
      targets: { contactTargetId: '00000000-0000-4000-8000-000000000071', contactLabel: 'Priya Patel' },
      ...f,
      degradedTools: [],
      capabilityReadiness: {},
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('a provider out of scope is not read at all and its records are null / empty', async () => {
    const f = await discover(input({ google: null }));
    expect(f.collisions.google).toBeNull();
    expect(f.groups.google).toEqual([]);
    expect(f.modelAfter?.google).toBeNull();
    expect(h.resolveContextByOrg).not.toHaveBeenCalled();

    vi.clearAllMocks(); m365Default(); googleDefault();
    const g = await discover(input({ m365: null }));
    expect(g.collisions.m365).toBeNull();
    expect(g.seats.m365).toEqual([]);
    expect(g.groups.m365).toEqual([]);
    expect(g.modelAfter?.m365).toBeNull();
    expect(h.m365Read).not.toHaveBeenCalled();
  });

  it('every provider read runs inside a db context scoped to exactly this org', async () => {
    await discover();
    expect(h.providerCallDepths.length).toBeGreaterThan(2);
    for (const [, depth] of h.providerCallDepths) expect(depth).toBeGreaterThanOrEqual(1);
    for (const ctx of h.contexts) expect(ctx).toMatchObject({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
  });
});

describe('collisions — three-way per provider, and a transient fault rethrows', () => {
  it('M365: a resource with an id ⇒ upnTaken true + the holder\'s object id', async () => {
    m365Default({ 'm365.user.get': (a) => (a.userIdOrUpn === UPN
      ? { ok: true, kind: 'resource', resource: { id: HOLDER, userPrincipalName: UPN } }
      : { ok: false, code: 'graph_not_found', message: 'x' }) });
    const f = await discover();
    expect(f.collisions.m365).toEqual({ upnTaken: true, existingObjectId: HOLDER });
  });

  it('M365: graph_not_found ⇒ upnTaken false (strictly), with no flag', async () => {
    const f = await discover();
    expect(f.collisions.m365?.upnTaken).toBe(false);
    expect(f.flags.filter((x) => x.code.startsWith('m365_collision'))).toEqual([]);
  });

  it('M365: a non-transient refusal ⇒ upnTaken NULL (never false) plus a flag', async () => {
    m365Default({ 'm365.user.get': () => ({ ok: false, code: 'connection_not_ready', message: 'not connected' }) });
    const f = await discover();
    // 'we could not check' must never read as 'the name is free': buildPlan's
    // collision gate treats non-false as blocking.
    expect(f.collisions.m365).toEqual({ upnTaken: null, existingObjectId: null });
    expect(f.collisions.m365?.upnTaken).not.toBe(false);
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'm365_collision_check_failed', subject: UPN }));
  });

  it('M365: a resource with no id, or a collection, is not evidence either way ⇒ null + flag', async () => {
    m365Default({ 'm365.user.get': () => ({ ok: true, kind: 'resource', resource: { userPrincipalName: UPN } }) });
    expect((await discover()).collisions.m365?.upnTaken).toBeNull();
    m365Default({ 'm365.user.get': () => ({ ok: true, kind: 'collection', truncated: false, items: [] }) });
    expect((await discover()).collisions.m365?.upnTaken).toBeNull();
  });

  it.each(['graph_throttled', 'executor_unavailable', 'read_rate_limited', 'graph_transport_failed', 'graph_request_timeout'])(
    'M365: a transient %s on the collision read RETHROWS (the wake retries; nothing is frozen)',
    async (code) => {
      m365Default({ 'm365.user.get': () => ({ ok: false, code, message: 'blip' }) });
      await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
    },
  );

  it('M365: a thrown error (Breeze I/O) on the collision read rethrows as transient', async () => {
    m365Default({ 'm365.user.get': () => { throw new Error('db down'); } });
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('Google: a user ⇒ emailTaken true + the holder\'s id', async () => {
    h.dir.users.get.mockImplementation(async ({ userKey }: { userKey: string }) => (userKey === GMAIL
      ? { data: { id: '900199', primaryEmail: GMAIL } }
      : { data: { id: MA_GOOGLE, primaryEmail: 'sam@customer.example' } }));
    const f = await discover();
    expect(f.collisions.google).toEqual({ emailTaken: true, existingUserId: '900199' });
  });

  it('Google: 404 ⇒ emailTaken false (strictly)', async () => {
    expect((await discover()).collisions.google).toEqual({ emailTaken: false, existingUserId: null });
  });

  it('Google: a 403 ⇒ emailTaken NULL plus a flag; an unusable connection ⇒ NULL plus a flag', async () => {
    h.dir.users.get.mockImplementation(async ({ userKey }: { userKey: string }) => {
      if (userKey === GMAIL) throw httpError(403, 'Not Authorized');
      return { data: { id: MA_GOOGLE, primaryEmail: 'sam@customer.example' } };
    });
    const f = await discover();
    expect(f.collisions.google).toEqual({ emailTaken: null, existingUserId: null });
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'google_collision_check_failed', subject: GMAIL }));

    h.resolveContextByOrg.mockResolvedValue({ error: 'no_google_connection' });
    const g = await discover();
    expect(g.collisions.google).toEqual({ emailTaken: null, existingUserId: null });
    expect(g.flags).toContainEqual(expect.objectContaining({ code: 'google_connection_unavailable' }));
  });

  it.each([[503], [429], [undefined]])('Google: a transient fault (status %s) on the collision read RETHROWS', async (status) => {
    h.dir.users.get.mockImplementation(async () => {
      throw status === undefined ? new Error('ECONNRESET') : httpError(status);
    });
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('Google: a connection lookup that throws is Breeze I/O ⇒ transient rethrow', async () => {
    h.resolveContextByOrg.mockRejectedValue(new Error('db down'));
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('a Google collision never touches the M365 record (per provider, B.0 item 12)', async () => {
    h.dir.users.get.mockImplementation(async ({ userKey }: { userKey: string }) => (userKey === GMAIL
      ? { data: { id: '900199', primaryEmail: GMAIL } }
      : { data: { id: MA_GOOGLE, primaryEmail: 'sam@customer.example' } }));
    const f = await discover();
    expect(f.collisions.google?.emailTaken).toBe(true);
    expect(f.collisions.m365).toEqual({ upnTaken: false, existingObjectId: null });
  });
});

describe('canonicalizeUserEmail before every userKey and comparison', () => {
  it('the canonical (lowercased) address reaches both providers', async () => {
    await discover(input({
      m365: { userPrincipalName: 'Priya+tag@Customer.Example', mailNickname: 'priya', usageLocation: 'US' },
      google: { primaryEmail: 'Priya+tag@Customer.Example', givenName: 'P', familyName: 'P', groupEmails: ['ALL@Customer.Example'] },
    }));
    expect(m365Calls('m365.user.get').map((a) => a.userIdOrUpn)).toContain('priya+tag@customer.example');
    expect(h.dir.users.get.mock.calls.map((c: any[]) => c[0].userKey)).toContain('priya+tag@customer.example');
    expect(h.dir.groups.get.mock.calls.map((c: any[]) => c[0].groupKey)).toEqual(['all@customer.example']);
  });

  it('an address canonicalization refuses is NEVER sent: null + flag, no read attempted', async () => {
    const base = input();
    const i = {
      ...base,
      m365: { ...base.m365!, userPrincipalName: "o'brien@customer.example" },
      google: { ...base.google!, primaryEmail: 'a*b@customer.example', groupEmails: ['x y@customer.example'] },
    } as IdentityOnboardingInput;
    const f = await discover(i);
    expect(f.collisions.m365).toEqual({ upnTaken: null, existingObjectId: null });
    expect(f.collisions.google).toEqual({ emailTaken: null, existingUserId: null });
    expect(m365Calls('m365.user.get').map((a) => a.userIdOrUpn)).not.toContain("o'brien@customer.example");
    expect(h.dir.users.get.mock.calls.map((c: any[]) => c[0].userKey)).not.toContain('a*b@customer.example');
    expect(h.dir.groups.get).not.toHaveBeenCalled();
    expect(f.groups.google).toEqual([]);
    expect(f.flags.map((x) => x.code)).toEqual(expect.arrayContaining([
      'm365_collision_check_failed', 'google_collision_check_failed', 'google_group_address_invalid',
    ]));
  });
});

describe('seats — the live m365.org.skus.list, frozen per SKU (B6)', () => {
  const seatInput = () => input({
    m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', skuIds: [SKU_A, SKU_B, SKU_C] },
  });

  it('available / unavailable / not_subscribed from a COMPLETE collection', async () => {
    const f = await discover(seatInput());
    expect(f.seats.m365.map((s) => [s.skuId, s.state, s.available])).toEqual([
      [SKU_A, 'available', 12],
      [SKU_B, 'unavailable', 0],
      [SKU_C, 'not_subscribed', null],
    ]);
    expect(f.seats.m365[2]!.skuPartNumber).toBeNull();
    expect(f.seats.m365[1]!.reason).toMatch(/no free seat/i);
    expect(f.seats.m365[2]!.reason).toMatch(/not subscribed/i);
    for (const s of f.seats.m365) expect(s.observedAt).toBe(NOW.toISOString());
  });

  it('a SKU absent from a TRUNCATED collection is unknown — absence is not proven', async () => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: true, kind: 'collection', truncated: true, items: [
      { skuId: SKU_A, skuPartNumber: 'SPE_E3', consumedUnits: 1, prepaidUnits: { enabled: 5 } },
    ] }) });
    const f = await discover(seatInput());
    expect(f.seats.m365.find((s) => s.skuId === SKU_C)).toMatchObject({ state: 'unknown', available: null });
    expect(f.seats.m365.find((s) => s.skuId === SKU_C)!.reason).toMatch(/truncat|first/i);
    // A SKU that WAS in the truncated page is still evidence.
    expect(f.seats.m365.find((s) => s.skuId === SKU_A)).toMatchObject({ state: 'available', available: 4 });
  });

  it('over-consumption is floored at 0 and unavailable, never negative', async () => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: true, kind: 'collection', truncated: false, items: [
      { skuId: SKU_A, skuPartNumber: 'SPE_E3', consumedUnits: 30, prepaidUnits: { enabled: 25 } },
    ] }) });
    const f = await discover();
    expect(f.seats.m365[0]).toMatchObject({ state: 'unavailable', available: 0 });
  });

  it.each([
    ['a string count', { consumedUnits: '13', prepaidUnits: { enabled: 25 } }],
    ['a missing prepaidUnits', { consumedUnits: 13 }],
    ['a missing consumedUnits', { prepaidUnits: { enabled: 25 } }],
    ['a negative count', { consumedUnits: -1, prepaidUnits: { enabled: 25 } }],
    ['a fractional count', { consumedUnits: 1.5, prepaidUnits: { enabled: 25 } }],
    ['a null enabled count', { consumedUnits: 0, prepaidUnits: { enabled: null } }],
  ])('malformed counts (%s) ⇒ unknown with available NULL — a missing count is never zero', async (_l, counts) => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: true, kind: 'collection', truncated: false, items: [
      { skuId: SKU_A, skuPartNumber: 'SPE_E3', ...counts },
    ] }) });
    const f = await discover();
    expect(f.seats.m365[0]).toMatchObject({ skuId: SKU_A, skuPartNumber: 'SPE_E3', state: 'unknown', available: null });
    expect(f.seats.m365[0]!.reason).toMatch(/count/i);
  });

  it('a suspended subscription is unavailable even with free units', async () => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: true, kind: 'collection', truncated: false, items: [
      { skuId: SKU_A, skuPartNumber: 'SPE_E3', consumedUnits: 1, prepaidUnits: { enabled: 25 }, capabilityStatus: 'Suspended' },
    ] }) });
    const f = await discover();
    expect(f.seats.m365[0]).toMatchObject({ state: 'unavailable' });
    expect(f.seats.m365[0]!.reason).toMatch(/Suspended/);
  });

  it('an item with no readable skuId makes every ABSENT SKU unknown — that item could be it', async () => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: true, kind: 'collection', truncated: false, items: [
      { skuPartNumber: 'MYSTERY', consumedUnits: 1, prepaidUnits: { enabled: 2 } },
    ] }) });
    const f = await discover(seatInput());
    expect(f.seats.m365.map((s) => s.state)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('a refused read ⇒ every requested SKU unknown, plus a flag', async () => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: false, code: 'graph_permission_missing', message: 'perm' }) });
    const f = await discover(seatInput());
    expect(f.seats.m365.map((s) => [s.state, s.available])).toEqual([['unknown', null], ['unknown', null], ['unknown', null]]);
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'm365_consent_upgrade_required' }));
  });

  it.each(['graph_throttled', 'executor_unavailable'])('a transient %s on the seat read RETHROWS', async (code) => {
    m365Default({ 'm365.org.skus.list': () => ({ ok: false, code, message: 'blip' }) });
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('no requested SKU ⇒ no seat read at all', async () => {
    await discover(input({ m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', groupIds: [GR1] } }));
    // The model-after user read carries the licences; the org's SKU list is not needed.
    expect(m365Calls('m365.org.skus.list')).toEqual([]);
  });

  it('cached counts are never substituted: the sync table is not read, and Google seats are never read', async () => {
    const src = readFileSync(join(__dirname, 'identityProvisioning.ts'), 'utf8');
    expect(src).not.toMatch(/m365LicenseSkus|m365_license_skus|m365Sync/);
    await discover();
    expect(Object.keys(h.tables).length).toBeGreaterThan(0);
    expect(h.wheres.map((w) => w.table)).not.toContain('m365_license_skus');
    expect(h.lic.licenseAssignments.listForProductAndSku).not.toHaveBeenCalled();
  });
});

describe('requested groups — dynamic flagged, role-assignability UNKNOWN', () => {
  it('roleAssignable is null on every M365 group, never false (B.0 item 15)', async () => {
    const f = await discover();
    expect(f.groups.m365.length).toBe(2);
    for (const g of f.groups.m365) {
      expect(g.roleAssignable).toBeNull();
      expect(g.roleAssignable).not.toBe(false);
    }
  });

  it('a dynamic group is flagged dynamic:true and STILL returned (the recipe excludes it)', async () => {
    const f = await discover();
    expect(f.groups.m365.find((g) => g.id === GR2)).toEqual({ id: GR2, name: 'All Staff (dynamic)', dynamic: true, roleAssignable: null });
  });

  it('a membershipRule alone marks a group dynamic; unreadable groupTypes is dynamic NULL', async () => {
    m365Default({ 'm365.group.list': () => ({ ok: true, kind: 'collection', truncated: false, items: [
      { id: GR1, displayName: 'Rule only', membershipRule: '(user.department -eq "Sales")' },
      { id: GR2, displayName: 'No types' },
    ] }) });
    const f = await discover();
    expect(f.groups.m365.map((g) => [g.id, g.dynamic])).toEqual([[GR1, true], [GR2, null]]);
  });

  it('a requested group absent from a COMPLETE list is not described (fail closed) plus a flag, with no per-group read', async () => {
    const f = await discover(input({ m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', groupIds: [GR1, GR_FAR] } }));
    expect(f.groups.m365.map((g) => g.id)).toEqual([GR1]);
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'm365_group_not_found', subject: GR_FAR }));
    expect(m365Calls('m365.group.get')).toEqual([]);
  });

  it('a requested group absent from a TRUNCATED list is read by id', async () => {
    m365Default({ 'm365.group.list': () => ({ ok: true, kind: 'collection', truncated: true, items: [
      { id: GR1, displayName: 'Marketing', groupTypes: [] },
    ] }) });
    const f = await discover(input({ m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', groupIds: [GR1, GR_FAR] } }));
    expect(m365Calls('m365.group.get').map((a) => a.groupId)).toEqual([GR_FAR]);
    expect(f.groups.m365.map((g) => g.id)).toEqual([GR1, GR_FAR]);
  });

  it('the read budget running out on per-group reads stops them and records the truncation; the rest stay undescribed', async () => {
    m365Default({
      'm365.group.list': () => ({ ok: true, kind: 'collection', truncated: true, items: [] }),
      'm365.group.get': () => ({ ok: false, code: 'read_rate_limited', message: 'budget' }),
    });
    const f = await discover();
    expect(f.groups.m365).toEqual([]);
    expect(m365Calls('m365.group.get').length).toBe(1);
    expect(f.truncated).toContain('m365.requestedGroups');
  });

  it('a non-transient group-list refusal leaves the requested groups undescribed plus a flag; a transient one rethrows', async () => {
    m365Default({ 'm365.group.list': () => ({ ok: false, code: 'graph_permission_missing', message: 'perm' }) });
    const f = await discover();
    expect(f.groups.m365).toEqual([]);
    expect(f.flags.length).toBeGreaterThan(0);

    m365Default({ 'm365.group.list': () => ({ ok: false, code: 'graph_throttled', message: 'blip' }) });
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  it('Google: OWNER / MANAGER roles of the model-after person are reported; not-a-member is null', async () => {
    googleDefault({ roles: { 'all@customer.example': 'MANAGER' } });
    const f = await discover();
    expect(f.groups.google).toEqual([
      { email: 'all@customer.example', name: 'all', modelAfterRole: 'MANAGER' },
      { email: 'leads@customer.example', name: 'leads', modelAfterRole: null },
    ]);
  });

  it('Google: a group that does not exist is undescribed plus a flag; a role read refused is undescribed (fail closed)', async () => {
    googleDefault({ roles: { 'all@customer.example': 403 } });
    h.dir.groups.get.mockImplementation(async ({ groupKey }: { groupKey: string }) => {
      if (groupKey === 'leads@customer.example') throw httpError(404);
      return { data: { email: groupKey, name: 'all' } };
    });
    const f = await discover();
    expect(f.groups.google).toEqual([]);
    expect(f.flags.map((x) => x.code)).toEqual(expect.arrayContaining(['google_group_not_found', 'google_group_role_read_failed']));
  });

  it('Google: a transient fault on a group or role read RETHROWS (the role decides the plan)', async () => {
    googleDefault({ roles: { 'all@customer.example': 503 } });
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
    googleDefault();
    h.dir.groups.get.mockRejectedValue(httpError(500));
    await expect(discover()).rejects.toBeInstanceOf(DiscoveryTransientError);
  });
});

describe('model-after (D-R2-9) — a tenant-scoped read, bounded', () => {
  it('a model-after contact in ANOTHER org is refused: modelAfter null, a flag, and none of its accounts read', async () => {
    h.tables.contacts = [{ id: MA, orgId: OTHER_ORG, name: 'Stranger', email: 'x@other.example' }];
    h.tables.contact_external_links = [
      { contactId: MA, orgId: OTHER_ORG, system: 'm365', externalId: MA_M365 },
      { contactId: MA, orgId: OTHER_ORG, system: 'google', externalId: MA_GOOGLE },
    ];
    const f = await discover();
    expect(f.modelAfter).toBeNull();
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'model_after_not_in_org', subject: MA }));
    expect(m365Calls('m365.user.get').map((a) => a.userIdOrUpn)).not.toContain(MA_M365);
    expect(m365Calls('m365.group.member.get')).toEqual([]);
    expect(h.dir.users.get.mock.calls.map((c: any[]) => c[0].userKey)).not.toContain(MA_GOOGLE);
    expect(h.dir.groups.list).not.toHaveBeenCalled();
    expect(h.dir.members.get).not.toHaveBeenCalled();
    // No model-after ⇒ no role to copy; the requested groups are still described.
    expect(f.groups.google.map((g) => g.modelAfterRole)).toEqual([null, null]);
  });

  it('a cross-tenant manager or site is flagged', async () => {
    h.tables.contacts!.push({ id: '00000000-0000-4000-8000-0000000000d3', orgId: OTHER_ORG, name: 'Elsewhere' });
    h.tables.sites = [{ id: SITE, orgId: OTHER_ORG }];
    const f = await discover(input({ managerContactId: '00000000-0000-4000-8000-0000000000d3', siteId: SITE }));
    expect(f.flags.map((x) => x.code)).toEqual(expect.arrayContaining(['manager_not_in_org', 'site_not_in_org']));

    tablesDefault();
    const g = await discover(input({ managerContactId: MGR, siteId: SITE }));
    expect(g.flags.map((x) => x.code)).not.toContain('manager_not_in_org');
    expect(g.flags.map((x) => x.code)).not.toContain('site_not_in_org');
  });

  it('every Breeze read carries an org_id predicate', async () => {
    await discover(input({ managerContactId: MGR, siteId: SITE }));
    expect(h.wheres.map((w) => w.table).sort()).toEqual(['contact_external_links', 'contacts', 'contacts', 'sites']);
    for (const w of h.wheres) {
      const q = new PgDialect().sqlToQuery(w.where as SQL);
      expect(q.sql).toMatch(/"org_id" = \$\d/);
      expect(q.params).toContain(ORG);
    }
  });

  it('no external link for a provider in scope ⇒ that provider null plus a flag, no throw', async () => {
    h.tables.contact_external_links = [{ contactId: MA, orgId: ORG, system: 'google', externalId: MA_GOOGLE }];
    const f = await discover();
    expect(f.modelAfter?.m365).toBeNull();
    expect(f.modelAfter?.google).not.toBeNull();
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'model_after_no_m365_account' }));
  });

  it('no Google link ⇒ role unknown for every requested Google group (null) plus a flag', async () => {
    h.tables.contact_external_links = [{ contactId: MA, orgId: ORG, system: 'm365', externalId: MA_M365 }];
    const f = await discover();
    expect(f.modelAfter?.google).toBeNull();
    expect(f.groups.google.map((g) => g.modelAfterRole)).toEqual([null, null]);
    expect(h.dir.members.get).not.toHaveBeenCalled();
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'model_after_no_google_account' }));
  });

  it('a model-after M365 read naming a different user is never used', async () => {
    m365Default({ 'm365.user.get': (a) => (a.userIdOrUpn === MA_M365
      ? { ok: true, kind: 'resource', resource: { id: HOLDER } }
      : { ok: false, code: 'graph_not_found', message: 'x' }) });
    const f = await discover();
    expect(f.modelAfter?.m365).toBeNull();
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'm365_account_mismatch' }));
  });

  it('the membership scan running out of read budget keeps what it found and records the truncation', async () => {
    let n = 0;
    m365Default({ 'm365.group.member.get': () => {
      n += 1;
      return n === 1 ? { ok: true, kind: 'collection', truncated: false, items: [{ id: MA_M365 }] } : { ok: false, code: 'read_rate_limited', message: 'b' };
    } });
    const f = await discover();
    expect(f.modelAfter?.m365?.groupIds).toEqual([GR1]);
    expect(f.truncated).toContain('modelAfter.m365.groups');
  });

  it('the model-after lists respect DISCOVERY_LIMITS and record truncation at collection', async () => {
    const many = Array.from({ length: DISCOVERY_LIMITS.groups + 20 }, (_v, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, displayName: `G${i}`, groupTypes: [],
    }));
    m365Default({
      'm365.group.list': () => ({ ok: true, kind: 'collection', truncated: false, items: many }),
      'm365.group.member.get': () => ({ ok: true, kind: 'collection', truncated: false, items: [{ id: MA_M365 }] }),
    });
    h.dir.groups.list.mockResolvedValue({ data: {
      groups: Array.from({ length: 150 }, (_v, i) => ({ id: `g${i}`, email: `g${i}@customer.example` })),
      nextPageToken: 'more',
    } });
    const f = await discover();
    expect(f.modelAfter!.m365!.groupIds.length).toBe(DISCOVERY_LIMITS.groups);
    expect(f.modelAfter!.google!.groupEmails.length).toBe(DISCOVERY_LIMITS.groups);
    expect(f.truncated).toEqual(expect.arrayContaining(['modelAfter.m365.groups', 'modelAfter.google.groups']));
    // Stopped AT the cap: one membership read past it, never the whole list.
    expect(m365Calls('m365.group.member.get').length).toBeLessThanOrEqual(DISCOVERY_LIMITS.groups + 1);
  });
});

describe('bounds', () => {
  it('the facts stay under DISCOVERY_FACTS_MAX_BYTES for a pathological worst case, recording what was dropped', async () => {
    const long = 'x'.repeat(400);
    const groupIds = Array.from({ length: 50 }, (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const groupEmails = Array.from({ length: 50 }, (_v, i) => `${'g'.repeat(150)}${i}@${'d'.repeat(60)}.${'e'.repeat(60)}.example`);
    m365Default({
      'm365.group.list': () => ({ ok: true, kind: 'collection', truncated: false,
        items: groupIds.map((id) => ({ id, displayName: long, groupTypes: [] })) }),
      'm365.group.member.get': () => ({ ok: true, kind: 'collection', truncated: false, items: [{ id: MA_M365 }] }),
    });
    h.dir.groups.list.mockResolvedValue({ data: { groups: groupEmails.map((email) => ({ email })) } });
    h.dir.groups.get.mockImplementation(async ({ groupKey }: { groupKey: string }) => ({ data: { email: groupKey, name: long } }));
    h.dir.members.get.mockResolvedValue({ data: { role: 'MEMBER' } });
    const i = input({
      m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', groupIds },
      google: { primaryEmail: GMAIL, givenName: 'P', familyName: 'P', groupEmails },
    });
    const f = await discover(i);
    expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThanOrEqual(DISCOVERY_FACTS_MAX_BYTES);
    expect(f.truncated.length).toBeGreaterThan(0);
    // Shedding starts with the INFORMATIONAL model-after lists.
    expect(f.truncated).toEqual(expect.arrayContaining(['modelAfter.google.groups']));
    expect(f.flags.length).toBeLessThanOrEqual(64);
  });

  it('flags are capped at 64 with the overflow recorded as truncated', async () => {
    const groupEmails = Array.from({ length: 50 }, (_v, i) => `grp${i}@customer.example`);
    const groupIds = Array.from({ length: 50 }, (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    h.dir.groups.get.mockRejectedValue(httpError(404));
    const f = await discover(input({
      m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US', groupIds },
      google: { primaryEmail: GMAIL, givenName: 'P', familyName: 'P', groupEmails },
    }));
    expect(f.flags.length).toBe(64);
    expect(f.truncated).toContain('flags');
  });
});

describe('read-only and model-free, on the module source', () => {
  it('consults no model and writes nothing', () => {
    const src = readFileSync(join(__dirname, 'identityProvisioning.ts'), 'utf8');
    expect(src).not.toMatch(/createAndEnqueueAgentRun|aiAgentSdk|anthropic|submit_task_step/);
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(src).not.toMatch(/\.(patch|insert|create|update|delete)\(\s*\{/);
  });
});

describe('readOnboardingDraftFacts — flags carry no raw provider text (R2a Task 14)', () => {
  it('a provider error message never reaches the draft flags', async () => {
    const SECRET = 'AADSTS-raw-tenant-detail-7f3a';
    m365Default({
      'm365.user.get': () => { throw new Error(`boom ${SECRET}`); },
      'm365.org.skus.list': () => { throw new Error(`sku boom ${SECRET}`); },
    });
    h.dir.users.get.mockRejectedValue(Object.assign(new Error(`google boom ${SECRET}`), { code: 400 }));
    const reads = await readOnboardingDraftFacts({ orgId: ORG, input: input(), now: NOW });
    const codes = reads.flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['m365_collision_check_failed', 'm365_seats_read_failed']));
    expect(JSON.stringify(reads.flags)).not.toContain(SECRET);
    expect(JSON.stringify(reads.flags)).not.toContain('boom');
  });
});
