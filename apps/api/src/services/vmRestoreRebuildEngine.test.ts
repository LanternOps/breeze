import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const RECOVERY_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_ID = '44444444-4444-4444-8444-444444444444';
const RESTORE_JOB_ID = '99999999-9999-4999-8999-999999999999';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  createBareMetalRecovery: vi.fn(),
  mintRecoveryTokenForRecovery: vi.fn(),
  cancelBareMetalRecovery: vi.fn(),
  queueBareMetalRebuild: vi.fn(),
  recordBackupDispatchFailure: vi.fn(),
}));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => mocks.select(...args),
    insert: (...args: unknown[]) => mocks.insert(...args),
    update: (...args: unknown[]) => mocks.update(...args),
  },
}));

vi.mock('./bareMetalRecoveryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bareMetalRecoveryService')>();
  return {
    ...actual,
    createBareMetalRecovery: (...args: unknown[]) => mocks.createBareMetalRecovery(...args),
    mintRecoveryTokenForRecovery: (...args: unknown[]) => mocks.mintRecoveryTokenForRecovery(...args),
    cancelBareMetalRecovery: (...args: unknown[]) => mocks.cancelBareMetalRecovery(...args),
  };
});

vi.mock('./bareMetalRebuildCommand', () => ({
  queueBareMetalRebuild: (...args: unknown[]) => mocks.queueBareMetalRebuild(...args),
}));

vi.mock('./recoveryBootstrap', () => ({
  resolveServerUrl: vi.fn(() => 'https://api.example.test'),
}));

vi.mock('./backupMetrics', () => ({
  recordBackupDispatchFailure: (...args: unknown[]) => mocks.recordBackupDispatchFailure(...args),
}));

import { startRebuildEngineVmRestore, type RebuildEngineVmRestoreInput } from './vmRestoreRebuildEngine';

const input: RebuildEngineVmRestoreInput = {
  orgId: ORG_ID,
  snapshotId: SNAPSHOT_ID,
  rebuildHostDeviceId: HOST_ID,
  outputPath: '/srv/rebuild/dev-1.vhdx',
  userId: 'user-1',
  integrity: async () => ({ ok: true }),
};

function snapshotRow(layoutManifest: unknown) {
  return chainMock([{ id: SNAPSHOT_ID, deviceId: DEVICE_ID, layoutManifest, bareMetalRestorable: true }]);
}

function hostRow(osType: string, status = 'online') {
  return chainMock([{ id: HOST_ID, status, osType }]);
}

function mockRowsAndQueue() {
  mocks.createBareMetalRecovery.mockResolvedValue({ row: { id: RECOVERY_ID }, code: 'ABC-DEF-GHJ' });
  mocks.mintRecoveryTokenForRecovery.mockResolvedValue({ token: 'plaintext-token', tokenId: TOKEN_ID });
  mocks.insert.mockReturnValueOnce(chainMock([{ id: RESTORE_JOB_ID }]));
  mocks.update.mockReturnValue(chainMock([]));
  mocks.queueBareMetalRebuild.mockResolvedValue({ command: { id: COMMAND_ID, status: 'sent' }, error: null });
}

describe('startRebuildEngineVmRestore — host/platform matching (W06d)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReset();
    mocks.insert.mockReset();
    mocks.update.mockReset();
  });

  // R31
  it('refuses with rebuild_host_unsupported when host osType does not match the snapshot platform', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'windows', disks: [] }))
      .mockReturnValueOnce(hostRow('linux'));

    const result = await startRebuildEngineVmRestore(input);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'rebuild_host_unsupported',
      details: { osType: 'linux', snapshotPlatform: 'windows' },
    });
    expect(mocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(mocks.queueBareMetalRebuild).not.toHaveBeenCalled();
  });

  it('refuses a macOS host for a Linux snapshot', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'linux', disks: [] }))
      .mockReturnValueOnce(hostRow('macos'));

    const result = await startRebuildEngineVmRestore(input);

    expect(result).toMatchObject({ ok: false, status: 409, error: 'rebuild_host_unsupported', details: { osType: 'macos', snapshotPlatform: 'linux' } });
  });

  it('refuses with snapshot_not_bare_metal_restorable when the layout has no platform, before any host lookup', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ schemaVersion: 1, disks: [] }))
      .mockReturnValueOnce(hostRow('linux'));

    const result = await startRebuildEngineVmRestore(input);

    expect(result).toMatchObject({ ok: false, status: 409, error: 'snapshot_not_bare_metal_restorable' });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.createBareMetalRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ['a POSIX path on a Windows host', 'windows', '/srv/rebuild/dev-1.vhdx'],
    ['a drive-letter path on a Linux host', 'linux', 'C:\\Rebuild\\dev-1.vhdx'],
  ])('refuses %s with 400 output_path_host_mismatch before creating rows', async (_label, os, outputPath) => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: os, disks: [] }))
      .mockReturnValueOnce(hostRow(os));

    const result = await startRebuildEngineVmRestore({ ...input, outputPath });

    expect(result).toMatchObject({ ok: false, status: 400, error: 'output_path_host_mismatch' });
    expect(mocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(mocks.queueBareMetalRebuild).not.toHaveBeenCalled();
  });

  // R34
  it('rejects a hyperv block targeting a non-Windows host with 400', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'linux', disks: [] }))
      .mockReturnValueOnce(hostRow('linux'));

    const result = await startRebuildEngineVmRestore({ ...input, hyperv: { vmName: 'x' } });

    expect(result).toMatchObject({ ok: false, status: 400, error: 'hyperv_requires_windows_host' });
    expect(result.ok === false && result.message).toMatch(/^hyperv is only valid for Windows rebuild hosts/);
    expect(mocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(mocks.queueBareMetalRebuild).not.toHaveBeenCalled();
  });

  it('accepts a matching Windows host with an optional hyperv block and forwards it on the command payload', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'windows', disks: [] }))
      .mockReturnValueOnce(hostRow('windows'));
    mockRowsAndQueue();
    const outputPath = 'C:\\ProgramData\\Breeze\\rebuild\\out\\dev-1.vhdx';

    const result = await startRebuildEngineVmRestore({
      ...input,
      outputPath,
      hyperv: { vmName: 'w06-proof', switchName: 'lab-switch' },
    });

    expect(result).toEqual({ ok: true, jobId: RESTORE_JOB_ID, recoveryId: RECOVERY_ID, commandId: COMMAND_ID, status: 'queued' });
    expect(mocks.createBareMetalRecovery).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'new', source: 'vm_restore', executingDeviceId: HOST_ID,
    }));
    expect(mocks.queueBareMetalRebuild).toHaveBeenCalledWith({
      orgId: ORG_ID,
      hostDeviceId: HOST_ID,
      userId: 'user-1',
      payload: {
        recoveryId: RECOVERY_ID,
        token: 'plaintext-token',
        server: 'https://api.example.test',
        target: { kind: 'vhdx', path: outputPath },
        identity: 'new',
        hyperv: { vmName: 'w06-proof', switchName: 'lab-switch' },
      },
    });
    // The restore job records the VM request so the UI/history can show it.
    const insertChain = mocks.insert.mock.results[0]!.value;
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
      targetConfig: expect.objectContaining({ outputPath, hyperv: { vmName: 'w06-proof', switchName: 'lab-switch' } }),
    }));
  });

  it('accepts a matching Windows host without hyperv and sends no hyperv key', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'windows', disks: [] }))
      .mockReturnValueOnce(hostRow('windows'));
    mockRowsAndQueue();

    const result = await startRebuildEngineVmRestore({ ...input, outputPath: 'D:\\out\\dev-1.vhdx' });

    expect(result.ok).toBe(true);
    const payload = mocks.queueBareMetalRebuild.mock.calls[0]![0].payload;
    expect('hyperv' in payload).toBe(false);
  });

  it('keeps the Linux-on-Linux path working unchanged', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'linux', disks: [] }))
      .mockReturnValueOnce(hostRow('linux'));
    mockRowsAndQueue();

    const result = await startRebuildEngineVmRestore({ ...input, imageSizeGb: 2 });

    expect(result.ok).toBe(true);
    expect(mocks.queueBareMetalRebuild.mock.calls[0]![0].payload.target).toEqual({
      kind: 'vhdx', path: '/srv/rebuild/dev-1.vhdx', imageSizeBytes: 2 * 1024 ** 3,
    });
  });

  it('checks the platform match before the host online state', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'windows', disks: [] }))
      .mockReturnValueOnce(hostRow('linux', 'offline'));

    const result = await startRebuildEngineVmRestore(input);

    expect(result).toMatchObject({ ok: false, status: 409, error: 'rebuild_host_unsupported' });
    expect(mocks.recordBackupDispatchFailure).not.toHaveBeenCalled();
  });

  it('still refuses an offline matching host with the device-state message', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'windows', disks: [] }))
      .mockReturnValueOnce(hostRow('windows', 'offline'));

    const result = await startRebuildEngineVmRestore({ ...input, outputPath: 'C:\\Rebuild\\dev-1.vhdx' });

    expect(result).toEqual({ ok: false, status: 409, error: 'Device is offline, cannot execute command' });
  });

  it('returns 404 when the rebuild host is not in the org', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'linux', disks: [] }))
      .mockReturnValueOnce(chainMock([]));

    const result = await startRebuildEngineVmRestore(input);

    expect(result).toEqual({ ok: false, status: 404, error: 'rebuild_host_not_found' });
  });
});

describe('startRebuildEngineVmRestore — snapshot integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReset();
    mocks.insert.mockReset();
    mocks.update.mockReset();
  });

  it('asks the caller to decide integrity for the snapshot being rebuilt, and creates nothing when it refuses', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'linux', disks: [] }))
      .mockReturnValueOnce(hostRow('linux'));
    const integrity = vi.fn(async () => ({
      ok: false as const, status: 403 as const, body: { code: 'STEP_UP_REQUIRED', error: 'confirm' },
    }));
    const result = await startRebuildEngineVmRestore({ ...input, integrity });
    expect(integrity).toHaveBeenCalledWith({ id: SNAPSHOT_ID, deviceId: DEVICE_ID });
    expect(result).toEqual({ ok: false, status: 403, error: 'STEP_UP_REQUIRED', body: { code: 'STEP_UP_REQUIRED', error: 'confirm' } });
    expect(mocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(mocks.queueBareMetalRebuild).not.toHaveBeenCalled();
  });

  it('binds a confirmed authorization to the recovery before the rebuild command is queued', async () => {
    mocks.select
      .mockReturnValueOnce(snapshotRow({ platform: 'linux', disks: [] }))
      .mockReturnValueOnce(hostRow('linux'));
    mockRowsAndQueue();
    const bindRecovery = vi.fn(async () => undefined);
    const result = await startRebuildEngineVmRestore({ ...input, integrity: async () => ({ ok: true, bindRecovery }) });
    expect(result.ok).toBe(true);
    expect(bindRecovery).toHaveBeenCalledWith(RECOVERY_ID);
    expect(bindRecovery.mock.invocationCallOrder[0]).toBeLessThan(mocks.queueBareMetalRebuild.mock.invocationCallOrder[0]!);
  });
});
