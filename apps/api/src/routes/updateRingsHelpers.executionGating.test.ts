/**
 * Field-provenance tiering (denylist option) coverage for the patch update-ring
 * device_group-level assignment expansion — one of the sibling execution
 * paths the field-provenance gate in `deploymentTargetResolver.ts` did not
 * originally cover.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const RING_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// Queue of results consumed one per db.select() call, in order.
let selectQueue: unknown[][] = [];

function chainMock(result: unknown[]) {
  const makeChain = (): any => {
    const target: any = {};
    target.then = (onFulfilled: any, onRejected?: any) => Promise.resolve(result).then(onFulfilled, onRejected);
    return new Proxy(target, {
      get(_t, prop) {
        if (prop === 'then') return target.then;
        return (..._args: any[]) => makeChain();
      },
    });
  };
  return makeChain();
}

const selectSpy = vi.fn((..._args: any[]) => chainMock(selectQueue.shift() ?? []));
vi.mock('../db', () => ({
  db: { select: (...args: any[]) => selectSpy(...args) },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', orgId: 'org_id', siteId: 'site_id', isEphemeral: 'is_ephemeral' },
  organizations: { id: 'id', partnerId: 'partner_id' },
  configPolicyFeatureLinks: { configPolicyId: 'config_policy_id', featureType: 'feature_type', featurePolicyId: 'feature_policy_id' },
  configPolicyAssignments: { configPolicyId: 'config_policy_id', level: 'level', targetId: 'target_id' },
  configurationPolicies: { id: 'id', status: 'status', orgId: 'org_id' },
  deviceGroupMemberships: { deviceId: 'device_id', groupId: 'group_id' },
  patchPolicies: { id: 'id', partnerId: 'partner_id' },
}));

const mockResolveExecutionSafeGroupIds = vi.fn();
const mockAuditRefusedExecutionGroups = vi.fn();
const mockWarningsForRefusedExecutionGroups = vi.fn();
vi.mock('../services/executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (...args: any[]) => mockResolveExecutionSafeGroupIds(...args),
  auditRefusedExecutionGroups: (...args: any[]) => mockAuditRefusedExecutionGroups(...args),
  warningsForRefusedExecutionGroups: (...args: any[]) => mockWarningsForRefusedExecutionGroups(...args),
}));

import { resolveRingDeviceIdsWithWarnings } from './updateRingsHelpers';

describe('resolveRingDeviceIdsWithWarnings — device_group assignment gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue = [];
  });

  it('excludes an execution-refused group, never queries its membership, and surfaces a warning', async () => {
    selectQueue.push([
      { level: 'device_group', targetId: GROUP_ID, policyOrgId: null, ringPartnerId: PARTNER_ID },
    ]);
    mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({
      allowedGroupIds: [],
      refusedGroups: [{ id: GROUP_ID, refusedFields: ['hostname'] }],
    });
    mockWarningsForRefusedExecutionGroups.mockReturnValueOnce(['group excluded: hostname']);

    const result = await resolveRingDeviceIdsWithWarnings(RING_ID);

    expect(result).toEqual({ deviceIds: [], warnings: ['group excluded: hostname'] });
    expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith(
      null,
      'update_ring.execution_target_refused_agent_reported_fields',
      [{ id: GROUP_ID, refusedFields: ['hostname'] }],
    );
    // Only the assignment-lookup select ran — no membership query for a fully-refused group set.
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('includes an execution-safe group\'s members and reports no warnings', async () => {
    selectQueue.push(
      [{ level: 'device_group', targetId: GROUP_ID, policyOrgId: null, ringPartnerId: PARTNER_ID }],
      [{ deviceId: DEVICE_ID }],
    );
    mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({
      allowedGroupIds: [GROUP_ID],
      refusedGroups: [],
    });
    mockWarningsForRefusedExecutionGroups.mockReturnValueOnce([]);

    const result = await resolveRingDeviceIdsWithWarnings(RING_ID);

    expect(result).toEqual({ deviceIds: [DEVICE_ID], warnings: [] });
    expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith(
      null,
      'update_ring.execution_target_refused_agent_reported_fields',
      [],
    );
  });
});
