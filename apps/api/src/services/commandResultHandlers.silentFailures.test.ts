import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3530: the transports now run these handlers inside the transaction that
// holds the command's terminal compare-and-set. A persistence failure must
// therefore PROPAGATE — a swallowed one would commit the command as
// "completed" with its feature record missing, which is the bug. Logging and
// Sentry capture happen once, at the transport.
const { captureExceptionMock, selectMock, updateMock, helpers, persistence } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  helpers: {
    handleSensitiveDataCommandResult: vi.fn(),
    handleCisCommandResult: vi.fn(),
  },
  persistence: {
    processBackupVerificationResult: vi.fn(),
    updateRestoreJobByCommandId: vi.fn(),
    applyRebuildCommandResult: vi.fn(),
    applyBackupCommandResultToJob: vi.fn(),
    applyVaultSyncCommandResult: vi.fn(),
    applyScriptCancelAck: vi.fn(),
  },
}));
vi.mock('./sentry', () => ({ captureException: (...a: unknown[]) => captureExceptionMock(...a) }));
vi.mock('../routes/agents/helpers', () => helpers);
vi.mock('../routes/backup/verificationService', () => ({
  processBackupVerificationResult: (...a: unknown[]) => persistence.processBackupVerificationResult(...a),
}));
vi.mock('./restoreResultPersistence', () => ({
  updateRestoreJobByCommandId: (...a: unknown[]) => persistence.updateRestoreJobByCommandId(...a),
}));
vi.mock('./bareMetalRecoveryService', () => ({
  applyRebuildCommandResult: (...a: unknown[]) => persistence.applyRebuildCommandResult(...a),
}));
vi.mock('./backupResultPersistence', () => ({
  applyBackupCommandResultToJob: (...a: unknown[]) => persistence.applyBackupCommandResultToJob(...a),
}));
vi.mock('./vaultSyncPersistence', () => ({
  applyVaultSyncCommandResult: (...a: unknown[]) => persistence.applyVaultSyncCommandResult(...a),
}));
vi.mock('./scriptCancellation', () => ({
  applyScriptCancelAck: (...a: unknown[]) => persistence.applyScriptCancelAck(...a),
}));
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, db: { ...actual.db, select: selectMock, update: updateMock }, runOutsideDbContext: (fn: () => unknown) => fn() };
});
vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn(() => Promise.reject(new Error('redis down'))) }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn(() => Promise.reject(new Error('redis down'))) }));
vi.mock('./redis', () => ({ isRedisAvailable: vi.fn(() => true), getRedis: vi.fn(() => null) }));
import { commandResultHandlers, type CommandResultHandler } from './commandResultHandlers';

const CMD_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const RECOVERY_ID = '66666666-6666-4666-8666-666666666666';
function input(type: string, payload: Record<string, unknown> = {}, result: Record<string, unknown> = {}): Parameters<CommandResultHandler>[0] {
  return {
    agentId: 'agent-1', commandId: CMD_ID,
    command: { id: CMD_ID, type, payload, submittedOrgId: 'org-1' } as never,
    resolvedDeviceId: 'dev-1', result: { status: 'completed', ...result } as never, stdout: '{}',
  };
}

function selectReturning(rows: unknown[]) {
  selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });
}

describe('result handlers propagate persistence failures (#3530)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each(['sensitive_data_scan', 'encrypt_file', 'secure_delete_file', 'quarantine_file'])('%s', async (type) => {
    const boom = new Error('persist failed');
    helpers.handleSensitiveDataCommandResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers[type]!(input(type))).rejects.toBe(boom);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it.each(['cis_benchmark', 'apply_cis_remediation'])('%s', async (type) => {
    const boom = new Error('persist failed');
    helpers.handleCisCommandResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers[type]!(input(type))).rejects.toBe(boom);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it.each(['backup_verify', 'backup_test_restore'])('%s', async (type) => {
    const boom = new Error('persist failed');
    persistence.processBackupVerificationResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers[type]!(input(type))).rejects.toBe(boom);
  });

  it.each(['backup_restore', 'vm_restore_from_backup', 'vm_instant_boot', 'bmr_recover', 'mssql_restore', 'hyperv_restore'])(
    '%s',
    async (type) => {
      const boom = new Error('persist failed');
      persistence.updateRestoreJobByCommandId.mockRejectedValueOnce(boom);
      await expect(commandResultHandlers[type]!(input(type))).rejects.toBe(boom);
    },
  );

  it('bare_metal_rebuild: a restore-job failure propagates', async () => {
    const boom = new Error('persist failed');
    persistence.updateRestoreJobByCommandId.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers.bare_metal_rebuild!(input('bare_metal_rebuild', { recoveryId: RECOVERY_ID }))).rejects.toBe(boom);
  });

  it('bare_metal_rebuild: a recovery-row failure propagates', async () => {
    const boom = new Error('persist failed');
    persistence.updateRestoreJobByCommandId.mockResolvedValueOnce(true);
    persistence.applyRebuildCommandResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers.bare_metal_rebuild!(input('bare_metal_rebuild', { recoveryId: RECOVERY_ID }))).rejects.toBe(boom);
  });

  it.each(['hyperv_backup', 'mssql_backup'])('%s', async (type) => {
    const boom = new Error('persist failed');
    selectReturning([{ id: JOB_ID, orgId: 'org-1', deviceId: 'dev-1' }]);
    persistence.applyBackupCommandResultToJob.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers[type]!(input(type, { backupJobId: JOB_ID }))).rejects.toBe(boom);
  });

  it('vault_sync', async () => {
    const boom = new Error('persist failed');
    persistence.applyVaultSyncCommandResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers.vault_sync!(input('vault_sync'))).rejects.toBe(boom);
  });

  it('snmp_poll: a metrics enqueue failure propagates', async () => {
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    await expect(commandResultHandlers.snmp_poll!(input(
      'snmp_poll',
      { deviceId: JOB_ID },
      { result: { deviceId: JOB_ID, metrics: [{ oid: '1.3.6', value: 1 }] } },
    ))).rejects.toThrow('redis down');
  });

  it('script_cancel', async () => {
    const boom = new Error('persist failed');
    persistence.applyScriptCancelAck.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers.script_cancel!(input('script_cancel'))).rejects.toBe(boom);
  });

  it('script: a script_executions write failure propagates', async () => {
    const boom = new Error('persist failed');
    updateMock.mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.reject(boom) }) }),
    });
    await expect(commandResultHandlers.script!(input(
      'script',
      { executionId: JOB_ID },
    ))).rejects.toBe(boom);
  });

  it('network_discovery: still records the failure on the job itself when the enqueue fails', async () => {
    selectReturning([{ orgId: 'o', siteId: 's' }]);
    const setSpy = vi.fn(() => ({ where: () => Promise.resolve([]) }));
    updateMock.mockReturnValue({ set: setSpy });
    await expect(commandResultHandlers.network_discovery!(
      input('network_discovery', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [] } }),
    )).resolves.toBeUndefined();
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('network_discovery: failing to mark the job failed propagates', async () => {
    selectReturning([{ orgId: 'o', siteId: 's' }]);
    const markErr = new Error('db unavailable');
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.reject(markErr) }) });
    await expect(commandResultHandlers.network_discovery!(
      input('network_discovery', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [] } }),
    )).rejects.toBe(markErr);
  });
});
