import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  patchJobs: { id: 'id', orgId: 'orgId', policyId: 'policyId', configPolicyId: 'configPolicyId' },
  configPolicyPatchSettings: { featureLinkId: 'featureLinkId' },
  configPolicyEffectiveFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configPolicyAssignments: { configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', status: 'status' },
}));

vi.mock('./featureConfigResolver', () => ({
  resolvePatchConfigDetailsForDevice: vi.fn(),
  checkDeviceMaintenanceWindow: vi.fn(),
}));

import { db } from '../db';
import { createPatchJobFromConfigPolicy, createPatchJobForDeviceFromPolicy } from './patchJobService';
import { resolvePatchConfigDetailsForDevice, checkDeviceMaintenanceWindow } from './featureConfigResolver';

function makePatchSettings(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'ps-1',
    featureLinkId: 'fl-1',
    sources: ['windows_update'],
    autoApprove: true,
    autoApproveSeverities: ['critical', 'important'],
    rebootPolicy: 'if_needed',
    scheduleFrequency: 'daily',
    scheduleTime: '02:00',
    scheduleDayOfWeek: null,
    scheduleDayOfMonth: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// The resolver hands back the ASSIGNED policy id alongside the settings, which
// is what the job must carry (#5080). `configPolicyId` here is deliberately a
// DIFFERENT value from the feature link id: a reverse map from the link would
// no longer identify one policy.
function makeResolvedDetails(overrides: Record<string, unknown> = {}): any {
  return {
    settings: makePatchSettings(),
    featureLinkId: 'fl-parent',
    configPolicyId: 'cp-1',
    configPolicyName: 'Child Policy',
    featurePolicyId: null,
    assignmentLevel: 'organization',
    assignmentTargetId: 'org-1',
    assignmentPriority: 0,
    resolvedTimezone: 'UTC',
    ...overrides,
  };
}

function mockDbInsertReturning(result: unknown[]) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result),
    }),
  } as any);
}

function mockDbInsertCapturingValues(result: unknown[]) {
  const valuesMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(result),
  });
  vi.mocked(db.insert).mockReturnValue({
    values: valuesMock,
  } as any);
  return valuesMock;
}

function mockDbSelectChain(result: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

describe('patchJobService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // createPatchJobFromConfigPolicy
  // ============================================

  describe('createPatchJobFromConfigPolicy', () => {
    it('creates a patch job with policyId=null and correct configPolicyId', async () => {
      const job = {
        id: 'job-1',
        orgId: 'org-1',
        policyId: null,
        configPolicyId: 'cp-1',
        name: 'Daily patch job @ 02:00',
        status: 'scheduled',
      };
      const valuesMock = mockDbInsertCapturingValues([job]);

      const result = await createPatchJobFromConfigPolicy('dev-1', makePatchSettings(), 'org-1', 'cp-1');
      expect(result.job.policyId).toBeNull();
      expect(result.job.configPolicyId).toBe('cp-1');
      // Verify computed values passed to DB
      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ policyId: null, configPolicyId: 'cp-1', orgId: 'org-1' })
      );
    });

    it('generates correct daily job name', async () => {
      const job = { id: 'job-1', name: 'Daily patch job @ 02:00' };
      const valuesMock = mockDbInsertCapturingValues([job]);

      const settings = makePatchSettings({ scheduleFrequency: 'daily', scheduleTime: '02:00' });
      await createPatchJobFromConfigPolicy('dev-1', settings, 'org-1', 'cp-1');

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Daily patch job @ 02:00' })
      );
    });

    it('generates correct weekly job name', async () => {
      const job = { id: 'job-1', name: 'Weekly patch job (sun) @ 03:00' };
      const valuesMock = mockDbInsertCapturingValues([job]);

      const settings = makePatchSettings({
        scheduleFrequency: 'weekly',
        scheduleTime: '03:00',
        scheduleDayOfWeek: 'sun',
      });
      await createPatchJobFromConfigPolicy('dev-1', settings, 'org-1', 'cp-1');

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Weekly patch job (sun) @ 03:00' })
      );
    });

    it('generates correct monthly job name', async () => {
      const job = { id: 'job-1', name: 'Monthly patch job (day 15) @ 04:00' };
      const valuesMock = mockDbInsertCapturingValues([job]);

      const settings = makePatchSettings({
        scheduleFrequency: 'monthly',
        scheduleTime: '04:00',
        scheduleDayOfMonth: 15,
      });
      await createPatchJobFromConfigPolicy('dev-1', settings, 'org-1', 'cp-1');

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Monthly patch job (day 15) @ 04:00' })
      );
    });

    it('generates manual job name when frequency is unknown', async () => {
      const job = { id: 'job-1', name: 'Patch job (Manual)' };
      const valuesMock = mockDbInsertCapturingValues([job]);

      const settings = makePatchSettings({ scheduleFrequency: 'manual' });
      await createPatchJobFromConfigPolicy('dev-1', settings, 'org-1', 'cp-1');

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Patch job (Manual)' })
      );
    });

    it('throws when DB insert returns empty', async () => {
      mockDbInsertReturning([]);
      await expect(
        createPatchJobFromConfigPolicy('dev-1', makePatchSettings(), 'org-1', 'cp-1')
      ).rejects.toThrow('Failed to create patch job');
    });
  });

  // ============================================
  // createPatchJobForDeviceFromPolicy
  // ============================================

  describe('createPatchJobForDeviceFromPolicy', () => {
    it('returns null when maintenance window suppresses patching', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: true,
        suppressAlerts: false,
        suppressPatching: true,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: false,
        windowEndsAt: null,
      });

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).toBeNull();
      expect(resolvePatchConfigDetailsForDevice).not.toHaveBeenCalled();
    });

    it('returns null when no patch config resolves for the device', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(null);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).toBeNull();
    });

    it("stamps the RESOLVER's policy id on the job, with no feature-link lookup", async () => {
      // The seam this test exists for (#5080). A link id now belongs to the
      // authoring parent AND every child, so reverse-mapping it would stamp an
      // arbitrary policy — and with it an arbitrary org — onto the patch job.
      // The resolver already knows which assignment won; that id is the answer.
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(
        makeResolvedDetails({ configPolicyId: 'cp-child', featureLinkId: 'fl-parent' }),
      );
      mockDbInsertReturning([{ id: 'job-1', policyId: null, configPolicyId: 'cp-child' }]);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');

      expect(result!.job.configPolicyId).toBe('cp-child');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('creates a job when the resolver returns patch settings', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(makeResolvedDetails());

      // Mock insert for job creation
      const job = { id: 'job-1', policyId: null, configPolicyId: 'cp-1' };
      mockDbInsertReturning([job]);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).not.toBeNull();
      expect(result!.job.configPolicyId).toBe('cp-1');
    });

    it('proceeds when maintenance window is active but does not suppress patching', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: true,
        suppressAlerts: true,
        suppressPatching: false,
        suppressAutomations: true,
        suppressScripts: true,
        rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(makeResolvedDetails());

      const job = { id: 'job-1', policyId: null, configPolicyId: 'cp-1' };
      mockDbInsertReturning([job]);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).not.toBeNull();
    });

    it('proceeds when maintenance window is inactive', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(makeResolvedDetails());

      mockDbInsertReturning([{ id: 'job-1', policyId: null, configPolicyId: 'cp-1' }]);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).not.toBeNull();
    });

    it('propagates error when DB insert returns empty in inner createPatchJobFromConfigPolicy', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false, suppressAlerts: false, suppressPatching: false,
        suppressAutomations: false, suppressScripts: false, rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(makeResolvedDetails());
      mockDbInsertReturning([]); // Empty -> triggers throw

      await expect(
        createPatchJobForDeviceFromPolicy('dev-1', 'org-1')
      ).rejects.toThrow('Failed to create patch job');
    });

    it('propagates error when checkDeviceMaintenanceWindow rejects', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockRejectedValue(new Error('DB timeout'));

      await expect(
        createPatchJobForDeviceFromPolicy('dev-1', 'org-1')
      ).rejects.toThrow('DB timeout');
    });

    it('propagates error when resolvePatchConfigDetailsForDevice rejects', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false, suppressAlerts: false, suppressPatching: false,
        suppressAutomations: false, suppressScripts: false, rebootIfPending: false,
        windowEndsAt: null,
      });
      vi.mocked(resolvePatchConfigDetailsForDevice).mockRejectedValue(new Error('DB connection lost'));

      await expect(
        createPatchJobForDeviceFromPolicy('dev-1', 'org-1')
      ).rejects.toThrow('DB connection lost');
    });
  });
});
