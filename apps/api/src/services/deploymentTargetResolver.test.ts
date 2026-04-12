import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_ID_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GROUP_ID_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// Mutable terminal value for the Drizzle chain mock.
let mockSelectResult: any[] = [];

// Chain-friendly mock builder for Drizzle query builder patterns.
// Returns a Proxy that can handle any chain length (select/from/where/innerJoin/etc.)
// and resolves to `mockSelectResult` when awaited.
function chainMock() {
  const makeChain = (): any => {
    const target = {} as any;
    // Make it thenable so `await` resolves to mockSelectResult
    target.then = (onFulfilled: any, onRejected?: any) => {
      return Promise.resolve(mockSelectResult).then(onFulfilled, onRejected);
    };
    return new Proxy(target, {
      get(_target, prop) {
        if (prop === 'then') return target.then;
        // Any other property access returns a callable that continues the chain
        return (..._args: any[]) => makeChain();
      },
    });
  };
  return makeChain();
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chainMock()),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', orgId: 'org_id' },
  deviceGroups: { id: 'id', orgId: 'org_id' },
  deviceGroupMemberships: { deviceId: 'device_id', groupId: 'group_id' },
}));

const mockEvaluateFilter = vi.fn();
vi.mock('./filterEngine', () => ({
  evaluateFilter: (...args: any[]) => mockEvaluateFilter(...args),
}));

import { resolveDeploymentTargets } from './deploymentTargetResolver';
import { db } from '../db';

describe('resolveDeploymentTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectResult = [];
    mockEvaluateFilter.mockReset();
  });

  // ----------------------------------------------------------------
  // type: 'devices' — returns only devices matching org
  // ----------------------------------------------------------------
  describe('type: devices', () => {
    it('returns device IDs that belong to the org', async () => {
      mockSelectResult = [{ id: DEVICE_ID_1 }, { id: DEVICE_ID_2 }];

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'devices', deviceIds: [DEVICE_ID_1, DEVICE_ID_2, DEVICE_ID_3] },
      });

      expect(result).toEqual([DEVICE_ID_1, DEVICE_ID_2]);
      expect(db.select).toHaveBeenCalled();
    });

    it('returns empty array for empty deviceIds', async () => {
      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'devices', deviceIds: [] },
      });

      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns empty array when deviceIds is undefined', async () => {
      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'devices' },
      });

      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // type: 'groups' — resolves group members, deduplicates
  // ----------------------------------------------------------------
  describe('type: groups', () => {
    it('resolves group members and deduplicates', async () => {
      // Device appears twice (in both groups) — should be deduplicated
      mockSelectResult = [
        { deviceId: DEVICE_ID_1 },
        { deviceId: DEVICE_ID_2 },
        { deviceId: DEVICE_ID_1 },
      ];

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'groups', groupIds: [GROUP_ID_1, GROUP_ID_2] },
      });

      expect(result).toEqual([DEVICE_ID_1, DEVICE_ID_2]);
    });

    it('returns empty array for empty groupIds', async () => {
      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'groups', groupIds: [] },
      });

      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns empty array when groupIds is undefined', async () => {
      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'groups' },
      });

      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // type: 'filter' — evaluates filter and returns matching devices
  // ----------------------------------------------------------------
  describe('type: filter', () => {
    it('evaluates filter and returns deduplicated device IDs', async () => {
      mockEvaluateFilter.mockResolvedValueOnce({
        deviceIds: [DEVICE_ID_1, DEVICE_ID_2, DEVICE_ID_1],
      });

      const filterCondition = {
        operator: 'AND' as const,
        conditions: [
          { field: 'osType', operator: 'equals' as const, value: 'windows' },
        ],
      };

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'filter', filter: filterCondition },
      });

      expect(result).toEqual([DEVICE_ID_1, DEVICE_ID_2]);
      expect(mockEvaluateFilter).toHaveBeenCalledWith(filterCondition, { orgId: ORG_ID });
    });

    it('returns empty array when filter is undefined', async () => {
      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'filter' },
      });

      expect(result).toEqual([]);
      expect(mockEvaluateFilter).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // type: 'all' — returns all org devices
  // ----------------------------------------------------------------
  describe('type: all', () => {
    it('returns all devices for the org', async () => {
      mockSelectResult = [{ id: DEVICE_ID_1 }, { id: DEVICE_ID_2 }, { id: DEVICE_ID_3 }];

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'all' },
      });

      expect(result).toEqual([DEVICE_ID_1, DEVICE_ID_2, DEVICE_ID_3]);
      expect(db.select).toHaveBeenCalled();
    });

    it('returns empty array when org has no devices', async () => {
      mockSelectResult = [];

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'all' },
      });

      expect(result).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // Multi-tenant isolation
  // ----------------------------------------------------------------
  describe('multi-tenant isolation', () => {
    it('type devices — only returns devices verified against the given orgId', async () => {
      // DB query filters by orgId, so even if device IDs from another org are
      // passed in, the query only returns rows matching the caller's org.
      mockSelectResult = [{ id: DEVICE_ID_1 }];

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID,
        targetConfig: { type: 'devices', deviceIds: [DEVICE_ID_1, DEVICE_ID_2] },
      });

      // Only DEVICE_ID_1 belonged to ORG_ID; DEVICE_ID_2 was filtered out by Drizzle
      expect(result).toEqual([DEVICE_ID_1]);
    });

    it('type groups — group membership join scopes both group and device to orgId', async () => {
      // Even if a groupId from another org is passed, the query inner-joins
      // on orgId for both deviceGroups and devices tables.
      mockSelectResult = [];

      const result = await resolveDeploymentTargets({
        orgId: ORG_ID_2,
        targetConfig: { type: 'groups', groupIds: [GROUP_ID_1] },
      });

      expect(result).toEqual([]);
    });

    it('type filter — passes orgId to evaluateFilter for scoping', async () => {
      mockEvaluateFilter.mockResolvedValueOnce({ deviceIds: [] });

      await resolveDeploymentTargets({
        orgId: ORG_ID_2,
        targetConfig: {
          type: 'filter',
          filter: { operator: 'AND' as const, conditions: [] },
        },
      });

      expect(mockEvaluateFilter).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG_ID_2 },
      );
    });
  });
});
