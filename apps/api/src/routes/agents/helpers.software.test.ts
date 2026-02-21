import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() runs before imports so factory closures work.
// ---------------------------------------------------------------------------

const {
  mockLimit,
  mockWhere,
  mockSetWhere,
  mockSet,
  dbMock,
  mockScheduleSoftwareComplianceCheck,
  mockRecordSoftwarePolicyAudit,
  mockRecordSoftwareRemediationDecision,
} = vi.hoisted(() => {
  const mockLimit = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockSetWhere });

  const dbMock = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockWhere }),
    }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };

  return {
    mockLimit,
    mockWhere,
    mockSetWhere,
    mockSet,
    dbMock,
    mockScheduleSoftwareComplianceCheck: vi.fn().mockResolvedValue('job-123'),
    mockRecordSoftwarePolicyAudit: vi.fn().mockResolvedValue(undefined),
    mockRecordSoftwareRemediationDecision: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({ db: dbMock }));

vi.mock('../../db/schema', () => ({
  softwarePolicies: { id: 'sp.id', orgId: 'sp.orgId', name: 'sp.name' },
  softwareComplianceStatus: {
    id: 'scs.id',
    policyId: 'scs.policyId',
    deviceId: 'scs.deviceId',
    remediationErrors: 'scs.remediationErrors',
    remediationStatus: 'scs.remediationStatus',
    lastRemediationAttempt: 'scs.lastRemediationAttempt',
  },
  devices: {},
  deviceCommands: { $inferSelect: {} },
  deviceDisks: {},
  deviceFilesystemSnapshots: {},
  automationPolicies: {},
  securityStatus: {},
  securityThreats: {},
  securityScans: {},
  organizations: {},
  softwarePolicyAudit: {},
}));

vi.mock('../../jobs/softwareComplianceWorker', () => ({
  scheduleSoftwareComplianceCheck: mockScheduleSoftwareComplianceCheck,
}));

vi.mock('../../services/softwarePolicyService', () => ({
  recordSoftwarePolicyAudit: mockRecordSoftwarePolicyAudit,
}));

vi.mock('../metrics', () => ({
  recordSoftwareRemediationDecision: mockRecordSoftwareRemediationDecision,
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../../services/filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  mergeFilesystemAnalysisPayload: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(),
  readHotDirectories: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  upsertFilesystemScanState: vi.fn(),
}));

vi.mock('../../services/cloudflareMtls', () => ({
  CloudflareMtlsService: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are in place)
// ---------------------------------------------------------------------------
import { handleSoftwareRemediationCommandResult } from './helpers';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const POLICY_ID = '00000000-0000-4000-8000-000000000002';
const COMMAND_ID = '00000000-0000-4000-8000-000000000003';
const COMPLIANCE_ID = '00000000-0000-4000-8000-000000000004';
const ORG_ID = '00000000-0000-4000-8000-000000000005';

function makeCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMAND_ID,
    deviceId: DEVICE_ID,
    type: 'software_uninstall',
    payload: { policyId: POLICY_ID, name: 'BadApp', version: '1.0.0' },
    status: 'completed',
    createdBy: null,
    createdAt: new Date(),
    executedAt: new Date(),
    completedAt: new Date(),
    result: null,
    ...overrides,
  } as any;
}

function makeResult(
  overrides: Partial<z.infer<typeof commandResultSchema>> = {},
): z.infer<typeof commandResultSchema> {
  return {
    status: 'completed',
    durationMs: 1234,
    ...overrides,
  };
}

const mockPolicy = { id: POLICY_ID, orgId: ORG_ID, name: 'No BadApp' };
const mockCompliance = { id: COMPLIANCE_ID, remediationErrors: null };

// ---------------------------------------------------------------------------
// Helpers for resetting the mock chains between tests
// ---------------------------------------------------------------------------

function resetDbMocks() {
  mockLimit.mockReset();
  mockWhere.mockReset().mockReturnValue({ limit: mockLimit });

  const fromMock = vi.fn().mockReturnValue({ where: mockWhere });
  dbMock.select.mockReset().mockReturnValue({ from: fromMock });

  mockSetWhere.mockReset().mockResolvedValue(undefined);
  mockSet.mockReset().mockReturnValue({ where: mockSetWhere });
  dbMock.update.mockReset().mockReturnValue({ set: mockSet });

  dbMock.insert.mockReset().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSoftwareRemediationCommandResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMocks();
  });

  // -----------------------------------------------------------------------
  // Early-return scenarios
  // -----------------------------------------------------------------------

  it('returns early for non-software_uninstall commands', async () => {
    await handleSoftwareRemediationCommandResult(
      makeCommand({ type: 'run_script' }),
      makeResult(),
    );

    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(mockScheduleSoftwareComplianceCheck).not.toHaveBeenCalled();
  });

  it('returns early when policyId is missing from payload', async () => {
    await handleSoftwareRemediationCommandResult(
      makeCommand({ payload: { name: 'SomeApp' } }),
      makeResult(),
    );

    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns early when policyId is not a valid UUID', async () => {
    await handleSoftwareRemediationCommandResult(
      makeCommand({ payload: { policyId: 'not-a-uuid', name: 'SomeApp' } }),
      makeResult(),
    );

    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns early when payload is null', async () => {
    await handleSoftwareRemediationCommandResult(
      makeCommand({ payload: null }),
      makeResult(),
    );

    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns early when policy is not found in DB', async () => {
    mockLimit.mockResolvedValueOnce([]); // policy lookup returns nothing

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult(),
    );

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(mockScheduleSoftwareComplianceCheck).not.toHaveBeenCalled();
  });

  it('returns early when compliance record is not found in DB', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])    // policy found
      .mockResolvedValueOnce([]);              // compliance not found

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult(),
    );

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(mockScheduleSoftwareComplianceCheck).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Success path (status: 'completed')
  // -----------------------------------------------------------------------

  it('marks remediation as completed on success', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'completed' }),
    );

    expect(dbMock.update).toHaveBeenCalled();

    const setCalls = mockSet.mock.calls;
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][0]).toMatchObject({
      remediationStatus: 'completed',
      remediationErrors: null,
    });
    expect(setCalls[0][0].lastRemediationAttempt).toBeInstanceOf(Date);
  });

  it('schedules a verification compliance check on success', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'completed' }),
    );

    expect(mockScheduleSoftwareComplianceCheck).toHaveBeenCalledWith(
      POLICY_ID,
      [DEVICE_ID],
    );
  });

  it('records audit entry with action software_uninstalled on success', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'completed' }),
    );

    expect(mockRecordSoftwarePolicyAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        policyId: POLICY_ID,
        deviceId: DEVICE_ID,
        action: 'software_uninstalled',
        actor: 'system',
        details: expect.objectContaining({
          commandId: COMMAND_ID,
          softwareName: 'BadApp',
          softwareVersion: '1.0.0',
        }),
      }),
    );
  });

  it('records remediation decision metric on success', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'completed' }),
    );

    expect(mockRecordSoftwareRemediationDecision).toHaveBeenCalledWith(
      'command_result_completed',
    );
  });

  // -----------------------------------------------------------------------
  // Failure path (status: 'failed')
  // -----------------------------------------------------------------------

  it('marks remediation as failed on failure', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([{ ...mockCompliance, remediationErrors: [] }]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed', error: 'Access denied', exitCode: 1 }),
    );

    expect(dbMock.update).toHaveBeenCalled();

    const setCalls = mockSet.mock.calls;
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][0].remediationStatus).toBe('failed');
    expect(setCalls[0][0].lastRemediationAttempt).toBeInstanceOf(Date);

    // The error entry should be appended
    const errors = setCalls[0][0].remediationErrors;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({
      commandId: COMMAND_ID,
      softwareName: 'BadApp',
      message: 'Access denied',
      status: 'failed',
      exitCode: 1,
    });
  });

  it('does NOT schedule a compliance check on failure', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed', error: 'oops' }),
    );

    expect(mockScheduleSoftwareComplianceCheck).not.toHaveBeenCalled();
  });

  it('records audit entry with action remediation_command_failed on failure', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed', error: 'Access denied', exitCode: 1 }),
    );

    expect(mockRecordSoftwarePolicyAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        policyId: POLICY_ID,
        deviceId: DEVICE_ID,
        action: 'remediation_command_failed',
        actor: 'system',
        details: expect.objectContaining({
          commandId: COMMAND_ID,
          softwareName: 'BadApp',
          commandStatus: 'failed',
          exitCode: 1,
          error: 'Access denied',
        }),
      }),
    );
  });

  it('records remediation decision metric on failure', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed', error: 'err' }),
    );

    expect(mockRecordSoftwareRemediationDecision).toHaveBeenCalledWith(
      'command_result_failed',
    );
  });

  it('uses stderr when error is absent on failure', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([{ ...mockCompliance, remediationErrors: [] }]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed', stderr: 'stderr message' }),
    );

    const setCalls = mockSet.mock.calls;
    const errors = setCalls[0][0].remediationErrors;
    expect(errors[0].message).toBe('stderr message');
  });

  it('falls back to default message when neither error nor stderr is present', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([{ ...mockCompliance, remediationErrors: [] }]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed' }),
    );

    const setCalls = mockSet.mock.calls;
    const errors = setCalls[0][0].remediationErrors;
    expect(errors[0].message).toBe('Uninstall command failed');
  });

  it('appends to existing remediation errors', async () => {
    const existingError = {
      commandId: 'old-cmd',
      softwareName: 'BadApp',
      message: 'Previous failure',
      status: 'failed',
      exitCode: 2,
      failedAt: '2026-02-19T00:00:00Z',
    };

    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([{
        ...mockCompliance,
        remediationErrors: [existingError],
      }]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'failed', error: 'New failure' }),
    );

    const setCalls = mockSet.mock.calls;
    const errors = setCalls[0][0].remediationErrors;
    expect(errors.length).toBe(2);
    expect(errors[0]).toEqual(existingError);
    expect(errors[1].message).toBe('New failure');
  });

  // -----------------------------------------------------------------------
  // Timeout path (treated as non-completed)
  // -----------------------------------------------------------------------

  it('treats timeout status the same as failure', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([{ ...mockCompliance, remediationErrors: [] }]);

    await handleSoftwareRemediationCommandResult(
      makeCommand(),
      makeResult({ status: 'timeout' }),
    );

    const setCalls = mockSet.mock.calls;
    expect(setCalls[0][0].remediationStatus).toBe('failed');
    expect(mockScheduleSoftwareComplianceCheck).not.toHaveBeenCalled();
    expect(mockRecordSoftwareRemediationDecision).toHaveBeenCalledWith(
      'command_result_failed',
    );
  });

  // -----------------------------------------------------------------------
  // Edge: softwareName defaults to 'unknown' when missing
  // -----------------------------------------------------------------------

  it('uses "unknown" as softwareName when payload.name is missing', async () => {
    mockLimit
      .mockResolvedValueOnce([mockPolicy])
      .mockResolvedValueOnce([mockCompliance]);

    await handleSoftwareRemediationCommandResult(
      makeCommand({ payload: { policyId: POLICY_ID } }),
      makeResult({ status: 'completed' }),
    );

    expect(mockRecordSoftwarePolicyAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          softwareName: 'unknown',
        }),
      }),
    );
  });
});
