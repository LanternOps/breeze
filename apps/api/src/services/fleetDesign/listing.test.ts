import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn();
const where = vi.fn(() => ({ orderBy: () => ({ limit }) }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where }) }) }) },
}));
vi.mock('../../db/schema', () => ({
  reports: { type: 'type', orgId: 'reports.orgId', id: 'reports.id' },
  reportRuns: { status: 'status', id: 'run.id', reportId: 'run.reportId', result: 'result', completedAt: 'completedAt' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  desc: (x: unknown) => x,
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));
vi.mock('../aiAgents/fleetDesignReport', () => ({ FLEET_DESIGN_REPORT_TYPE: 'ai_fleet_design' }));

import { listFleetDesigns } from './listing';

const auth = (over: Record<string, unknown> = {}) =>
  ({ canAccessOrg: () => true, orgCondition: () => ({ org: 'cond' }), ...over }) as never;

describe('listFleetDesigns org gate (scan-allowlisted shape, #6780)', () => {
  beforeEach(() => { limit.mockReset(); where.mockClear(); });

  it('returns [] without querying when the caller cannot access the requested org', async () => {
    const rows = await listFleetDesigns(auth({ canAccessOrg: () => false }), 'other-org');
    expect(rows).toEqual([]);
    expect(where).not.toHaveBeenCalled();
  });

  it("applies the caller's orgCondition to the reports.orgId axis", async () => {
    limit.mockResolvedValue([]);
    const orgCondition = vi.fn(() => ({ org: 'cond' }));
    await listFleetDesigns(auth({ orgCondition }), undefined);
    expect(orgCondition).toHaveBeenCalledWith('reports.orgId');
    expect(JSON.stringify(where.mock.calls[0])).toContain('"org":"cond"');
  });
});
