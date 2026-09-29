import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  mint: vi.fn(),
  storedWriteProtocol: vi.fn(),
  materialize: vi.fn(),
  resolveDestination: vi.fn(),
  dispatch: vi.fn(),
  hasContext: vi.fn(() => true),
}));

vi.mock('./backupStorageWriteSessions', () => ({
  mintBackupWriteSession: m.mint,
  loadStoredBackupWriteProtocol: m.storedWriteProtocol,
}));
vi.mock('./backupCommandCredentials', () => ({
  PROVIDER_CONFIG_REF_FIELD: 'providerConfigRef',
  materializeBackupStorageCredentials: m.materialize,
}));
vi.mock('./backupProviderConfig', () => ({ resolveBackupWriteCommandDestination: m.resolveDestination }));
vi.mock('./backupMetrics', () => ({ recordBackupWriteDispatch: m.dispatch }));
vi.mock('../db', () => ({
  hasDbAccessContext: m.hasContext,
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

import { brokerWorkerBackupPayload, deliverBackupWriteCommand } from './backupStorageWriteDelivery';
import { CommandDeliveryDeferredError } from './commandDeliveryRefusal';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONFIG = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const S3 = { bucket: 'b', region: 'us-east-1', endpoint: 'https://storage.example', accessKey: 'AK', secretKey: 'SK' };
const PLAN = { required: false, mode: 'disabled' };
const ENVELOPE = { version: 1, scope: 'snapshot_write', sessionId: 's', token: 't', snapshotId: 'snapshot-x' };
const CTX = { commandId: 'c', deviceId: DEVICE, type: 'mssql_backup', claimedAt: null, reportedBackupWriteProtocolVersion: 1 };

function queued(extra: Record<string, unknown> = {}) {
  return {
    jobId: JOB,
    configId: CONFIG,
    provider: 's3',
    storageEncryption: PLAN,
    providerConfigRef: { configId: CONFIG, orgId: ORG },
    instance: 'MSSQLSERVER',
    database: 'db1',
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveDestination.mockResolvedValue({ ok: true, destination: { provider: 's3', providerConfig: S3, storageEncryption: PLAN } });
  m.mint.mockResolvedValue({ mode: 'brokered', envelope: ENVELOPE, snapshotId: 'snapshot-x', sessionId: 's' });
  m.materialize.mockImplementation(async (p: Record<string, unknown>) => ({ ...p, providerConfig: S3, materialized: true }));
  m.storedWriteProtocol.mockResolvedValue(0);
});

describe('deliverBackupWriteCommand (delivery refresher for mssql_backup / hyperv_backup)', () => {
  it('delivers a write session and no storage destination to a capable helper', async () => {
    const out = await deliverBackupWriteCommand(queued(), CTX);
    expect(out.storageSession).toEqual(ENVELOPE);
    expect(out).not.toHaveProperty('providerConfig');
    expect(out).not.toHaveProperty('providerConfigRef');
    expect(out).toMatchObject({ provider: 's3', storageEncryption: PLAN, database: 'db1', jobId: JOB });
    expect(m.mint).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, baseManifestKey: null, reportedWriteProtocolVersion: 1,
    }));
    expect(m.dispatch).toHaveBeenCalledWith('mssql_backup', 'brokered', 'ok');
    expect(m.materialize).not.toHaveBeenCalled();
  });

  it('accepts the job id under backupJobId (AI tool queue shape)', async () => {
    const { jobId: _j, ...rest } = queued();
    await deliverBackupWriteCommand({ ...rest, backupJobId: JOB }, CTX);
    expect(m.mint).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB }));
  });

  it.each([
    ['an incapable helper', () => m.mint.mockResolvedValue({ mode: 'unbrokered', reason: 'helper_unsupported' })],
    ['a local destination', () => m.resolveDestination.mockResolvedValue({ ok: true, destination: { provider: 'local', providerConfig: { path: '/x' }, storageEncryption: PLAN } })],
    ['a changed encryption plan', () => m.resolveDestination.mockResolvedValue({ ok: true, destination: { provider: 's3', providerConfig: S3, storageEncryption: { required: true, mode: 's3-sse-s3', keyReference: null } } })],
  ])('falls back to today\'s delivery for %s', async (_name, arrange) => {
    arrange();
    const out = await deliverBackupWriteCommand(queued(), CTX);
    expect(out).toMatchObject({ materialized: true });
    expect(out).not.toHaveProperty('storageSession');
  });

  it('falls back as before, with a counted reason, when issuing the session fails', async () => {
    m.mint.mockRejectedValueOnce(new Error('db unavailable'));
    const out = await deliverBackupWriteCommand(queued(), CTX);
    expect(out).toMatchObject({ materialized: true });
    expect(m.materialize).toHaveBeenCalledWith(expect.anything(), CTX, { legacyReason: 'mint_failed' });
  });

  it('hands the reason a delivery was not brokered to the destination refresher', async () => {
    m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unsupported' });
    await deliverBackupWriteCommand(queued(), CTX);
    expect(m.materialize).toHaveBeenCalledWith(expect.anything(), CTX, { legacyReason: 'helper_unsupported' });
    const { jobId: _j, ...noJob } = queued();
    await deliverBackupWriteCommand(noJob, CTX);
    expect(m.materialize).toHaveBeenLastCalledWith(expect.anything(), CTX, { legacyReason: 'no_job' });
  });

  describe('a device that has not reported its helper protocols yet', () => {
    const { reportedBackupWriteProtocolVersion: _r, ...NO_REPORT } = CTX;

    it.each([
      ['an S3 destination', queued()],
      ['another provider', queued({ provider: 'b2' })],
      ['a command without a job id', (() => { const { jobId: _j, ...p } = queued(); return p; })()],
      ['a command without a reference', (() => { const { providerConfigRef: _p, ...p } = queued(); return p; })()],
    ])('defers %s, never resolving its destination', async (_name, payload) => {
      m.storedWriteProtocol.mockResolvedValueOnce(null);
      await expect(deliverBackupWriteCommand(payload, NO_REPORT)).rejects.toBeInstanceOf(CommandDeliveryDeferredError);
      expect(m.materialize).not.toHaveBeenCalled();
      expect(m.mint).not.toHaveBeenCalled();
      expect(m.dispatch).toHaveBeenCalledWith('mssql_backup', 'deferred', 'helper_unreported');
    });

    it('reads the stored protocol in the referenced organization', async () => {
      m.storedWriteProtocol.mockResolvedValueOnce(null);
      await expect(deliverBackupWriteCommand(queued(), NO_REPORT)).rejects.toBeInstanceOf(CommandDeliveryDeferredError);
      expect(m.storedWriteProtocol).toHaveBeenCalledWith(DEVICE, ORG);
    });

    it('defers, outside the fallback, when the mint finds the report withdrawn', async () => {
      m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unreported' });
      await expect(deliverBackupWriteCommand(queued(), CTX)).rejects.toBeInstanceOf(CommandDeliveryDeferredError);
      expect(m.materialize).not.toHaveBeenCalled();
    });

    it('still delivers a local destination, which is a path and not a credential', async () => {
      m.storedWriteProtocol.mockResolvedValue(null);
      const out = await deliverBackupWriteCommand(queued({ provider: 'local' }), NO_REPORT);
      expect(out).toMatchObject({ materialized: true });
      expect(m.storedWriteProtocol).not.toHaveBeenCalled();
    });

    it('lets this heartbeat\'s report decide without reading the stored value', async () => {
      await deliverBackupWriteCommand(queued(), { ...NO_REPORT, reportedBackupWriteProtocolVersion: 0 });
      expect(m.storedWriteProtocol).not.toHaveBeenCalled();
      expect(m.mint).toHaveBeenCalled();
    });

    it('delivers as before once the device has reported an older helper', async () => {
      m.storedWriteProtocol.mockResolvedValueOnce(0);
      m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unsupported' });
      const out = await deliverBackupWriteCommand(queued(), NO_REPORT);
      expect(out).toMatchObject({ materialized: true });
    });
  });

  it('falls back without a job id or a reference, never minting', async () => {
    const { jobId: _j, ...noJob } = queued();
    await deliverBackupWriteCommand(noJob, CTX);
    const { providerConfigRef: _r, ...noRef } = queued();
    await deliverBackupWriteCommand(noRef, CTX);
    expect(m.mint).not.toHaveBeenCalled();
    expect(m.materialize).toHaveBeenCalledTimes(2);
  });
});

describe('brokerWorkerBackupPayload (scheduled backups)', () => {
  const payload = { jobId: JOB, configId: CONFIG, provider: 's3', providerConfig: S3, storageEncryption: PLAN, paths: ['/data'], baseSnapshotId: 'snapshot-base' };

  it('replaces the destination with a write session bound to the server-selected base', async () => {
    const out = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: 'snapshot-base',
    });
    expect(out.mode).toBe('brokered');
    if (out.mode === 'held') throw new Error('expected a payload');
    expect(out.payload).not.toHaveProperty('providerConfig');
    expect(out.payload).toMatchObject({ storageSession: ENVELOPE, provider: 's3', paths: ['/data'], storageEncryption: PLAN });
    expect(m.mint).toHaveBeenCalledWith(expect.objectContaining({ baseManifestKey: 'snapshots/snapshot-base/manifest.json' }));
  });

  it('keeps today\'s payload when the helper cannot broker, or minting fails', async () => {
    m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unsupported' });
    const a = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: null,
    });
    expect(a).toEqual({ mode: 'legacy', reason: 'helper_unsupported', payload });
    m.mint.mockRejectedValueOnce(new Error('db down'));
    const b = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: null,
    });
    expect(b).toEqual({ mode: 'legacy', reason: 'mint_failed', payload });
  });

  it('holds a backup, with no payload at all, for a device that has not reported its helper protocols', async () => {
    m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unreported' });
    const out = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: null,
    });
    expect(out).toEqual({ mode: 'held', reason: 'helper_unreported' });
  });

  it('never brokers a local destination', async () => {
    const out = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 'local', providerConfig: { path: '/x' }, payload, baseSnapshotId: null,
    });
    expect(out.mode).toBe('local');
    expect(m.mint).not.toHaveBeenCalled();
  });
});
