import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import {
  DR_READ_CANDIDATE_CHUNK_SIZE,
  DR_READ_MAX_CANDIDATE_PAGES,
  collectReadableDrRows,
  drReadSiteCeiling,
  filterReadableDrExecutions,
  filterReadableDrPlans,
} from './drReadAuthorization';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

/** Thenable resolving to `rows`, tolerant of any query-builder chain shape. */
function chain(rows: unknown[]): any {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'limit', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy']) {
    p[m] = () => p;
  }
  return p;
}

function seqSelect(results: Array<unknown[]>) {
  let call = 0;
  mockDb.select.mockImplementation(() => chain(results[call++] ?? []));
}

function makeAuth(allowedSiteIds?: string[], kind = 'user_session'): AuthContext {
  return {
    principal: { kind },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: () => true,
  } as unknown as AuthContext;
}

const RESTRICTED = () => makeAuth(['site-A']);

/** Minimal well-formed execution results document naming exactly `deviceIds`. */
function resultsDoc(deviceIds: string[], extra: Record<string, unknown> = {}) {
  return {
    plannedGroups: [{ id: 'g1', deviceCount: deviceIds.length }],
    groupResults: [{ groupId: 'g1', devices: deviceIds.map((id) => ({ id, status: 'completed' })) }],
    queuedCommands: [],
    failedDispatches: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drReadSiteCeiling', () => {
  it('is unrestricted for a system principal', () => {
    expect(drReadSiteCeiling(makeAuth(['site-A'], 'system'))).toBeNull();
  });

  it('is unrestricted for a site-restricted principal holding no site grant', () => {
    expect(drReadSiteCeiling(makeAuth(undefined))).toBeNull();
  });

  it('denies an unrecognised principal kind outright', () => {
    // Deliberately stricter than routes/dr.ts `siteRestriction`, which maps the
    // same kind to "unrestricted" because it sits behind requirePermission.
    // This boundary is also reached by AI/MCP execution, where nothing does.
    expect(drReadSiteCeiling(makeAuth(undefined, 'unknown'))).toEqual([]);
    expect(drReadSiteCeiling(makeAuth(['site-A'], 'agent'))).toEqual([]);
  });

  it('prefers an explicit override over the token grant', () => {
    expect(drReadSiteCeiling(makeAuth(['site-A']), ['site-Z'])).toEqual(['site-Z']);
  });
});

describe('collectReadableDrRows — bounded candidate scan', () => {
  it('stops at the page cap when every candidate is hidden', async () => {
    let loads = 0;
    const page = (offset: number) => Array.from({ length: DR_READ_CANDIDATE_CHUNK_SIZE }, (_, i) => ({
      id: `hidden-${offset + i}`,
      createdAt: new Date(1_000_000 - offset - i),
    }));

    const visible = await collectReadableDrRows({
      limit: 5,
      load: async () => page((loads++) * DR_READ_CANDIDATE_CHUNK_SIZE),
      filter: async () => [],
    });

    expect(visible).toEqual([]);
    // Without the cap this walks the whole table one page at a time.
    expect(loads).toBe(DR_READ_MAX_CANDIDATE_PAGES);
  });

  it('returns a short page rather than scanning past the cap', async () => {
    let loads = 0;
    const visible = await collectReadableDrRows({
      // One visible row per page, so the requested limit can never be filled
      // within the cap — the caller gets a short page instead of a long scan.
      limit: DR_READ_MAX_CANDIDATE_PAGES + 10,
      load: async () => {
        loads += 1;
        return Array.from({ length: DR_READ_CANDIDATE_CHUNK_SIZE }, (_, i) => ({
          id: `row-${loads}-${i}`,
          createdAt: new Date(1_000_000 - loads * 1000 - i),
        }));
      },
      filter: async (rows) => rows.slice(0, 1),
    });

    expect(loads).toBe(DR_READ_MAX_CANDIDATE_PAGES);
    expect(visible).toHaveLength(DR_READ_MAX_CANDIDATE_PAGES);
  });

  it('stops early once the limit is filled without hitting the cap', async () => {
    let loads = 0;
    const visible = await collectReadableDrRows({
      limit: 2,
      load: async () => {
        loads += 1;
        return Array.from({ length: DR_READ_CANDIDATE_CHUNK_SIZE }, (_, i) => ({
          id: `row-${i}`,
          createdAt: new Date(1_000_000 - i),
        }));
      },
      filter: async (rows) => rows,
    });

    expect(loads).toBe(1);
    expect(visible).toHaveLength(2);
  });

  it('stops on a short page (end of table)', async () => {
    let loads = 0;
    const visible = await collectReadableDrRows({
      limit: 50,
      load: async () => {
        loads += 1;
        return [{ id: 'only', createdAt: new Date(1) }];
      },
      filter: async (rows) => rows,
    });

    expect(loads).toBe(1);
    expect(visible).toHaveLength(1);
  });
});

describe('filterReadableDrPlans — whole-plan visibility', () => {
  it('ignores an id with no surviving device row', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['gone', 'dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);
    expect(await filterReadableDrPlans([{ id: 'p1' }], RESTRICTED(), 'org-1')).toEqual([{ id: 'p1' }]);
  });

  it('denies on a surviving device outside the ceiling', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A', 'dev-B'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    expect(await filterReadableDrPlans([{ id: 'p1' }], RESTRICTED(), 'org-1')).toEqual([]);
  });

  it('denies on a surviving device with a null site', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: null }],
    ]);
    expect(await filterReadableDrPlans([{ id: 'p1' }], RESTRICTED(), 'org-1')).toEqual([]);
  });

  it('denies a malformed group device array', async () => {
    seqSelect([[{ planId: 'p1', devices: 'not-an-array' }]]);
    expect(await filterReadableDrPlans([{ id: 'p1' }], RESTRICTED(), 'org-1')).toEqual([]);
  });

  it('denies a group array holding a non-string member', async () => {
    seqSelect([[{ planId: 'p1', devices: ['dev-A', 42] }]]);
    expect(await filterReadableDrPlans([{ id: 'p1' }], RESTRICTED(), 'org-1')).toEqual([]);
  });

  it('admits a plan with no groups at all (nothing site-bound to hide)', async () => {
    seqSelect([[]]);
    expect(await filterReadableDrPlans([{ id: 'p1' }], RESTRICTED(), 'org-1')).toEqual([{ id: 'p1' }]);
  });

  it('returns nothing for a defined-empty ceiling without querying', async () => {
    expect(await filterReadableDrPlans([{ id: 'p1' }], makeAuth([]), 'org-1')).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('returns every row for an unrestricted caller without querying', async () => {
    const rows = [{ id: 'p1' }, { id: 'p2' }];
    expect(await filterReadableDrPlans(rows, makeAuth(undefined), 'org-1')).toBe(rows);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('filterReadableDrExecutions — malformed result documents', () => {
  const row = (results: unknown) => ({ planId: 'p1', results });
  const denied = async (results: unknown, groups: unknown[] = [{ planId: 'p1', devices: [] }]) => {
    seqSelect([groups, [{ id: 'dev-A', siteId: 'site-A' }]]);
    return filterReadableDrExecutions([row(results)], RESTRICTED(), 'org-1');
  };

  it.each([
    ['null', null],
    ['an array', []],
    ['a scalar', 'nope'],
    ['missing groupResults', { queuedCommands: [], failedDispatches: [], plannedGroups: [] }],
    ['missing queuedCommands', { groupResults: [], failedDispatches: [], plannedGroups: [] }],
    ['missing failedDispatches', { groupResults: [], queuedCommands: [], plannedGroups: [] }],
    ['missing plannedGroups', { groupResults: [], queuedCommands: [], failedDispatches: [] }],
    ['a group result with no devices array', {
      groupResults: [{ groupId: 'g1' }], queuedCommands: [], failedDispatches: [], plannedGroups: [],
    }],
    ['a device entry with a non-string id', {
      groupResults: [{ groupId: 'g1', devices: [{ id: 7 }] }],
      queuedCommands: [], failedDispatches: [], plannedGroups: [],
    }],
    ['a non-object queued command', {
      groupResults: [], queuedCommands: [null], failedDispatches: [], plannedGroups: [],
    }],
    ['a queued command with a non-string deviceId', {
      groupResults: [], queuedCommands: [{ deviceId: 7 }], failedDispatches: [], plannedGroups: [],
    }],
    ['a non-string entry in authorizedDeviceIds', resultsDoc([], { authorizedDeviceIds: ['dev-A', 7] })],
  ])('denies when results is %s', async (_label, results) => {
    expect(await denied(results)).toEqual([]);
  });

  it('admits a well-formed document whose devices are all visible', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);
    const rows = [row(resultsDoc(['dev-A']))];
    expect(await filterReadableDrExecutions(rows, RESTRICTED(), 'org-1')).toEqual(rows);
  });

  it('treats a null authorizedDeviceIds as "no extra ids", not a malformed doc', async () => {
    // drExecutionService declares the field `string[] | null`, so null is a
    // normal value a real execution row carries.
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);
    const rows = [row(resultsDoc(['dev-A'], { authorizedDeviceIds: null }))];
    expect(await filterReadableDrExecutions(rows, RESTRICTED(), 'org-1')).toEqual(rows);
  });

  it('denies when only the historical authorizedDeviceIds names a hidden device', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    const rows = [row(resultsDoc(['dev-A'], { authorizedDeviceIds: ['dev-B'] }))];
    expect(await filterReadableDrExecutions(rows, RESTRICTED(), 'org-1')).toEqual([]);
  });

  it('denies on a hidden device named only by the CURRENT plan groups', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A', 'dev-B'] }],
      [{ id: 'dev-A', siteId: 'site-A' }, { id: 'dev-B', siteId: 'site-B' }],
    ]);
    expect(await filterReadableDrExecutions([row(resultsDoc(['dev-A']))], RESTRICTED(), 'org-1')).toEqual([]);
  });

  it('ignores a stale historical device that no longer resolves', async () => {
    seqSelect([
      [{ planId: 'p1', devices: ['dev-A'] }],
      [{ id: 'dev-A', siteId: 'site-A' }],
    ]);
    const rows = [row(resultsDoc(['dev-A', 'decommissioned']))];
    expect(await filterReadableDrExecutions(rows, RESTRICTED(), 'org-1')).toEqual(rows);
  });

  it('returns nothing for a defined-empty ceiling without querying', async () => {
    expect(await filterReadableDrExecutions([row(resultsDoc([]))], makeAuth([]), 'org-1')).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
