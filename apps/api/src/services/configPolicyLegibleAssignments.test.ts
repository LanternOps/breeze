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
});
