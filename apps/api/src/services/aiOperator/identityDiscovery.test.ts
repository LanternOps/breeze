/**
 * `identityDiscovery.ts` — coordinator-issued deterministic reads (spec §6.2).
 *
 * Its output is the `facts` argument to `buildPlan`, frozen into the planning
 * snapshot and hashed into an approval, so it must be:
 *  - BOUNDED: every array capped at collection time, with the truncation
 *    recorded (an uncapped read would blow the approval card and the digest);
 *  - TOTAL: a provider that errors yields `present: false` plus a flag, never
 *    a throw that fails the task (spec §4.1 — offboarding degrades by provider);
 *  - EXACT: a mobile device that does not carry the user's exact address is
 *    dropped (the `resolveWipeTarget` gate), and Breeze devices are only ever
 *    SUGGESTIONS from `devices.last_user` (D-R1-8);
 *  - TENANT-SCOPED: every Breeze db read carries an explicit `org_id`
 *    predicate, because it runs in system scope.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  m365Read: vi.fn(),
  resolveContextByOrg: vi.fn(),
  dir: null as any,
  lic: null as any,
  dbRows: [] as Array<Record<string, unknown>[]>,
  wheres: [] as unknown[],
  /** Org-scoped contexts opened, and how deep each provider call ran inside one. */
  contexts: [] as unknown[],
  inCtx: 0,
  providerCallDepths: [] as Array<[string, number]>,
}));

vi.mock('../m365ControlPlane/readActionService', () => ({
  executeM365ReadActionByOrg: (...args: unknown[]) => { h.providerCallDepths.push(['m365', h.inCtx]); return h.m365Read(...args); },
}));
vi.mock('../aiToolsGoogle', () => ({
  resolveContextByOrg: (...args: unknown[]) => { h.providerCallDepths.push(['google', h.inCtx]); return h.resolveContextByOrg(...args); },
  canonicalizeUserEmail: (raw: string) => raw.trim().toLowerCase(),
}));
vi.mock('../googleClient', () => ({
  getDirectoryClient: () => h.dir,
  getLicensingClient: () => h.lic,
  normalizeGoogleError: (err: unknown) => ({ code: 'google_error', message: (err as Error)?.message ?? 'x' }),
}));
vi.mock('../../db', () => {
  const chain = () => {
    const c: any = {
      from: () => c,
      where: (w: unknown) => { h.wheres.push(w); return c; },
      limit: async () => h.dbRows.shift() ?? [],
    };
    return c;
  };
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: async (ctx: unknown, fn: () => Promise<unknown>) => {
      h.contexts.push(ctx);
      h.inCtx += 1;
      try { return await fn(); } finally { h.inCtx -= 1; }
    },
  };
});

import { DISCOVERY_LIMITS, DiscoveryTransientError, discoverIdentityFacts } from './identityDiscovery';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const M365_ID = '00000000-0000-4000-8000-0000000000b1';
const G1 = '00000000-0000-4000-8000-0000000000c1';
const G2 = '00000000-0000-4000-8000-0000000000c2';
const G3 = '00000000-0000-4000-8000-0000000000c3';
const SKU = '18181a46-0d4e-45cd-891e-60aabd171b4e';

const ACCOUNTS = [
  { provider: 'google' as const, externalId: '101', principalLabel: 'dana@customer.example' },
  { provider: 'm365' as const, externalId: M365_ID, principalLabel: 'dana@customer.example' },
];

function m365Ok(): void {
  h.m365Read.mockImplementation(async (_org: string, action: { type: string; groupId?: string }) => {
    switch (action.type) {
      case 'm365.user.get':
        return { ok: true, kind: 'resource', resource: {
          id: M365_ID, userPrincipalName: 'dana@customer.example', accountEnabled: true,
          assignedLicenses: [{ skuId: SKU }],
        } };
      case 'm365.org.skus.list':
        return { ok: true, kind: 'collection', truncated: false, items: [{ skuId: SKU, skuPartNumber: 'STANDARDPACK' }] };
      case 'm365.group.list':
        return { ok: true, kind: 'collection', truncated: false, items: [
          { id: G1, displayName: 'Marketing', mail: 'mkt@customer.example', groupTypes: ['Unified'] },
          { id: G2, displayName: 'Dynamic All', mail: null, groupTypes: ['DynamicMembership'] },
          { id: G3, displayName: 'Not hers', mail: null, groupTypes: [] },
        ] };
      case 'm365.group.member.get':
        return { ok: true, kind: 'collection', truncated: false,
          items: action.groupId === G3 ? [] : [{ id: M365_ID }] };
      case 'm365.intune.device.list':
        return { ok: true, kind: 'collection', truncated: false, items: [
          { id: 'id1', deviceName: 'DANA-IPHONE', userPrincipalName: 'Dana@customer.example' },
          { id: 'id2', deviceName: 'SAM-PHONE', userPrincipalName: 'sam@customer.example' },
        ] };
      default:
        return { ok: false, code: 'tools_disabled', message: `unexpected ${action.type}` };
    }
  });
}

function googleOk(over: { groups?: unknown[]; owners?: Record<string, string[]>; devices?: unknown[] } = {}): void {
  h.resolveContextByOrg.mockResolvedValue({ conn: { adminEmail: 'admin@customer.example' }, keyJson: '{}' });
  const groups = over.groups ?? [
    { id: 'g1', email: 'all@customer.example', name: 'All Staff' },
    { id: 'g2', email: 'fin@customer.example', name: 'Finance' },
  ];
  const owners = over.owners ?? { 'fin@customer.example': ['dana@customer.example'], 'all@customer.example': ['boss@customer.example'] };
  h.dir = {
    users: { get: vi.fn(async () => ({ data: { id: '101', primaryEmail: 'Dana@customer.example', suspended: false } })) },
    groups: { list: vi.fn(async () => ({ data: { groups } })) },
    members: {
      get: vi.fn(async ({ groupKey }: { groupKey: string }) => ({
        data: { role: (owners[groupKey] ?? []).includes('dana@customer.example') ? 'OWNER' : 'MEMBER' },
      })),
      list: vi.fn(async ({ groupKey }: { groupKey: string }) => ({
        data: { members: (owners[groupKey] ?? []).map((email) => ({ email, role: 'OWNER' })) },
      })),
    },
    mobiledevices: {
      list: vi.fn(async () => ({ data: { mobiledevices: over.devices ?? [
        { resourceId: 'md1', model: 'Pixel 8', status: 'APPROVED', email: ['dana@customer.example'] },
        { resourceId: 'md2', model: 'iPhone', status: 'APPROVED', email: ['dana.smith@customer.example'] },
      ] } })),
    },
  };
  h.lic = {
    licenseAssignments: {
      listForProduct: vi.fn(async ({ productId }: { productId: string }) => ({
        data: productId === 'Google-Apps'
          ? { items: [
            { userId: 'dana@customer.example', productId: 'Google-Apps', skuId: '1010020020', skuName: 'Business Standard' },
            { userId: 'sam@customer.example', productId: 'Google-Apps', skuId: '1010020020', skuName: 'Business Standard' },
          ] }
          : { items: [] },
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbRows = [];
  h.wheres = [];
  h.contexts = [];
  h.inCtx = 0;
  h.providerCallDepths = [];
  m365Ok();
  googleOk();
});

describe('discoverIdentityFacts — the happy path', () => {
  it('returns present:true on both providers and populates every array', async () => {
    h.dbRows = [[{ id: 'dev-1', hostname: 'DANA-LT', lastUser: 'CORP\\dana' }]];
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google).toMatchObject({ present: true, externalId: '101', primaryEmail: 'dana@customer.example', suspended: false });
    expect(f.google.groups.map((g) => g.email)).toEqual(['all@customer.example', 'fin@customer.example']);
    expect(f.google.licenses).toEqual([{ productId: 'Google-Apps', skuId: '1010020020', name: 'Business Standard' }]);
    expect(f.m365).toMatchObject({ present: true, externalId: M365_ID, userPrincipalName: 'dana@customer.example', accountEnabled: true });
    expect(f.m365.licenses).toEqual([{ productId: null, skuId: SKU, name: 'STANDARDPACK' }]);
    expect(f.m365.groups.map((g) => g.id)).toEqual([G1, G2]);
    expect(f.m365.intuneDevices).toEqual([{ id: 'id1', model: 'DANA-IPHONE', status: null }]);
    expect(f.breeze.suggestedDevices).toEqual([
      { deviceId: 'dev-1', hostname: 'DANA-LT', lastUser: 'CORP\\dana', matchBasis: 'last_user_ilike' },
    ]);
    expect(f.flags).toEqual([]);
    expect(f.truncated).toEqual([]);
  });

  it('stamps version 1 and an ISO observedAt', async () => {
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS, now: new Date('2026-10-23T12:00:00.000Z') });
    expect(f.version).toBe(1);
    expect(f.observedAt).toBe('2026-10-23T12:00:00.000Z');
  });

  it('an absent account on a provider is present:false with NO flag — not an error', async () => {
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: [ACCOUNTS[0]!] });
    expect(f.m365.present).toBe(false);
    expect(f.flags).toEqual([]);
    expect(h.m365Read).not.toHaveBeenCalled();
  });
});

describe('db context: every provider connection is resolved in an org-scoped context', () => {
  it('each M365 read and the Google connection lookup run INSIDE a context scoped to exactly this org', async () => {
    await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    // The task worker calls advancers with no context; a contextless lookup of
    // a forced-RLS connection table reads as "not connected".
    expect(h.providerCallDepths.length).toBeGreaterThan(1);
    // (≥ 1, not = 1: the two providers read in parallel, so this shared counter
    // can see the other provider's context open at the same time.)
    for (const [provider, depth] of h.providerCallDepths) {
      expect(depth, `${provider} call outside a db context`).toBeGreaterThanOrEqual(1);
    }
    expect(h.providerCallDepths.map(([p]) => p)).toEqual(expect.arrayContaining(['m365', 'google']));
    for (const ctx of h.contexts) {
      expect(ctx).toMatchObject({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] });
    }
  });
});

describe('definitive vs transient: a provider ANSWER degrades, a provider OUTAGE retries', () => {
  it('a REJECTED M365 account read (no answer at all) throws DiscoveryTransientError — never "no account"', async () => {
    h.m365Read.mockRejectedValue(new Error('socket hang up'));
    await expect(discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS })).rejects.toBeInstanceOf(DiscoveryTransientError);
  });

  for (const code of ['executor_unavailable', 'read_rate_limited', 'graph_throttled', 'graph_transport_failed', 'graph_request_timeout']) {
    it(`an M365 account read failing with ${code} throws (the wake retries)`, async () => {
      h.m365Read.mockResolvedValue({ ok: false, code, message: 'x' });
      await expect(discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS })).rejects.toThrow(code);
    });
  }

  it('a Google account read with no HTTP status, or a 5xx, throws; a 403 is a definitive flag', async () => {
    h.dir.users.get.mockRejectedValue(new Error('ECONNRESET'));
    await expect(discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS })).rejects.toBeInstanceOf(DiscoveryTransientError);
    googleOk();
    h.dir.users.get.mockRejectedValue(Object.assign(new Error('backend'), { code: 503 }));
    await expect(discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS })).rejects.toBeInstanceOf(DiscoveryTransientError);
    googleOk();
    h.dir.users.get.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 403 }));
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.present).toBe(false);
    expect(f.flags.map((x) => x.code)).toContain('google_read_failed');
  });

  it('the read budget running out MID group scan keeps the groups already found and records truncation', async () => {
    const base = h.m365Read.getMockImplementation()!;
    h.m365Read.mockImplementation(async (org: string, action: { type: string; groupId?: string }) => (
      action.type === 'm365.group.member.get' && action.groupId === G2
        ? { ok: false, code: 'read_rate_limited', message: 'budget' }
        : base(org, action)
    ));
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.m365.present).toBe(true);
    expect(f.m365.groups.map((g) => g.id)).toEqual([G1]);
    expect(f.truncated).toContain('m365.groups');
  });
});

describe('total: a failing provider degrades, never throws', () => {
  it('an {ok:false} M365 service result yields present:false and m365_read_failed', async () => {
    h.m365Read.mockResolvedValue({ ok: false, code: 'connection_not_ready', message: 'not ready' });
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.m365.present).toBe(false);
    expect(f.flags).toContainEqual(expect.objectContaining({ code: 'm365_read_failed' }));
  });

  it('a permission refusal gets its OWN flag code — it means "re-consent", not "broken"', async () => {
    h.m365Read.mockResolvedValue({ ok: false, code: 'graph_permission_missing', message: 'perm' });
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.m365.present).toBe(false);
    expect(f.flags.map((x) => x.code)).toContain('m365_consent_upgrade_required');
    expect(f.flags.map((x) => x.code)).not.toContain('m365_read_failed');
  });

  it('a Google read REFUSED with a 4xx yields present:false and google_read_failed', async () => {
    h.dir.users.get.mockRejectedValue(Object.assign(new Error('boom'), { code: 400 }));
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.present).toBe(false);
    expect(f.flags.map((x) => x.code)).toContain('google_read_failed');
    expect(f.m365.present).toBe(true);
  });

  it('no Google connection yields present:false and google_connection_unavailable', async () => {
    h.resolveContextByOrg.mockResolvedValue({ error: 'no_google_connection' });
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.present).toBe(false);
    expect(f.flags.map((x) => x.code)).toContain('google_connection_unavailable');
  });

  it('a failed SUB-read (groups) keeps the account present, empties that list, and flags it', async () => {
    h.dir.groups.list.mockRejectedValue(new Error('groups down'));
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.present).toBe(true);
    expect(f.google.groups).toEqual([]);
    expect(f.flags.map((x) => x.code)).toContain('google_groups_read_failed');
  });

  it('a Google user whose id does not match the frozen external id is NOT present', async () => {
    h.dir.users.get.mockResolvedValue({ data: { id: '999', primaryEmail: 'other@customer.example' } });
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.present).toBe(false);
    expect(f.flags.map((x) => x.code)).toContain('google_account_mismatch');
  });
});

describe('bounded: every array capped at collection, truncation recorded', () => {
  it('caps Google groups at DISCOVERY_LIMITS.groups and records google.groups', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `g${i}`, email: `g${i}@customer.example`, name: `G${i}` }));
    googleOk({ groups: many, owners: {} });
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.groups).toHaveLength(DISCOVERY_LIMITS.groups);
    expect(f.truncated).toContain('google.groups');
    // Capped at COLLECTION: membership role reads ran for the kept groups only.
    expect(h.dir.members.get.mock.calls.length).toBeLessThanOrEqual(DISCOVERY_LIMITS.groups);
  });

  it('records m365.groups when the group enumeration itself was truncated', async () => {
    const base = h.m365Read.getMockImplementation()!;
    h.m365Read.mockImplementation(async (org: string, action: { type: string }) => (
      action.type === 'm365.group.list'
        ? { ok: true, kind: 'collection', truncated: true, items: [] }
        : base(org, action)
    ));
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.truncated).toContain('m365.groups');
  });

  it('the capped worst case is JSON-serializable and under 64 KiB', async () => {
    const long = 'x'.repeat(5000);
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `g${i}${long}`, email: `g${i}@customer.example`, name: long }));
    googleOk({ groups: many, owners: {}, devices: Array.from({ length: 100 }, (_, i) => ({
      resourceId: `md${i}${long}`, model: long, status: long, email: ['dana@customer.example'],
    })) });
    h.dbRows = [Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, hostname: long, lastUser: long }))];
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
    expect(JSON.stringify(f).length).toBeLessThan(64 * 1024);
    expect(f.google.mobileDevices.length).toBeLessThanOrEqual(DISCOVERY_LIMITS.mobileDevices);
  });
});

describe('exact: groups, devices and ownership', () => {
  it('marks a dynamic-membership M365 group and STILL returns it', async () => {
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    const dyn = f.m365.groups.find((g) => g.id === G2)!;
    expect(dyn.dynamic).toBe(true);
    expect(f.m365.groups.find((g) => g.id === G1)!.dynamic).toBe(false);
  });

  it('every M365 group ownership is unknown (no owners read exists, D-R1-7)', async () => {
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.m365.groups.every((g) => g.ownership === 'unknown')).toBe(true);
  });

  it('Google ownership: sole when the person is the only OWNER, shared when another owner exists, none otherwise', async () => {
    googleOk({ owners: {
      'fin@customer.example': ['dana@customer.example'],
      'all@customer.example': ['dana@customer.example', 'boss@customer.example'],
    } });
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.groups.find((g) => g.email === 'fin@customer.example')!.ownership).toBe('sole');
    expect(f.google.groups.find((g) => g.email === 'all@customer.example')!.ownership).toBe('shared');
    googleOk({ owners: { 'fin@customer.example': ['boss@customer.example'] } });
    const g = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(g.google.groups.every((x) => x.ownership === 'none')).toBe(true);
  });

  it('DROPS a mobile device that does not carry the exact primary address (the resolveWipeTarget gate)', async () => {
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.google.mobileDevices.map((d) => d.id)).toEqual(['md1']);
  });

  it('Breeze suggestions match on last_user with an org_id predicate; zero matches is not a flag', async () => {
    h.dbRows = [[]];
    const f = await discoverIdentityFacts({ orgId: ORG, accounts: ACCOUNTS });
    expect(f.breeze.suggestedDevices).toEqual([]);
    expect(f.flags).toEqual([]);
    expect(h.wheres.length).toBeGreaterThan(0);
    for (const w of h.wheres) {
      const q = new PgDialect().sqlToQuery(w as SQL);
      expect(q.sql).toMatch(/"org_id" = \$\d/);
      expect(q.params).toContain(ORG);
    }
    const ilike = new PgDialect().sqlToQuery(h.wheres[0] as SQL);
    expect(ilike.sql.toLowerCase()).toContain('ilike');
    expect(ilike.params).toContain('%dana%');
  });

  it('escapes LIKE wildcards in the account local part', async () => {
    h.dbRows = [[]];
    await discoverIdentityFacts({ orgId: ORG, accounts: [{ provider: 'google', externalId: '101', principalLabel: 'd_a%na@customer.example' }] });
    const q = new PgDialect().sqlToQuery(h.wheres[0] as SQL);
    expect(q.params).toContain('%d\\_a\\%na%');
  });

  it('resolves an inheritor contact email with an org_id predicate', async () => {
    h.dbRows = [[], [{ email: 'sam@customer.example' }]];
    const f = await discoverIdentityFacts({
      orgId: ORG, accounts: [ACCOUNTS[0]!], inheritorContactId: '00000000-0000-4000-8000-0000000000dd',
    });
    expect(f.inheritor).toEqual({ contactId: '00000000-0000-4000-8000-0000000000dd', email: 'sam@customer.example' });
    const q = new PgDialect().sqlToQuery(h.wheres[1] as SQL);
    expect(q.params).toEqual(expect.arrayContaining([ORG, '00000000-0000-4000-8000-0000000000dd']));
  });
});

describe('invariant: no model is consulted', () => {
  it('the module source names no agent run, SDK, model vendor or submit tool', () => {
    const src = readFileSync(join(__dirname, 'identityDiscovery.ts'), 'utf8');
    expect(src).not.toMatch(/createAndEnqueueAgentRun|aiAgentSdk|anthropic|submit_task_step/);
  });

  it('writes nothing: the module has no insert/update/delete', () => {
    const src = readFileSync(join(__dirname, 'identityDiscovery.ts'), 'utf8');
    expect(src).not.toMatch(/\.(insert|update|delete)\(/);
  });
});
