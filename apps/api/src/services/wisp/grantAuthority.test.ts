import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissions: vi.fn(),
  computeAccessibleOrgIds: vi.fn(),
  wispEnabled: vi.fn(() => true),
}));

vi.mock('../../config/env', () => ({ wispEnabled: shared.wispEnabled }));

vi.mock('../../db', () => ({
  db: { select: shared.selectMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../permissions', () => ({
  getUserPermissions: shared.getUserPermissions,
}));

vi.mock('../../middleware/auth', () => ({
  computeAccessibleOrgIds: shared.computeAccessibleOrgIds,
}));

// computeLiveHumanTerm imports this lazily; the real module pulls the whole
// db/schema barrel, whose cold transform on the first case can outlast the 5 s
// timeout on a loaded host. `db` is a fake here, so the predicate is opaque.
vi.mock('../unassignedPool/visibility', () => ({
  notHiddenOrgType: () => ({ __predicate: 'notHiddenOrgType' }),
}));

import {
  assertToolCallWithinCeiling,
  assertWithinCeiling,
  ceilingSnapshotHash,
  computeLiveHumanTerm,
  intersectSnapshotWithLive,
  resolveGrantCeiling,
  CeilingViolationError,
  GrantInactiveError,
  type GrantCeiling,
} from './grantAuthority';
import { AGENT_DENIED_READ_TOOLS, AGENT_HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';

const ceiling = (o: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: 'g', revisionId: 'r', partnerId: 'p', grantorUserId: 'u1', scopeOrgId: null, partnerWide: true, status: 'active',
  orgIds: new Set(['org-a']), siteIds: null, permissionKeys: new Set(['devices:read', 'tickets:write']),
  toolAllowlist: null, deniedTools: new Set([...AGENT_HUMAN_ONLY_TOOLS, ...AGENT_DENIED_READ_TOOLS.keys()]), orgTerms: new Map(), ...o,
});

describe('assertWithinCeiling', () => {
  it('passes a check inside every term', () => {
    expect(() => assertWithinCeiling(ceiling(), { toolName: 'get_device', permission: 'devices:read', orgId: 'org-a' })).not.toThrow();
  });
  it('throws code org for an org outside the ceiling', () => {
    expect(() => assertWithinCeiling(ceiling(), { orgId: 'org-b' })).toThrow(expect.objectContaining({ code: 'org' }));
  });
  it('throws code site when siteIds is set and the site is outside', () => {
    expect(() => assertWithinCeiling(ceiling({ siteIds: new Set(['s1']) }), { orgId: 'org-a', siteId: 's2' })).toThrow(expect.objectContaining({ code: 'site' }));
  });
  it('siteId null with a site-restricted ceiling is a violation (unknown site never widens)', () => {
    expect(() => assertWithinCeiling(ceiling({ siteIds: new Set(['s1']) }), { orgId: 'org-a', siteId: null })).toThrow(expect.objectContaining({ code: 'site' }));
  });
  it('a site inside a site-restricted ceiling passes', () => {
    expect(() => assertWithinCeiling(ceiling({ siteIds: new Set(['s1']) }), { orgId: 'org-a', siteId: 's1' })).not.toThrow();
  });
  it('throws code permission for a key the grantor does not hold', () => {
    expect(() => assertWithinCeiling(ceiling(), { permission: 'scripts:execute' })).toThrow(expect.objectContaining({ code: 'permission' }));
  });
  it('a malformed permission key is a violation, never a pass', () => {
    expect(() => assertWithinCeiling(ceiling({ permissionKeys: new Set(['*:*']) }), { permission: 'scripts' })).toThrow(expect.objectContaining({ code: 'permission' }));
  });
  it('a wildcard grantor (*:*) satisfies any permission', () => {
    expect(() => assertWithinCeiling(ceiling({ permissionKeys: new Set(['*:*']) }), { permission: 'scripts:execute' })).not.toThrow();
  });
  it('a resource wildcard (devices:*) satisfies devices:execute but not scripts:execute', () => {
    const c = ceiling({ permissionKeys: new Set(['devices:*']) });
    expect(() => assertWithinCeiling(c, { permission: 'devices:execute' })).not.toThrow();
    expect(() => assertWithinCeiling(c, { permission: 'scripts:execute' })).toThrow(expect.objectContaining({ code: 'permission' }));
  });
  it('throws code tool for AGENT_HUMAN_ONLY_TOOLS even with a null allowlist', () => {
    expect(() => assertWithinCeiling(ceiling(), { toolName: 'manage_ai_agents' })).toThrow(expect.objectContaining({ code: 'tool' }));
  });
  it('throws code tool for AGENT_DENIED_READ_TOOLS (Tier-1 reads are inside the ceiling)', () => {
    expect(() => assertWithinCeiling(ceiling(), { toolName: 'get_user_risk_scores' })).toThrow(expect.objectContaining({ code: 'tool' }));
  });
  it('throws code tool when an allowlist is set and the tool is absent', () => {
    expect(() => assertWithinCeiling(ceiling({ toolAllowlist: new Set(['get_device']) }), { toolName: 'list_alerts' })).toThrow(expect.objectContaining({ code: 'tool' }));
  });
  it('throws code inactive before any other term', () => {
    expect(() => assertWithinCeiling(ceiling({ status: 'paused' }), { orgId: 'org-b' })).toThrow(expect.objectContaining({ code: 'inactive' }));
  });
  it('throws a CeilingViolationError instance', () => {
    expect(() => assertWithinCeiling(ceiling(), { orgId: 'org-b' })).toThrow(CeilingViolationError);
  });
  it('a partner-level check (orgId null) passes only for a partner-wide grant (w00 A30 scopeOrgId)', () => {
    expect(() => assertWithinCeiling(ceiling({ scopeOrgId: null }), { orgId: null })).not.toThrow();
    expect(() => assertWithinCeiling(ceiling({ scopeOrgId: 'org-a', partnerWide: false }), { orgId: null })).toThrow(expect.objectContaining({ code: 'org' }));
  });
  it('a partner-level check needs the grantor\'s LIVE full-partner reach, not just a partner-wide scope', () => {
    expect(() => assertWithinCeiling(ceiling({ scopeOrgId: null, partnerWide: false }), { orgId: null })).toThrow(expect.objectContaining({ code: 'org' }));
  });
  it('an org-scoped ceiling refuses any other org even if its org set were wider', () => {
    expect(() => assertWithinCeiling(ceiling({ scopeOrgId: 'org-a', partnerWide: false, orgIds: new Set(['org-a', 'org-b']) }), { orgId: 'org-b' }))
      .toThrow(expect.objectContaining({ code: 'org' }));
  });
});

describe('ceilingSnapshotHash / intersectSnapshotWithLive', () => {
  it('ceilingSnapshotHash is order-independent and 64 hex chars', () => {
    const a: WispCeilingSnapshot = { version: 1, permissionKeys: ['a:b', 'c:d'], orgIds: ['o2', 'o1'], siteIds: null, toolAllowlist: null, deniedTools: [] };
    const b: WispCeilingSnapshot = { ...a, permissionKeys: ['c:d', 'a:b'], orgIds: ['o1', 'o2'] };
    expect(ceilingSnapshotHash(a)).toBe(ceilingSnapshotHash(b));
    expect(ceilingSnapshotHash(a)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('ceilingSnapshotHash changes when any term changes', () => {
    const a: WispCeilingSnapshot = { version: 1, permissionKeys: ['a:b'], orgIds: ['o1'], siteIds: null, toolAllowlist: null, deniedTools: [] };
    expect(ceilingSnapshotHash({ ...a, orgIds: ['o1', 'o2'] })).not.toBe(ceilingSnapshotHash(a));
    expect(ceilingSnapshotHash({ ...a, siteIds: [] })).not.toBe(ceilingSnapshotHash(a));
    expect(ceilingSnapshotHash({ ...a, deniedTools: ['x'] })).not.toBe(ceilingSnapshotHash(a));
  });
  it('intersectSnapshotWithLive never widens any term', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['devices:read', 'tickets:write'], orgIds: ['o1', 'o2'], siteIds: null, toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['devices:read'], orgIds: ['o2', 'o3'], siteIds: ['s1'], partnerOrgAccess: 'selected', orgMemberships: [] },
    );
    expect([...out.orgIds]).toEqual(['o2']);
    expect([...out.permissionKeys]).toEqual(['devices:read']);
    expect([...out.siteIds!]).toEqual(['s1']);
  });
  it('a demoted wildcard grantor keeps only the concrete keys they still hold', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['*:*'], orgIds: ['o1'], siteIds: null, toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['devices:read', 'tickets:*'], orgIds: ['o1'], siteIds: null, partnerOrgAccess: 'all', orgMemberships: [] },
    );
    expect([...out.permissionKeys].sort()).toEqual(['devices:read', 'tickets:*']);
    expect(out.siteIds).toBeNull();
  });
  it('a live wildcard never widens a concrete snapshot', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['devices:read'], orgIds: ['o1'], siteIds: ['s1', 's2'], toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['*:*'], orgIds: ['o1'], siteIds: ['s2', 's3'], partnerOrgAccess: 'all', orgMemberships: [] },
    );
    expect([...out.permissionKeys]).toEqual(['devices:read']);
    expect([...out.siteIds!]).toEqual(['s2']);
  });
  it('crossing wildcards meet on the concrete key (devices:* ∩ *:read = devices:read)', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['devices:*'], orgIds: ['o1'], siteIds: null, toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['*:read'], orgIds: ['o1'], siteIds: null, partnerOrgAccess: 'all', orgMemberships: [] },
    );
    expect([...out.permissionKeys]).toEqual(['devices:read']);
  });
});

/**
 * One `db.select(...)` call resolving to `rows`, whatever the chain
 * (`.from().where().limit()`, `.from().innerJoin().where()`, ...).
 */
function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit']) c[m] = () => c;
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
  return c;
}
function queueSelect(rows: unknown[]) {
  shared.selectMock.mockReturnValueOnce(selectChain(rows) as never);
}

const PARTNER = 'partner-1';
const USER = 'user-1';
const livePerms = (permissions: Array<{ resource: string; action: string }>, extra: Record<string, unknown> = {}) => ({
  permissions, partnerId: PARTNER, orgId: null, roleId: 'role-1', scope: 'partner', orgAccess: 'all', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  shared.selectMock.mockReset();
  // A select nobody queued (e.g. the grantor's org memberships) finds no rows.
  shared.selectMock.mockImplementation(() => selectChain([]) as never);
  shared.wispEnabled.mockReturnValue(true);
});

describe('computeLiveHumanTerm', () => {
  it('→ grantor_suspended when users.status is disabled', async () => {
    queueSelect([{ status: 'disabled', partnerId: PARTNER }]);
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_suspended' });
    expect(shared.getUserPermissions).not.toHaveBeenCalled();
  });
  it('→ grantor_suspended when the user row is missing', async () => {
    queueSelect([]);
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_suspended' });
  });
  it('→ grantor_access_lost when getUserPermissions returns null (no partner membership)', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(null);
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_access_lost' });
    expect(shared.getUserPermissions).toHaveBeenCalledWith(USER, { partnerId: PARTNER, scope: 'partner' }, { bypassCache: true });
  });
  it('→ grantor_access_lost when ai_sessions:use is not held', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: 'devices', action: 'read' }]));
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_access_lost' });
    expect(shared.computeAccessibleOrgIds).not.toHaveBeenCalled();
  });
  it('→ grantor_access_lost when computeAccessibleOrgIds yields []', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: 'ai_sessions', action: 'use' }]));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: [], partnerOrgAccess: 'selected' });
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_access_lost' });
  });
  it('→ grantor_access_lost when the user now belongs to another partner', async () => {
    queueSelect([{ status: 'active', partnerId: 'other-partner' }]);
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_access_lost' });
  });
  it('a wildcard admin holds ai_sessions:use through *:* and gets concrete keys + reach', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: '*', action: '*' }], { allowedSiteIds: ['s1'] }));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1', 'o2'], partnerOrgAccess: 'all' });
    queueSelect([{ id: 'o1' }, { id: 'o2' }]); // non-Quick-Support filter
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({
      ok: true, permissionKeys: ['*:*'], orgIds: ['o1', 'o2'], siteIds: ['s1'], partnerOrgAccess: 'all', orgMemberships: [],
    });
    expect(shared.computeAccessibleOrgIds).toHaveBeenCalledWith('partner', PARTNER, null, USER);
  });
});

describe('resolveGrantCeiling', () => {
  const SNAPSHOT: WispCeilingSnapshot = {
    version: 1, permissionKeys: ['devices:read', 'tickets:write'], orgIds: ['o1', 'o2'], siteIds: null, toolAllowlist: ['get_device'], deniedTools: ['snapshot_denied_tool'],
  };
  const grantRow = (o: Record<string, unknown> = {}) => ({
    id: 'g1', partnerId: PARTNER, orgId: null, grantorUserId: USER, status: 'active', expiresAt: new Date(Date.now() + 86_400_000), ...o,
  });
  const revisionRow = (o: Record<string, unknown> = {}) => ({ id: 'r1', grantId: 'g1', ceilingSnapshot: SNAPSHOT, ...o });

  it('throws GrantInactiveError for status paused without computing the live term', async () => {
    queueSelect([grantRow({ status: 'paused' })]);
    queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toBeInstanceOf(GrantInactiveError);
    expect(shared.getUserPermissions).not.toHaveBeenCalled();
  });
  it('throws GrantInactiveError for a grant past expires_at even while status is active', async () => {
    queueSelect([grantRow({ expiresAt: new Date(Date.now() - 1000) })]);
    queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ status: 'expired' });
  });
  it('throws GrantInactiveError for a missing grant', async () => {
    queueSelect([]);
    queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toBeInstanceOf(GrantInactiveError);
  });
  it('refuses a revision that belongs to another grant (GrantInactiveError)', async () => {
    queueSelect([grantRow()]);
    queueSelect([revisionRow({ grantId: 'other-grant' })]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toBeInstanceOf(GrantInactiveError);
    expect(shared.getUserPermissions).not.toHaveBeenCalled();
  });
  it('refuses a malformed ceiling snapshot (fail closed)', async () => {
    queueSelect([grantRow()]);
    queueSelect([revisionRow({ ceilingSnapshot: { version: 2 } })]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toBeInstanceOf(GrantInactiveError);
  });
  it('status active but live term ok:false ⇒ throws GrantInactiveError (fail closed; the reconciler pauses the row)', async () => {
    queueSelect([grantRow()]);
    queueSelect([revisionRow()]);
    queueSelect([{ status: 'disabled', partnerId: PARTNER }]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toBeInstanceOf(GrantInactiveError);
  });
  it('intersects snapshot ∩ live and unions deniedTools with both agent deny registries', async () => {
    queueSelect([grantRow({ orgId: 'o2' })]);
    queueSelect([revisionRow()]);
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([
      { resource: 'ai_sessions', action: 'use' }, { resource: 'devices', action: 'read' },
    ]));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o2', 'o3'], partnerOrgAccess: 'selected' });
    queueSelect([{ id: 'o2' }, { id: 'o3' }]);

    const c = await resolveGrantCeiling('g1', 'r1');
    expect(c).toMatchObject({ grantId: 'g1', revisionId: 'r1', partnerId: PARTNER, grantorUserId: USER, scopeOrgId: 'o2', partnerWide: false, status: 'active' });
    expect([...c.orgIds]).toEqual(['o2']);
    expect([...c.permissionKeys]).toEqual(['devices:read']);
    expect(c.siteIds).toBeNull();
    expect([...c.toolAllowlist!]).toEqual(['get_device']);
    expect(c.deniedTools.has('snapshot_denied_tool')).toBe(true);
    for (const t of AGENT_HUMAN_ONLY_TOOLS) expect(c.deniedTools.has(t)).toBe(true);
    for (const t of AGENT_DENIED_READ_TOOLS.keys()) expect(c.deniedTools.has(t)).toBe(true);
  });

  it('clamps an org-scoped grant to its scope org even when the snapshot lists another', async () => {
    queueSelect([grantRow({ orgId: 'o1' })]);
    queueSelect([revisionRow()]); // snapshot orgIds ['o1', 'o2']
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: 'ai_sessions', action: 'use' }]));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1', 'o2'], partnerOrgAccess: 'all' });
    queueSelect([{ id: 'o1' }, { id: 'o2' }]);
    const c = await resolveGrantCeiling('g1', 'r1');
    expect([...c.orgIds]).toEqual(['o1']);
    expect(c.partnerWide).toBe(false);
  });

  it('an empty live ∩ snapshot org set fails closed (grantor_access_lost; the reconciler pauses)', async () => {
    queueSelect([grantRow()]);
    queueSelect([revisionRow()]); // snapshot orgIds ['o1', 'o2']
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: 'ai_sessions', action: 'use' }]));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o9'], partnerOrgAccess: 'selected' });
    queueSelect([{ id: 'o9' }]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'paused', status: 'paused' });
  });

  it('partnerWide needs the PINNED partner-wide flag AND the grantor\'s live org_access all (widening needs a refresh)', async () => {
    const cases = [
      { pinned: true, access: 'all', expected: true },
      { pinned: true, access: 'selected', expected: false },
      // Widened to 'all' after the pin: still false until a refresh re-pins it.
      { pinned: false, access: 'all', expected: false },
    ] as const;
    for (const { pinned, access, expected } of cases) {
      queueSelect([grantRow()]);
      queueSelect([revisionRow({ ceilingSnapshot: { ...SNAPSHOT, partnerWide: pinned } })]);
      queueSelect([{ status: 'active', partnerId: PARTNER }]);
      shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: 'ai_sessions', action: 'use' }]));
      shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1'], partnerOrgAccess: access });
      queueSelect([{ id: 'o1' }]);
      const c = await resolveGrantCeiling('g1', 'r1');
      expect(c.partnerWide, `${pinned}/${access}`).toBe(expected);
    }
  });

  it('the partner\'s hidden Quick Support org never counts: a grantor left with only it has lost access', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms([{ resource: 'ai_sessions', action: 'use' }]));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['qs-org'], partnerOrgAccess: 'selected' });
    queueSelect([]); // the filter dropped the quick_support org
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_access_lost' });
  });

  it('refuses every grant while Wisp is disabled (kind paused, no DB read)', async () => {
    shared.wispEnabled.mockReturnValueOnce(false);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'paused' });
    expect(shared.selectMock).not.toHaveBeenCalled();
  });

  it('classifies the failure: missing/revoked/expired are ended, a foreign revision or malformed snapshot is corrupt, paused is paused', async () => {
    queueSelect([]); queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'ended' });
    queueSelect([grantRow({ status: 'revoked' })]); queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'ended' });
    queueSelect([grantRow({ expiresAt: new Date(Date.now() - 1000) })]); queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'ended' });
    queueSelect([grantRow()]); queueSelect([revisionRow({ grantId: 'other' })]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'corrupt' });
    queueSelect([grantRow()]); queueSelect([revisionRow({ ceilingSnapshot: { version: 9 } })]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'corrupt' });
    queueSelect([grantRow({ status: 'paused' })]); queueSelect([revisionRow()]);
    await expect(resolveGrantCeiling('g1', 'r1')).rejects.toMatchObject({ kind: 'paused' });
  });
});

// ---------------------------------------------------------------------------
// Org-axis precedence: the grantor's organization_users rows narrow the
// ceiling per org (permissions.ts getUserPermissions resolves org first).
// ---------------------------------------------------------------------------

describe('assertWithinCeiling — per-org terms (organization_users precedence)', () => {
  const twoOrgs = (o: Partial<GrantCeiling> = {}) => ceiling({
    orgIds: new Set(['org-a', 'org-b']),
    permissionKeys: new Set(['devices:read', 'devices:execute']),
    orgTerms: new Map([['org-a', { permissionKeys: new Set(['devices:read']), siteIds: null }]]),
    ...o,
  });

  it('a permission the ceiling holds is refused in an org whose term lacks it and allowed in an org without a term', () => {
    const c = twoOrgs();
    expect(() => assertWithinCeiling(c, { permission: 'devices:execute', orgId: 'org-a' })).toThrow(expect.objectContaining({ code: 'permission' }));
    expect(() => assertWithinCeiling(c, { permission: 'devices:execute', orgId: 'org-b' })).not.toThrow();
    expect(() => assertWithinCeiling(c, { permission: 'devices:read', orgId: 'org-a' })).not.toThrow();
  });

  it('assertToolCallWithinCeiling applies the org term to every required permission', () => {
    const c = twoOrgs();
    expect(() => assertToolCallWithinCeiling(c, { toolName: 'get_device', orgId: 'org-a', siteId: null }, [{ resource: 'devices', action: 'execute' }]))
      .toThrow(expect.objectContaining({ code: 'permission' }));
    expect(() => assertToolCallWithinCeiling(c, { toolName: 'get_device', orgId: 'org-b', siteId: null }, [{ resource: 'devices', action: 'execute' }]))
      .not.toThrow();
  });

  it('an org term\'s site allowlist binds checks in that org only; an unknown site never widens it', () => {
    const c = twoOrgs({ orgTerms: new Map([['org-a', { permissionKeys: new Set(['devices:read', 'devices:execute']), siteIds: new Set(['s1']) }]]) });
    expect(() => assertWithinCeiling(c, { orgId: 'org-a', siteId: 's2' })).toThrow(expect.objectContaining({ code: 'site' }));
    expect(() => assertWithinCeiling(c, { orgId: 'org-a', siteId: null })).toThrow(expect.objectContaining({ code: 'site' }));
    expect(() => assertWithinCeiling(c, { orgId: 'org-a', siteId: 's1' })).not.toThrow();
    expect(() => assertWithinCeiling(c, { orgId: 'org-b', siteId: 's2' })).not.toThrow();
  });

  it('an org term never relaxes the ceiling-wide site allowlist', () => {
    const c = twoOrgs({
      siteIds: new Set(['s1']),
      orgTerms: new Map([['org-a', { permissionKeys: new Set(['devices:read']), siteIds: new Set(['s1', 's2']) }]]),
    });
    expect(() => assertWithinCeiling(c, { orgId: 'org-a', siteId: 's2' })).toThrow(expect.objectContaining({ code: 'site' }));
  });

  it('an unbound or partner-level permission must hold in EVERY org term (narrowest reading)', () => {
    const c = twoOrgs();
    for (const orgId of [undefined, null] as const) {
      expect(() => assertWithinCeiling(c, { permission: 'devices:execute', orgId }), String(orgId)).toThrow(expect.objectContaining({ code: 'permission' }));
      expect(() => assertWithinCeiling(c, { permission: 'devices:read', orgId }), String(orgId)).not.toThrow();
    }
  });

  it('an org term wider than the ceiling does not widen it', () => {
    const c = twoOrgs({ orgTerms: new Map([['org-a', { permissionKeys: new Set(['*:*']), siteIds: null }]]) });
    expect(() => assertWithinCeiling(c, { permission: 'scripts:execute', orgId: 'org-a' })).toThrow(expect.objectContaining({ code: 'permission' }));
    expect(() => assertWithinCeiling(c, { permission: 'devices:execute', orgId: 'org-a' })).not.toThrow();
  });
});

describe('computeLiveHumanTerm / resolveGrantCeiling — org memberships', () => {
  const SNAPSHOT: WispCeilingSnapshot = {
    version: 1, permissionKeys: ['devices:read', 'devices:execute', 'tickets:write'], orgIds: ['o1', 'o2', 'o3'],
    siteIds: null, toolAllowlist: null, deniedTools: [], partnerWide: true,
  };
  const grantRow = { id: 'g1', partnerId: PARTNER, orgId: null, grantorUserId: USER, status: 'active', expiresAt: new Date(Date.now() + 86_400_000) };
  const BROAD = [
    { resource: 'ai_sessions', action: 'use' }, { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'execute' }, { resource: 'tickets', action: 'write' },
  ];

  /** grant, revision, user, [getUserPermissions], [reach], org filter, memberships, role permissions. */
  function queueResolve(memberships: unknown[], rolePerms: unknown[], orgAccess: 'all' | 'selected' = 'all') {
    queueSelect([grantRow]);
    queueSelect([{ id: 'r1', grantId: 'g1', ceilingSnapshot: SNAPSHOT }]);
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms(BROAD));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1', 'o2', 'o3'], partnerOrgAccess: orgAccess });
    queueSelect([{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }]);
    queueSelect(memberships);
    if (memberships.length > 0) queueSelect(rolePerms);
  }

  it('computeLiveHumanTerm reports each in-reach org membership with its role keys and sites', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms(BROAD));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1', 'o2'], partnerOrgAccess: 'selected' });
    queueSelect([{ id: 'o1' }, { id: 'o2' }]);
    queueSelect([{ orgId: 'o1', roleId: 'narrow', siteIds: ['s1'] }]);
    queueSelect([{ roleId: 'narrow', resource: 'ai_sessions', action: 'use' }, { roleId: 'narrow', resource: 'devices', action: 'read' }]);
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({
      ok: true, permissionKeys: ['ai_sessions:use', 'devices:execute', 'devices:read', 'tickets:write'], orgIds: ['o1', 'o2'], siteIds: null,
      partnerOrgAccess: 'selected',
      orgMemberships: [{ orgId: 'o1', permissionKeys: ['ai_sessions:use', 'devices:read'], siteIds: ['s1'] }],
    });
  });

  it('an org whose membership role lacks ai_sessions:use leaves orgIds; none left → grantor_access_lost', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms(BROAD));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1'], partnerOrgAccess: 'selected' });
    queueSelect([{ id: 'o1' }]);
    queueSelect([{ orgId: 'o1', roleId: 'readonly', siteIds: null }]);
    queueSelect([{ roleId: 'readonly', resource: 'devices', action: 'read' }]);
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({ ok: false, reason: 'grantor_access_lost' });
  });

  it('a membership with a malformed (non-array) site_ids fails closed to no sites', async () => {
    queueSelect([{ status: 'active', partnerId: PARTNER }]);
    shared.getUserPermissions.mockResolvedValueOnce(livePerms(BROAD));
    shared.computeAccessibleOrgIds.mockResolvedValueOnce({ orgIds: ['o1'], partnerOrgAccess: 'selected' });
    queueSelect([{ id: 'o1' }]);
    queueSelect([{ orgId: 'o1', roleId: 'r', siteIds: 'garbage' }]);
    queueSelect([{ roleId: 'r', resource: '*', action: '*' }]);
    const live = await computeLiveHumanTerm(USER, PARTNER);
    expect(live.ok && live.orgMemberships).toEqual([{ orgId: 'o1', permissionKeys: ['*:*'], siteIds: [] }]);
  });

  it('resolveGrantCeiling builds a per-org term (role keys ∩ ceiling, sites) and drops an org without ai_sessions:use', async () => {
    queueResolve(
      [{ orgId: 'o1', roleId: 'narrow', siteIds: ['s1'] }, { orgId: 'o2', roleId: 'noai', siteIds: null }],
      [
        { roleId: 'narrow', resource: 'ai_sessions', action: 'use' }, { roleId: 'narrow', resource: 'devices', action: 'read' },
        { roleId: 'noai', resource: 'devices', action: '*' },
      ],
    );
    const c = await resolveGrantCeiling('g1', 'r1');
    expect([...c.orgIds].sort()).toEqual(['o1', 'o3']);
    expect([...c.orgTerms.keys()]).toEqual(['o1']);
    expect([...c.orgTerms.get('o1')!.permissionKeys]).toEqual(['devices:read']);
    expect([...c.orgTerms.get('o1')!.siteIds!]).toEqual(['s1']);
    // The org the human cannot use AI in is outside the ceiling ...
    expect(() => assertWithinCeiling(c, { orgId: 'o2' })).toThrow(expect.objectContaining({ code: 'org' }));
    // ... devices:execute is refused in o1, allowed in o3 (no membership: partner role governs).
    expect(() => assertWithinCeiling(c, { orgId: 'o1', siteId: 's1', permission: 'devices:execute' })).toThrow(expect.objectContaining({ code: 'permission' }));
    expect(() => assertWithinCeiling(c, { orgId: 'o3', permission: 'devices:execute' })).not.toThrow();
    // A dropped org means the grantor no longer reaches the whole partner: no partner-level subjects.
    expect(c.partnerWide).toBe(false);
  });

  it('an org role WIDER than the partner role does not widen the ceiling in that org', async () => {
    queueResolve([{ orgId: 'o1', roleId: 'admin', siteIds: null }], [{ roleId: 'admin', resource: '*', action: '*' }]);
    const c = await resolveGrantCeiling('g1', 'r1');
    expect([...c.orgTerms.get('o1')!.permissionKeys].sort()).toEqual(['devices:execute', 'devices:read', 'tickets:write']);
    expect(() => assertWithinCeiling(c, { orgId: 'o1', permission: 'scripts:execute' })).toThrow(expect.objectContaining({ code: 'permission' }));
    expect(c.orgTerms.get('o1')!.siteIds).toBeNull();
    expect(c.partnerWide).toBe(true);
  });

  it('two membership rows for one org intersect (fail closed, never the wider row)', async () => {
    queueResolve(
      [{ orgId: 'o1', roleId: 'wide', siteIds: null }, { orgId: 'o1', roleId: 'narrow', siteIds: ['s1'] }],
      [
        { roleId: 'wide', resource: '*', action: '*' },
        { roleId: 'narrow', resource: 'ai_sessions', action: 'use' }, { roleId: 'narrow', resource: 'devices', action: 'read' },
      ],
    );
    const c = await resolveGrantCeiling('g1', 'r1');
    expect([...c.orgTerms.get('o1')!.permissionKeys]).toEqual(['devices:read']);
    expect([...c.orgTerms.get('o1')!.siteIds!]).toEqual(['s1']);
  });
});
