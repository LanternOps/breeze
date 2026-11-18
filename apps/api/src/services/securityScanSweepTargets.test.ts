import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

/**
 * resolveSweepTargets (#6263 W05-5). The DB is faked at the select-chain
 * level: each `from(table)` returns the next queued row set for that table and
 * records its `where` so the lifecycle predicates can be asserted. Drizzle's
 * operators are replaced with inspectable objects.
 */

type Cond = { op: string; args: unknown[] };
const { queries, rowsByTable, getUserPermissionsMock, NOT_PARKED } = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; where: unknown }>,
  rowsByTable: new Map<string, unknown[][]>(),
  getUserPermissionsMock: vi.fn(),
  NOT_PARKED: { op: 'notParked', args: [] },
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const mk = (op: string) => (...args: unknown[]): Cond => ({ op, args });
  return { ...actual, and: mk('and'), eq: mk('eq'), ne: mk('ne'), inArray: mk('inArray') };
});

vi.mock('./deviceGroupOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('./deviceGroupOwnership')>(),
  findPartnerOwnedGroupIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../db', () => {
  const select = () => ({
    from: (table: unknown) => {
      const name = getTableNameSafe(table);
      const chain = {
        innerJoin: () => chain,
        where: (where: unknown) => {
          queries.push({ table: name, where });
          const queue = rowsByTable.get(name) ?? [];
          return Promise.resolve(queue.length > 0 ? queue.shift()! : []);
        },
      };
      return chain;
    },
  });
  return { db: { select, insert: vi.fn(), update: vi.fn() } };
});

function getTableNameSafe(table: unknown): string {
  return getTableName(table as Parameters<typeof getTableName>[0]);
}

vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: (...a: unknown[]) => getUserPermissionsMock(...a) };
});
vi.mock('./unassignedPool/selectorPredicate', () => ({ notParkedDeviceCondition: () => NOT_PARKED }));

import { db } from '../db';
import { findPartnerOwnedGroupIds } from './deviceGroupOwnership';
import { devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { computeSweepPreviewDigest, resolveSweepTargets } from './securityScanSweepTargets';

const PARTNER = 'p0000000-0000-4000-8000-000000000001';
const OTHER_PARTNER = 'p0000000-0000-4000-8000-000000000002';
const ORG_A = 'a0000000-0000-4000-8000-000000000001';
const ORG_B = 'b0000000-0000-4000-8000-000000000001';
const SITE_A1 = 'a1000000-0000-4000-8000-000000000001';
const SITE_A2 = 'a2000000-0000-4000-8000-000000000001';
const SITE_B1 = 'b1000000-0000-4000-8000-000000000001';
const SET_A = '5a000000-0000-4000-8000-000000000001';
const SET_PARTNER = '5b000000-0000-4000-8000-000000000001';
const SET_BUILTIN = '00000000-0000-4000-8000-00000000b001';
const SHA = (c: string) => c.repeat(64);

const execute = { resource: 'devices', action: 'execute' };
const read = { resource: 'devices', action: 'read' };
const perms = (permissions: Array<{ resource: string; action: string }>, extra: Record<string, unknown> = {}) => ({
  permissions,
  partnerId: PARTNER,
  orgId: null,
  roleId: 'r',
  scope: 'partner' as const,
  ...extra,
});

function partnerAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_A, ORG_B],
    orgCondition: () => ({ op: 'tenantFence', args: [] }) as never,
    canAccessOrg: (id: string) => [ORG_A, ORG_B].includes(id),
    ...over,
  } as AuthContext;
}

type Dev = { id: string; orgId: string; siteId: string; agentVersion: string; partnerId: string; orgName: string };
let seq = 0;
function dev(orgId: string, over: Partial<Dev> = {}): Dev {
  seq++;
  return {
    id: `d${String(seq).padStart(7, '0')}-0000-4000-8000-000000000000`,
    orgId,
    siteId: orgId === ORG_A ? SITE_A1 : SITE_B1,
    agentVersion: '0.124.0',
    partnerId: PARTNER,
    orgName: orgId === ORG_A ? 'Org A' : 'Org B',
    ...over,
  };
}

const setRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `set ${id.slice(0, 4)}`,
  orgId: null,
  partnerId: null,
  isBuiltin: false,
  enabled: true,
  publishedVersion: 3,
  publishedSha256: SHA('c'),
  ...over,
});
const orgSetA = () => setRow(SET_A, { orgId: ORG_A });
const partnerSet = () => setRow(SET_PARTNER, { partnerId: PARTNER, publishedSha256: SHA('d') });
const builtinSet = () => setRow(SET_BUILTIN, { isBuiltin: true, publishedSha256: SHA('e') });

function queue(table: string, ...rowSets: unknown[][]) {
  rowsByTable.set(table, [...(rowsByTable.get(table) ?? []), ...rowSets]);
}

const base = { ruleSetIds: [SET_PARTNER], scope: { kind: 'all' as const }, scanType: 'quick' as const };

function devicesQuery() {
  const q = queries.filter((x) => x.table === 'devices').at(-1);
  return q?.where as Cond;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findPartnerOwnedGroupIds).mockReset().mockResolvedValue([]);
  queries.length = 0;
  rowsByTable.clear();
  getUserPermissionsMock.mockReset();
  getUserPermissionsMock.mockResolvedValue(perms([execute, read]));
  delete process.env.SECURITY_SWEEP_MAX_DEVICES;
});

describe('resolveSweepTargets', () => {
  it('refuses partner-group scopes with 400 before resolving or persisting targets', async () => {
    const groupId = '33333333-3333-4333-8333-333333333333';
    vi.mocked(findPartnerOwnedGroupIds).mockResolvedValueOnce([groupId]);
    expect(await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'groups', groupIds: [groupId] } }))
      .toEqual({ ok: false, status: 400, code: 'PARTNER_GROUP_TARGET_UNSUPPORTED', detail: { groupIds: [groupId] } });
    expect(findPartnerOwnedGroupIds).toHaveBeenCalledWith([groupId]);
    expect(queries).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('drops parked, ephemeral, decommissioned', async () => {
    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', [dev(ORG_A)]);
    const result = await resolveSweepTargets(partnerAuth(), base);
    expect(result.ok).toBe(true);
    const where = devicesQuery();
    expect(where.op).toBe('and');
    expect(where.args).toContainEqual({ op: 'eq', args: [devices.isEphemeral, false] });
    expect(where.args).toContainEqual({ op: 'ne', args: [devices.status, 'decommissioned'] });
    expect(where.args).toContainEqual(NOT_PARKED);
    // and under the caller's tenant fence
    expect(where.args).toContainEqual({ op: 'tenantFence', args: [] });
  });

  it('per-org permissions: org membership narrower than partner membership wins', async () => {
    getUserPermissionsMock.mockImplementation(async (_u: string, ctx: { orgId?: string }) =>
      ctx.orgId === ORG_B ? perms([read], { scope: 'organization', orgId: ORG_B }) : perms([execute, read]),
    );
    queue('yara_rule_sets', [partnerSet()]);
    const a = dev(ORG_A);
    queue('devices', [a, dev(ORG_B)]);
    const result = await resolveSweepTargets(partnerAuth(), base);
    if (!result.ok) throw new Error(result.code);
    expect([...result.byOrg.keys()]).toEqual([ORG_A]);
    expect(result.byOrg.get(ORG_A)).toEqual([a.id]);
    expect(getUserPermissionsMock).toHaveBeenCalledWith('user-1', { partnerId: PARTNER, orgId: ORG_B, scope: 'partner' });
  });

  it('allowedSiteIds and allowedDeviceIds both intersect', async () => {
    const inSite = dev(ORG_A, { siteId: SITE_A1 });
    const otherSite = dev(ORG_A, { siteId: SITE_A2 });
    const notAllowedDevice = dev(ORG_A, { siteId: SITE_A1 });
    getUserPermissionsMock.mockResolvedValue(perms([execute], { allowedSiteIds: [SITE_A1] }));
    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', [inSite, otherSite, notAllowedDevice]);
    const result = await resolveSweepTargets(partnerAuth({ allowedDeviceIds: [inSite.id, otherSite.id] }), base);
    if (!result.ok) throw new Error(result.code);
    expect(result.byOrg.get(ORG_A)).toEqual([inSite.id]);
  });

  it('explicit foreign site/device → *_OUT_OF_SCOPE', async () => {
    // A site the caller cannot see at all.
    queue('yara_rule_sets', [partnerSet()]);
    queue('sites', []);
    const site = await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'sites', siteIds: [SITE_B1] } });
    expect(site).toMatchObject({ ok: false, status: 403, code: 'SITE_OUT_OF_SCOPE', detail: { siteIds: [SITE_B1] } });

    // A visible site outside the org's site ceiling.
    getUserPermissionsMock.mockResolvedValue(perms([execute], { allowedSiteIds: [SITE_A1] }));
    queue('yara_rule_sets', [partnerSet()]);
    queue('sites', [{ id: SITE_A2, orgId: ORG_A }]);
    const ceiling = await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'sites', siteIds: [SITE_A2] } });
    expect(ceiling).toMatchObject({ ok: false, code: 'SITE_OUT_OF_SCOPE' });

    // A device outside allowedDeviceIds.
    const d = dev(ORG_A);
    getUserPermissionsMock.mockResolvedValue(perms([execute]));
    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', [d]);
    const device = await resolveSweepTargets(partnerAuth({ allowedDeviceIds: [] }), {
      ...base,
      scope: { kind: 'devices', deviceIds: [d.id] },
    });
    expect(device).toMatchObject({ ok: false, status: 403, code: 'DEVICE_OUT_OF_SCOPE', detail: { deviceIds: [d.id] } });
  });

  it('org without devices:execute dropped from all, ORG_OUT_OF_SCOPE when named', async () => {
    getUserPermissionsMock.mockImplementation(async (_u: string, ctx: { orgId?: string }) =>
      ctx.orgId === ORG_B ? perms([read]) : perms([execute]),
    );
    queue('yara_rule_sets', [partnerSet()], [partnerSet()]);
    queue('devices', [dev(ORG_A), dev(ORG_B)]);
    const all = await resolveSweepTargets(partnerAuth(), base);
    if (!all.ok) throw new Error(all.code);
    expect([...all.byOrg.keys()]).toEqual([ORG_A]);

    const named = await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'orgs', orgIds: [ORG_A, ORG_B] } });
    expect(named).toMatchObject({ ok: false, status: 403, code: 'ORG_OUT_OF_SCOPE', detail: { orgIds: [ORG_B] } });

    // An org outside the caller's reach entirely is refused before any read.
    vi.clearAllMocks();
  vi.mocked(findPartnerOwnedGroupIds).mockReset().mockResolvedValue([]);
  queries.length = 0;
    const foreign = 'f0000000-0000-4000-8000-000000000001';
    const out = await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'orgs', orgIds: [foreign] } });
    expect(out).toMatchObject({ ok: false, code: 'ORG_OUT_OF_SCOPE', detail: { orgIds: [foreign] } });
    expect(queries).toEqual([]);
  });

  it("org set ineligible on another org's device → skipped.rule_set_not_eligible", async () => {
    queue('yara_rule_sets', [orgSetA()]);
    const a = dev(ORG_A);
    queue('devices', [a, dev(ORG_B)]);
    const result = await resolveSweepTargets(partnerAuth(), { ...base, ruleSetIds: [SET_A] });
    if (!result.ok) throw new Error(result.code);
    expect(result.byOrg.get(ORG_A)).toEqual([a.id]);
    expect(result.byOrg.has(ORG_B)).toBe(false);
    expect(result.skipped.rule_set_not_eligible).toBe(1);
  });

  it('partner-wide set eligible across its partner; built-in everywhere', async () => {
    queue('yara_rule_sets', [partnerSet(), builtinSet()]);
    const a = dev(ORG_A);
    const b = dev(ORG_B);
    const foreign = dev(ORG_B, { partnerId: OTHER_PARTNER });
    queue('devices', [a, b, foreign]);
    const result = await resolveSweepTargets(partnerAuth(), { ...base, ruleSetIds: [SET_PARTNER, SET_BUILTIN] });
    if (!result.ok) throw new Error(result.code);
    expect(result.byOrg.get(ORG_A)).toEqual([a.id]);
    expect(result.byOrg.get(ORG_B)).toEqual([b.id]);
    // The partner-wide set does not reach another partner's device, even with the built-in alongside.
    expect(result.skipped.rule_set_not_eligible).toBe(1);

    queue('yara_rule_sets', [builtinSet()]);
    queue('devices', [foreign]);
    const builtinOnly = await resolveSweepTargets(partnerAuth(), { ...base, ruleSetIds: [SET_BUILTIN] });
    if (!builtinOnly.ok) throw new Error(builtinOnly.code);
    expect(builtinOnly.byOrg.get(ORG_B)).toEqual([foreign.id]);
  });

  it("agent 0.123.9 skipped; '0.124.0-rc1' eligible; 'dev' skipped", async () => {
    queue('yara_rule_sets', [partnerSet()]);
    const rc = dev(ORG_A, { agentVersion: '0.124.0-rc1' });
    queue('devices', [dev(ORG_A, { agentVersion: '0.123.9' }), rc, dev(ORG_A, { agentVersion: 'dev' })]);
    const result = await resolveSweepTargets(partnerAuth(), base);
    if (!result.ok) throw new Error(result.code);
    expect(result.byOrg.get(ORG_A)).toEqual([rc.id]);
    expect(result.skipped.agent_too_old).toBe(2);
  });

  it('invisible set → 404; disabled/unpublished → 400', async () => {
    queue('yara_rule_sets', []);
    expect(await resolveSweepTargets(partnerAuth(), base)).toMatchObject({
      ok: false, status: 404, code: 'RULE_SET_NOT_FOUND', detail: { ruleSetIds: [SET_PARTNER] },
    });
    queue('yara_rule_sets', [setRow(SET_PARTNER, { partnerId: PARTNER, enabled: false })]);
    expect(await resolveSweepTargets(partnerAuth(), base)).toMatchObject({ ok: false, status: 400, code: 'RULE_SET_NOT_PUBLISHED' });
    queue('yara_rule_sets', [setRow(SET_PARTNER, { partnerId: PARTNER, publishedVersion: 0, publishedSha256: null })]);
    expect(await resolveSweepTargets(partnerAuth(), base)).toMatchObject({ ok: false, status: 400, code: 'RULE_SET_NOT_PUBLISHED' });
  });

  it('10001 → SWEEP_TOO_LARGE; 0 → NO_ELIGIBLE_DEVICES', async () => {
    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', Array.from({ length: 10_001 }, () => dev(ORG_A)));
    expect(await resolveSweepTargets(partnerAuth(), base)).toMatchObject({
      ok: false, status: 400, code: 'SWEEP_TOO_LARGE', detail: { targeted: 10_001, max: 10_000 },
    });

    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', [dev(ORG_A, { agentVersion: '0.1.0' })]);
    expect(await resolveSweepTargets(partnerAuth(), base)).toMatchObject({
      ok: false, status: 400, code: 'NO_ELIGIBLE_DEVICES', detail: { skipped: { agent_too_old: 1 } },
    });
  });

  it('previewDigest stable across input order, changes when a device or a pin sha changes', async () => {
    const pinA = { id: SET_A, version: 1, sha256: SHA('a') };
    const pinB = { id: SET_PARTNER, version: 2, sha256: SHA('b') };
    const one = computeSweepPreviewDigest({ deviceIds: ['x', 'y'], pins: [pinA, pinB], scanType: 'custom', paths: ['/b', '/a'] });
    const reordered = computeSweepPreviewDigest({ deviceIds: ['y', 'x'], pins: [pinB, pinA], scanType: 'custom', paths: ['/a', '/b'] });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(one);
    expect(computeSweepPreviewDigest({ deviceIds: ['x', 'z'], pins: [pinA, pinB], scanType: 'custom', paths: ['/a', '/b'] })).not.toBe(one);
    expect(
      computeSweepPreviewDigest({ deviceIds: ['x', 'y'], pins: [pinA, { ...pinB, sha256: SHA('f') }], scanType: 'custom', paths: ['/a', '/b'] }),
    ).not.toBe(one);

    // End to end: device order from the DB does not move the digest.
    const d1 = dev(ORG_A);
    const d2 = dev(ORG_A);
    queue('yara_rule_sets', [partnerSet()], [partnerSet()]);
    queue('devices', [d1, d2], [d2, d1]);
    const r1 = await resolveSweepTargets(partnerAuth(), base);
    const r2 = await resolveSweepTargets(partnerAuth(), base);
    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    expect(r1.previewDigest).toBe(r2.previewDigest);
  });

  it('upper-case ids match lower-case rows (no false 404/403)', async () => {
    queue('yara_rule_sets', [partnerSet()]);
    const d = dev(ORG_A);
    queue('devices', [d], [d]); // the named-device check, then the candidates
    const result = await resolveSweepTargets(partnerAuth({ canAccessOrg: (id: string) => [ORG_A, ORG_B].includes(id) }), {
      ...base,
      ruleSetIds: [SET_PARTNER.toUpperCase()],
      scope: { kind: 'devices', deviceIds: [d.id.toUpperCase()] },
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.byOrg.get(ORG_A)).toEqual([d.id]);
    expect(result.pins.map((p) => p.id)).toEqual([SET_PARTNER]);
  });

  it('onlyOrgId excludes other orgs', async () => {
    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', [dev(ORG_A)]);
    const result = await resolveSweepTargets(partnerAuth(), { ...base, onlyOrgId: ORG_A });
    expect(result.ok).toBe(true);
    expect(devicesQuery().args).toContainEqual({ op: 'eq', args: [devices.orgId, ORG_A] });

    // A named device in another org is out of scope for a single-org request.
    const b = dev(ORG_B);
    queue('yara_rule_sets', [partnerSet()]);
    queue('devices', [b]);
    expect(
      await resolveSweepTargets(partnerAuth(), { ...base, onlyOrgId: ORG_A, scope: { kind: 'devices', deviceIds: [b.id] } }),
    ).toMatchObject({ ok: false, code: 'DEVICE_OUT_OF_SCOPE' });

    // An org the caller cannot reach.
    expect(
      await resolveSweepTargets(partnerAuth(), { ...base, onlyOrgId: 'f0000000-0000-4000-8000-000000000001' }),
    ).toMatchObject({ ok: false, status: 403, code: 'ORG_OUT_OF_SCOPE' });
  });

  it('groups resolve through device_group_memberships under the tenant fence', async () => {
    queue('yara_rule_sets', [partnerSet()]);
    const d = dev(ORG_A);
    queue('device_group_memberships', [{ deviceId: d.id }, { deviceId: d.id }]);
    queue('devices', [d]);
    const result = await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'groups', groupIds: ['g1'] } });
    if (!result.ok) throw new Error(result.code);
    expect(devicesQuery().args).toContainEqual({ op: 'inArray', args: [devices.id, [d.id]] });

    queue('yara_rule_sets', [partnerSet()]);
    queue('device_group_memberships', []);
    expect(await resolveSweepTargets(partnerAuth(), { ...base, scope: { kind: 'groups', groupIds: ['g2'] } })).toMatchObject({
      ok: false, code: 'NO_ELIGIBLE_DEVICES',
    });
  });

  it('a platform admin system token resolves permissions once, org-independently', async () => {
    const auth = partnerAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null, canAccessOrg: () => true });
    queue('yara_rule_sets', [builtinSet()]);
    queue('devices', [dev(ORG_A), dev(ORG_B)]);
    const result = await resolveSweepTargets(auth, { ...base, ruleSetIds: [SET_BUILTIN] });
    expect(result.ok).toBe(true);
    expect(getUserPermissionsMock).toHaveBeenCalledTimes(1);
    expect(getUserPermissionsMock).toHaveBeenCalledWith('user-1', { scope: 'system' });
  });
});
