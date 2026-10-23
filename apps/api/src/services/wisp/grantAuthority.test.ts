import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissions: vi.fn(),
  computeAccessibleOrgIds: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: shared.selectMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../permissions', () => ({
  getUserPermissions: shared.getUserPermissions,
}));

vi.mock('../../middleware/auth', () => ({
  computeAccessibleOrgIds: shared.computeAccessibleOrgIds,
}));

import {
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
  grantId: 'g', revisionId: 'r', partnerId: 'p', grantorUserId: 'u1', scopeOrgId: null, status: 'active',
  orgIds: new Set(['org-a']), siteIds: null, permissionKeys: new Set(['devices:read', 'tickets:write']),
  toolAllowlist: null, deniedTools: new Set([...AGENT_HUMAN_ONLY_TOOLS, ...AGENT_DENIED_READ_TOOLS.keys()]), ...o,
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
    expect(() => assertWithinCeiling(ceiling({ scopeOrgId: 'org-a' }), { orgId: null })).toThrow(expect.objectContaining({ code: 'org' }));
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
      { ok: true, permissionKeys: ['devices:read'], orgIds: ['o2', 'o3'], siteIds: ['s1'], partnerOrgAccess: 'selected' },
    );
    expect([...out.orgIds]).toEqual(['o2']);
    expect([...out.permissionKeys]).toEqual(['devices:read']);
    expect([...out.siteIds!]).toEqual(['s1']);
  });
  it('a demoted wildcard grantor keeps only the concrete keys they still hold', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['*:*'], orgIds: ['o1'], siteIds: null, toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['devices:read', 'tickets:*'], orgIds: ['o1'], siteIds: null, partnerOrgAccess: 'all' },
    );
    expect([...out.permissionKeys].sort()).toEqual(['devices:read', 'tickets:*']);
    expect(out.siteIds).toBeNull();
  });
  it('a live wildcard never widens a concrete snapshot', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['devices:read'], orgIds: ['o1'], siteIds: ['s1', 's2'], toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['*:*'], orgIds: ['o1'], siteIds: ['s2', 's3'], partnerOrgAccess: 'all' },
    );
    expect([...out.permissionKeys]).toEqual(['devices:read']);
    expect([...out.siteIds!]).toEqual(['s2']);
  });
  it('crossing wildcards meet on the concrete key (devices:* ∩ *:read = devices:read)', () => {
    const out = intersectSnapshotWithLive(
      { version: 1, permissionKeys: ['devices:*'], orgIds: ['o1'], siteIds: null, toolAllowlist: null, deniedTools: [] },
      { ok: true, permissionKeys: ['*:read'], orgIds: ['o1'], siteIds: null, partnerOrgAccess: 'all' },
    );
    expect([...out.permissionKeys]).toEqual(['devices:read']);
  });
});

/** One `db.select(...).from(...).where(...).limit(1)` call resolving to `rows`. */
function queueSelect(rows: unknown[]) {
  shared.selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  } as never);
}

const PARTNER = 'partner-1';
const USER = 'user-1';
const livePerms = (permissions: Array<{ resource: string; action: string }>, extra: Record<string, unknown> = {}) => ({
  permissions, partnerId: PARTNER, orgId: null, roleId: 'role-1', scope: 'partner', orgAccess: 'all', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  shared.selectMock.mockReset();
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
    expect(await computeLiveHumanTerm(USER, PARTNER)).toEqual({
      ok: true, permissionKeys: ['*:*'], orgIds: ['o1', 'o2'], siteIds: ['s1'], partnerOrgAccess: 'all',
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

    const c = await resolveGrantCeiling('g1', 'r1');
    expect(c).toMatchObject({ grantId: 'g1', revisionId: 'r1', partnerId: PARTNER, grantorUserId: USER, scopeOrgId: 'o2', status: 'active' });
    expect([...c.orgIds]).toEqual(['o2']);
    expect([...c.permissionKeys]).toEqual(['devices:read']);
    expect(c.siteIds).toBeNull();
    expect([...c.toolAllowlist!]).toEqual(['get_device']);
    expect(c.deniedTools.has('snapshot_denied_tool')).toBe(true);
    for (const t of AGENT_HUMAN_ONLY_TOOLS) expect(c.deniedTools.has(t)).toBe(true);
    for (const t of AGENT_DENIED_READ_TOOLS.keys()) expect(c.deniedTools.has(t)).toBe(true);
  });
});
