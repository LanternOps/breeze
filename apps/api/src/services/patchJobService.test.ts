import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  patchJobs: { id: 'id', orgId: 'orgId', policyId: 'policyId', configPolicyId: 'configPolicyId' },
  configPolicyPatchSettings: { featureLinkId: 'featureLinkId' },
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configPolicyAssignments: { configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', status: 'status' },
}));

vi.mock('./featureConfigResolver', () => ({
  resolvePatchConfigForDevice: vi.fn(),
  checkDeviceMaintenanceWindow: vi.fn(),
}));

import { db } from '../db';
import { createPatchJobFromConfigPolicy, createPatchJobForDeviceFromPolicy } from './patchJobService';
import { resolvePatchConfigForDevice, checkDeviceMaintenanceWindow } from './featureConfigResolver';

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
      });

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).toBeNull();
      expect(resolvePatchConfigForDevice).not.toHaveBeenCalled();
    });

    it('returns null when no patch config resolves for the device', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
      });
      vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(null);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).toBeNull();
    });

    it('returns null when feature link is not found', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
      });
      vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(makePatchSettings());

      // Feature link select returns empty
      mockDbSelectChain([]);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).toBeNull();
    });

    it('creates a job when patch config and feature link resolve successfully', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false,
        suppressAlerts: false,
        suppressPatching: false,
        suppressAutomations: false,
        suppressScripts: false,
      });
      vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(makePatchSettings());

      // Mock feature link select
      mockDbSelectChain([{ configPolicyId: 'cp-1' }]);

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
      });
      vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(makePatchSettings());

      mockDbSelectChain([{ configPolicyId: 'cp-1' }]);
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
      });
      vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(makePatchSettings());

      mockDbSelectChain([{ configPolicyId: 'cp-1' }]);
      mockDbInsertReturning([{ id: 'job-1', policyId: null, configPolicyId: 'cp-1' }]);

      const result = await createPatchJobForDeviceFromPolicy('dev-1', 'org-1');
      expect(result).not.toBeNull();
    });

    it('propagates error when DB insert returns empty in inner createPatchJobFromConfigPolicy', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false, suppressAlerts: false, suppressPatching: false,
        suppressAutomations: false, suppressScripts: false,
      });
      vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(makePatchSettings());
      mockDbSelectChain([{ configPolicyId: 'cp-1' }]);
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

    it('propagates error when resolvePatchConfigForDevice rejects', async () => {
      vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
        active: false, suppressAlerts: false, suppressPatching: false,
        suppressAutomations: false, suppressScripts: false,
      });
      vi.mocked(resolvePatchConfigForDevice).mockRejectedValue(new Error('DB connection lost'));

      await expect(
        createPatchJobForDeviceFromPolicy('dev-1', 'org-1')
      ).rejects.toThrow('DB connection lost');
    });
  });
});
