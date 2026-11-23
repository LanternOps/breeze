import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queue, selects } = vi.hoisted(() => ({ queue: [] as unknown[][], selects: [] as string[] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn((table: unknown) => {
        selects.push(String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]));
        return chain;
      });
      chain.where = vi.fn(() => Promise.resolve(queue.shift() ?? []));
      return chain;
    }),
  },
}));

// The site/device ceiling is the set-based reader GET /:id/assignments used per
// row; mocked here so these cases pin the wiring (the real rules have their own
// tests and the integration suite runs both on Postgres).
const { ceilingMock } = vi.hoisted(() => ({
  ceilingMock: vi.fn(async (_auth: unknown, targets: Array<{ level: string; targetId: string }>) =>
    new Map(targets.map((t) => [`${t.level}:${t.targetId}`, true]))),
}));
vi.mock('./configurationPolicy', () => ({
  authorizeAssignmentTargets: ceilingMock,
  assignmentTargetKey: (level: string, targetId: string) => `${level}:${targetId}`,
}));

import type { AuthContext } from '../middleware/auth';
import { filterLegibleAssignments } from './configPolicyLegibleAssignments';

const PARTNER = 'partner-1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';

const rows = [
  { id: 'r-partner', level: 'partner', targetId: PARTNER },
  { id: 'r-org-a', level: 'organization', targetId: ORG_A },
  { id: 'r-org-b', level: 'organization', targetId: ORG_B },
  { id: 'r-site-a', level: 'site', targetId: 'site-a' },
  { id: 'r-site-b', level: 'site', targetId: 'site-b' },
  { id: 'r-dev-a', level: 'device', targetId: 'dev-a' },
  { id: 'r-grp-org-a', level: 'device_group', targetId: 'grp-a' },
  { id: 'r-grp-partner', level: 'device_group', targetId: 'grp-p' },
  { id: 'r-grp-org-b', level: 'device_group', targetId: 'grp-b' },
] as const;

const auth = (overrides: Partial<AuthContext>): AuthContext => ({
  scope: 'organization',
  partnerId: PARTNER,
  accessibleOrgIds: [ORG_A],
  canAccessOrg: (id: string) => id === ORG_A,
  ...overrides,
}) as AuthContext;

beforeEach(() => {
  queue.length = 0;
  selects.length = 0;
  ceilingMock.mockClear();
});

describe('filterLegibleAssignments', () => {
  it('returns every row unchanged for an org-owned policy, a full-access partner and system, with no read', async () => {
    const all = [...rows];
    expect(await filterLegibleAssignments(auth({}), { orgId: ORG_A, partnerId: null }, all)).toEqual(all);
    expect(await filterLegibleAssignments(auth({ scope: 'partner', partnerOrgAccess: 'all' }), { orgId: null, partnerId: PARTNER }, all)).toEqual(all);
    expect(await filterLegibleAssignments(auth({ scope: 'system', partnerId: null, accessibleOrgIds: null }), { orgId: null, partnerId: PARTNER }, all)).toEqual(all);
    expect(selects).toEqual([]);
  });

  it("keeps only rows whose target is in the caller's orgs on an MSP-managed policy, for an org or limited caller", async () => {
    // sites, devices, device groups, in that order
    queue.push(
      [{ id: 'site-a', orgId: ORG_A }, { id: 'site-b', orgId: ORG_B }],
      [{ id: 'dev-a', orgId: ORG_A }],
      [{ id: 'grp-a', orgId: ORG_A, partnerId: null }, { id: 'grp-p', orgId: null, partnerId: PARTNER }, { id: 'grp-b', orgId: ORG_B, partnerId: null }],
    );
    const kept = await filterLegibleAssignments(auth({}), { orgId: null, partnerId: PARTNER }, [...rows]);
    expect(kept.map((r) => r.id)).toEqual(['r-partner', 'r-org-a', 'r-site-a', 'r-dev-a', 'r-grp-org-a', 'r-grp-partner']);
  });

  it('drops a partner-level row of another partner and a partner-owned group of another partner', async () => {
    queue.push([{ id: 'grp-x', orgId: null, partnerId: 'partner-2' }]);
    const kept = await filterLegibleAssignments(
      auth({ scope: 'partner', partnerOrgAccess: 'selected' }),
      { orgId: null, partnerId: PARTNER },
      [{ id: 'p2', level: 'partner', targetId: 'partner-2' }, { id: 'g', level: 'device_group', targetId: 'grp-x' }],
    );
    expect(kept).toEqual([]);
  });

  it('drops a target that does not resolve (another org under RLS, or deleted)', async () => {
    queue.push([]);
    const kept = await filterLegibleAssignments(auth({}), { orgId: null, partnerId: PARTNER }, [{ id: 's', level: 'site', targetId: 'site-gone' }]);
    expect(kept).toEqual([]);
  });

  describe('the site and device ceiling (Strix, PR #12552)', () => {
    const refuse = (...keys: string[]) => ceilingMock.mockImplementationOnce(async (_a, targets) =>
      new Map(targets.map((t) => [`${t.level}:${t.targetId}`, !keys.includes(`${t.level}:${t.targetId}`)])));

    it('drops the rows a site-restricted caller may not reach, on an org-owned policy too', async () => {
      const siteAuth = auth({ allowedSiteIds: ['site-a'], canAccessSite: (id: string | null | undefined) => id === 'site-a' });
      refuse('organization:org-a', 'site:site-a2');
      const orgRows = [
        { id: 'o', level: 'organization', targetId: ORG_A },
        { id: 's1', level: 'site', targetId: 'site-a' },
        { id: 's2', level: 'site', targetId: 'site-a2' },
      ];
      const kept = await filterLegibleAssignments(siteAuth, { orgId: ORG_A, partnerId: null }, orgRows);
      expect(kept.map((r) => r.id)).toEqual(['s1']);
      expect(ceilingMock).toHaveBeenCalledWith(siteAuth, [
        { level: 'organization', targetId: ORG_A },
        { level: 'site', targetId: 'site-a' },
        { level: 'site', targetId: 'site-a2' },
      ]);
    });

    it('applies the ceiling after the organization filter on an MSP-managed policy', async () => {
      const pinned = auth({ allowedDeviceIds: ['dev-a'] });
      queue.push([{ id: 'dev-a', orgId: ORG_A }, { id: 'dev-a2', orgId: ORG_A }, { id: 'dev-b', orgId: ORG_B }]);
      refuse('device:dev-a2', 'partner:partner-1');
      const kept = await filterLegibleAssignments(pinned, { orgId: null, partnerId: PARTNER }, [
        { id: 'p', level: 'partner', targetId: PARTNER },
        { id: 'd1', level: 'device', targetId: 'dev-a' },
        { id: 'd2', level: 'device', targetId: 'dev-a2' },
        { id: 'd3', level: 'device', targetId: 'dev-b' },
      ]);
      expect(kept.map((r) => r.id)).toEqual(['d1']);
      // Another customer's device never reaches the ceiling read.
      expect(ceilingMock.mock.calls[0]![1]).not.toContainEqual({ level: 'device', targetId: 'dev-b' });
    });

    it('asks nothing of the ceiling when no row is left', async () => {
      expect(await filterLegibleAssignments(auth({}), { orgId: ORG_A, partnerId: null }, [])).toEqual([]);
      expect(ceilingMock).not.toHaveBeenCalled();
    });
  });
});
