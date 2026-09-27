import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

// Field-provenance tiering — both compliance-policy device_group
// target resolvers feed `triggerRemediationAutomation` (dispatches an
// automation run) or the config-policy compliance remediation trigger, so a
// device that self-selects into a group via an agent-reported filter field
// must not be able to steer itself into (or out of) automatic remediation.
// Mocked as a pass-through by default; a dedicated test overrides it to prove
// the gate is wired in.
const mockResolveExecutionSafeGroupIds = vi.fn(async (groupIds: string[]) => ({
  allowedGroupIds: groupIds,
  refusedGroups: [] as Array<{ id: string; refusedFields: string[] }>,
}));
const mockAuditRefusedExecutionGroups = vi.fn();
vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (...args: [string[]]) => mockResolveExecutionSafeGroupIds(...args),
  auditRefusedExecutionGroups: (...args: unknown[]) => mockAuditRefusedExecutionGroups(...args),
}));

import { __resolveTargetDevices, __resolveDevicesForAssignmentTarget } from './policyEvaluationService';
import { db } from '../db';

function selectChain(rows: unknown[]) {
  const chain: any = {
    then(resolve: (v: unknown) => void) {
      resolve(rows);
    },
  };
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  return chain;
}

describe('policyEvaluationService — device_group compliance/remediation targets gated by field provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveExecutionSafeGroupIds.mockImplementation(async (groupIds: string[]) => ({
      allowedGroupIds: groupIds,
      refusedGroups: [],
    }));
  });

  describe('resolveTargetDevices — auto-remediation policy groupIds target', () => {
    it('gates the group before querying membership', async () => {
      vi.mocked(db.select).mockReturnValue(selectChain([]) as any);
      const policy: any = {
        orgId: 'org-1',
        partnerId: null,
        targets: { groupIds: ['grp-1'] },
      };

      await __resolveTargetDevices(policy);

      expect(mockResolveExecutionSafeGroupIds).toHaveBeenCalledWith(['grp-1']);
    });

    it('refuses a group whose rules reference an execution-refused field — no devices, no membership query', async () => {
      mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({
        allowedGroupIds: [],
        refusedGroups: [{ id: 'grp-1', refusedFields: ['hostname'] }],
      });
      vi.mocked(db.select).mockReturnValue(selectChain([{ id: 'dev-should-not-appear' }]) as any);
      const policy: any = {
        orgId: 'org-1',
        partnerId: null,
        targets: { groupIds: ['grp-1'] },
      };

      const devicesResolved = await __resolveTargetDevices(policy);

      expect(devicesResolved).toEqual([]);
      expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith(
        'org-1',
        'policy_evaluation.execution_target_refused_agent_reported_fields',
        [{ id: 'grp-1', refusedFields: ['hostname'] }],
      );
    });
  });

  describe('resolveDevicesForAssignmentTarget — config-policy compliance scan device_group target', () => {
    it('refuses a device_group target whose rules reference an execution-refused field, without querying membership', async () => {
      mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({
        allowedGroupIds: [],
        refusedGroups: [{ id: 'grp-1', refusedFields: ['hostname'] }],
      });

      const ids = await __resolveDevicesForAssignmentTarget('device_group', 'grp-1');

      expect(ids).toEqual([]);
      expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith(
        null,
        'policy_evaluation.execution_target_refused_agent_reported_fields',
        [{ id: 'grp-1', refusedFields: ['hostname'] }],
      );
      expect(db.select).not.toHaveBeenCalled();
    });

    it('still resolves an allowed device_group target', async () => {
      vi.mocked(db.select).mockReturnValue(selectChain([{ deviceId: 'dev-1' }]) as any);

      const ids = await __resolveDevicesForAssignmentTarget('device_group', 'grp-1');

      expect(ids).toEqual(['dev-1']);
    });
  });
});
