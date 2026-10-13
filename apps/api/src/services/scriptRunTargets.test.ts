import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('./deploymentTargetResolver', () => ({
  resolveDeploymentTargetsWithWarnings: vi.fn(),
}));

vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: vi.fn(),
}));

import { db } from '../db';
import { resolveDeploymentTargetsWithWarnings } from './deploymentTargetResolver';
import { resolveExecutionSafeGroupIds } from './executionTargetGating';
import { MAX_SCRIPT_RUN_TARGETS, resolveScriptRunTargets } from './scriptRunTargets';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const O2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const authAll = { user: { id: 'user-1' }, orgId: null, canAccessOrg: () => true };
const authOnly = (...orgs: string[]) => ({ user: { id: 'user-1' }, orgId: null, canAccessOrg: (o: string) => orgs.includes(o) });

type GroupRow = { id: string; orgId: string; siteId: string | null };

/**
 * Every DB read in the resolver is `db.select(...).from(...).where(...)`; queue
 * one row set per read, in call order: groups, memberships, then (only for a
 * site-restricted caller) the in-site device ids.
 */
function queueSelects(...results: unknown[][]) {
  const mock = vi.mocked(db.select);
  for (const rows of results) {
    mock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    } as never);
  }
}

function mockRefused(refusedIds: string[] = []) {
  vi.mocked(resolveExecutionSafeGroupIds).mockImplementation(async (ids: string[]) => ({
    allowedGroupIds: ids.filter((g) => !refusedIds.includes(g)),
    refusedGroups: ids.filter((g) => refusedIds.includes(g)).map((g) => ({ id: g, refusedFields: ['hostname'] })),
  }));
}

function mockResolvePerOrg(byOrg: Record<string, { deviceIds: string[]; warnings?: string[] }>) {
  vi.mocked(resolveDeploymentTargetsWithWarnings).mockImplementation(async ({ orgId }) => ({
    deviceIds: byOrg[orgId]?.deviceIds ?? [],
    warnings: byOrg[orgId]?.warnings ?? [],
  }));
}

const memberships = (groupId: string, deviceIds: string[]) => deviceIds.map((deviceId) => ({ groupId, deviceId }));

const target = (...groupIds: string[]) => ({ type: 'groups' as const, groupIds });

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(resolveDeploymentTargetsWithWarnings).mockReset();
  vi.mocked(resolveExecutionSafeGroupIds).mockReset();
  mockRefused();
});

describe('resolveScriptRunTargets', () => {
  it('resolves a group to its members and reports per-group counts', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: null }] satisfies GroupRow[], memberships(G1, [id(1), id(2)]));
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1), id(2)] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1) });

    expect(r).toEqual({
      ok: true,
      deviceIds: [id(1), id(2)],
      warnings: [],
      resolvedGroups: [{ id: G1, orgId: O1, memberCount: 2, refused: false }],
    });
    expect(resolveDeploymentTargetsWithWarnings).toHaveBeenCalledWith({
      orgId: O1,
      targetConfig: { type: 'groups', groupIds: [G1] },
    });
  });

  it('returns TOO_MANY_TARGETS naming the count and per-group counts when over the cap', async () => {
    const many = Array.from({ length: MAX_SCRIPT_RUN_TARGETS + 1 }, (_, i) => id(i));
    queueSelects([{ id: G1, orgId: O1, siteId: null }], memberships(G1, many));
    mockResolvePerOrg({ [O1]: { deviceIds: many } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1) });

    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: 'TOO_MANY_TARGETS',
      count: 501,
      perGroupCounts: [{ id: G1, memberCount: 501 }],
    });
    expect(MAX_SCRIPT_RUN_TARGETS).toBe(500);
  });

  it('names missing group ids instead of shrinking the run', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: null }]); // G2 absent (deleted, or hidden by RLS)

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1, G2) });

    expect(r).toMatchObject({ ok: false, status: 404, code: 'GROUP_NOT_FOUND', groupIds: [G2] });
    expect(resolveDeploymentTargetsWithWarnings).not.toHaveBeenCalled();
  });

  it('treats an inaccessible org exactly like a missing group (no existence leak)', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: null }, { id: G2, orgId: O2, siteId: null }]);

    const inaccessible = await resolveScriptRunTargets({ auth: authOnly(O1), permissions: undefined, target: target(G1, G2) });
    queueSelects([{ id: G1, orgId: O1, siteId: null }]);
    const missing = await resolveScriptRunTargets({ auth: authOnly(O1), permissions: undefined, target: target(G1, G2) });

    expect(inaccessible).toEqual(missing);
    expect(inaccessible).toMatchObject({ code: 'GROUP_NOT_FOUND', groupIds: [G2] });
  });

  it('rejects a group outside a site-restricted caller\'s allowlist, and a site-less group, as not found', async () => {
    queueSelects([
      { id: G1, orgId: O1, siteId: S1 },
      { id: G2, orgId: O1, siteId: S2 },
      { id: G3, orgId: O1, siteId: null },
    ]);

    const r = await resolveScriptRunTargets({
      auth: authAll,
      permissions: { allowedSiteIds: [S1] } as never,
      target: target(G1, G2, G3),
    });

    expect(r).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND', groupIds: [G2, G3] });
  });

  it('returns NO_TARGETS for a valid but empty group', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: null }], []);
    mockResolvePerOrg({ [O1]: { deviceIds: [] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1) });

    expect(r).toMatchObject({ ok: false, status: 400, code: 'NO_TARGETS', count: 0 });
  });

  it('dedupes a device that is in two groups', async () => {
    queueSelects(
      [{ id: G1, orgId: O1, siteId: null }, { id: G2, orgId: O1, siteId: null }],
      [...memberships(G1, [id(1), id(2)]), ...memberships(G2, [id(1)])],
    );
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1), id(2), id(1)] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1, G2) });

    expect(r.ok && r.deviceIds).toEqual([id(1), id(2)]);
    expect(r.ok && r.resolvedGroups.map((g) => g.memberCount)).toEqual([2, 1]);
  });

  it('dedupes repeated group ids in the request', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: null }], memberships(G1, [id(1)]));
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1)] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1, G1) });

    expect(r.ok && r.resolvedGroups).toHaveLength(1);
  });

  it('keeps allowed groups and surfaces the refusal of an execution-refused group', async () => {
    queueSelects(
      [{ id: G1, orgId: O1, siteId: null }, { id: G2, orgId: O1, siteId: null }],
      memberships(G1, [id(1)]),
    );
    mockRefused([G2]);
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1)], warnings: [`Device group ${G2} was excluded`] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1, G2) });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deviceIds).toEqual([id(1)]);
    expect(r.warnings).toEqual([`Device group ${G2} was excluded`]);
    expect(r.resolvedGroups).toEqual([
      { id: G1, orgId: O1, memberCount: 1, refused: false },
      { id: G2, orgId: O1, memberCount: 0, refused: true },
    ]);
  });

  it('fails NO_TARGETS with the refusal warnings when every requested group is refused', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: null }]);
    mockRefused([G1]);
    mockResolvePerOrg({ [O1]: { deviceIds: [], warnings: ['refused G1'] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1) });

    expect(r).toMatchObject({ ok: false, code: 'NO_TARGETS', warnings: ['refused G1'] });
    expect(r.ok === false && r.error).toMatch(/refused/i);
  });

  it('resolves each org separately so the per-org device predicate always applies', async () => {
    queueSelects(
      [{ id: G1, orgId: O1, siteId: null }, { id: G2, orgId: O2, siteId: null }],
      [...memberships(G1, [id(1)]), ...memberships(G2, [id(2)])],
    );
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1)] }, [O2]: { deviceIds: [id(2)] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1, G2) });

    expect(resolveDeploymentTargetsWithWarnings).toHaveBeenCalledTimes(2);
    expect(resolveDeploymentTargetsWithWarnings).toHaveBeenCalledWith({ orgId: O1, targetConfig: { type: 'groups', groupIds: [G1] } });
    expect(resolveDeploymentTargetsWithWarnings).toHaveBeenCalledWith({ orgId: O2, targetConfig: { type: 'groups', groupIds: [G2] } });
    expect(r.ok && r.deviceIds).toEqual([id(1), id(2)]);
  });

  it('never counts a membership row the per-org resolver did not return', async () => {
    // A membership row naming a device the org-scoped resolver dropped must not
    // inflate the member count shown to the caller.
    queueSelects([{ id: G1, orgId: O1, siteId: null }], memberships(G1, [id(1), id(9)]));
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1)] } });

    const r = await resolveScriptRunTargets({ auth: authAll, permissions: undefined, target: target(G1) });

    expect(r.ok && r.resolvedGroups[0]?.memberCount).toBe(1);
  });

  it('applies the site allowlist to the resolved set and warns about what it dropped', async () => {
    queueSelects(
      [{ id: G1, orgId: O1, siteId: S1 }],
      memberships(G1, [id(1), id(2)]),
      [{ id: id(1) }],
    );
    mockResolvePerOrg({ [O1]: { deviceIds: [id(1), id(2)] } });

    const r = await resolveScriptRunTargets({
      auth: authAll,
      permissions: { allowedSiteIds: [S1] } as never,
      target: target(G1),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deviceIds).toEqual([id(1)]);
    expect(r.resolvedGroups[0]?.memberCount).toBe(1);
    expect(r.warnings.some((w) => /1 device/.test(w) && /site/.test(w))).toBe(true);
  });

  it('treats an empty site allowlist as access to no group', async () => {
    queueSelects([{ id: G1, orgId: O1, siteId: S1 }]);

    const r = await resolveScriptRunTargets({
      auth: authAll,
      permissions: { allowedSiteIds: [] } as never,
      target: target(G1),
    });

    expect(r).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND', groupIds: [G1] });
  });
});
