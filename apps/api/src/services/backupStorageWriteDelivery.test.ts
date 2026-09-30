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
import { CommandDeliveryDeferredError, CommandDeliveryRefusedError } from './commandDeliveryRefusal';
import { BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE } from './backupWriteHelperGate';

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

  it('refuses an older helper with the update message, never resolving the destination into the frame', async () => {
    m.mint.mockResolvedValue({ mode: 'unbrokered', reason: 'helper_unsupported' });
    const err = await deliverBackupWriteCommand(queued(), CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandDeliveryRefusedError);
    expect((err as Error).message).toBe(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(m.materialize).not.toHaveBeenCalled();
    expect(m.dispatch).toHaveBeenCalledWith('mssql_backup', 'refused', 'helper_unsupported');
    expect(m.dispatch).not.toHaveBeenCalledWith('mssql_backup', 'legacy_credential', expect.anything());
  });

  it.each([
    ['insecure_endpoint', /storage endpoint to use HTTPS/],
    ['server_origin_mismatch', /PUBLIC_API_URL/],
    ['server_origin_unavailable', /PUBLIC_API_URL/],
    ['insecure_server_origin', /over HTTPS/],
    ['device_org_mismatch', /no longer belongs/],
    ['job_not_live', /already finished/],
  ])('refuses when no write session can be issued (%s)', async (reason, message) => {
    m.mint.mockResolvedValue({ mode: 'unbrokered', reason });
    const err = await deliverBackupWriteCommand(queued(), CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandDeliveryRefusedError);
    expect((err as Error).message).toMatch(message);
    expect(m.materialize).not.toHaveBeenCalled();
  });

  it.each([
    ['the destination is no longer S3', () => m.resolveDestination.mockResolvedValue({ ok: true, destination: { provider: 'local', providerConfig: { path: '/x' }, storageEncryption: PLAN } }), /changed provider/],
    ['the encryption plan changed', () => m.resolveDestination.mockResolvedValue({ ok: true, destination: { provider: 's3', providerConfig: S3, storageEncryption: { required: true, mode: 's3-sse-s3', keyReference: null } } }), /encryption settings changed/],
    ['the destination is gone', () => m.resolveDestination.mockResolvedValue({ ok: false, reason: 'config_not_found', message: 'Backup destination configuration not found for this snapshot' }), /can no longer be used/],
  ])('refuses when %s', async (_name, arrange, message) => {
    arrange();
    const err = await deliverBackupWriteCommand(queued(), CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandDeliveryRefusedError);
    expect((err as Error).message).toMatch(message);
    expect(m.mint).not.toHaveBeenCalled();
    expect(m.materialize).not.toHaveBeenCalled();
  });

  it('releases the command for a later attempt (not a refusal, not a fallback) when issuing the session fails', async () => {
    m.mint.mockRejectedValueOnce(new Error('db unavailable'));
    const err = await deliverBackupWriteCommand(queued(), CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(err).not.toBeInstanceOf(CommandDeliveryDeferredError);
    expect(m.materialize).not.toHaveBeenCalled();
  });

  it.each([
    ['another provider', queued({ provider: 'b2' }), /no longer support/],
    ['a command without a job id', (() => { const { jobId: _j, ...p } = queued(); return p; })(), /not linked to a backup job/],
    ['a command without a reference', (() => { const { providerConfigRef: _p, ...p } = queued(); return p; })(), /Start it again/],
    ['a malformed reference', queued({ providerConfigRef: { configId: 'x', orgId: ORG } }), /Start it again/],
    ['a destination carried inline', (() => { const { providerConfigRef: _p, ...p } = queued(); return { ...p, providerConfig: S3 }; })(), /earlier version of Breeze/],
    ['a sealed inline destination', (() => { const { providerConfigRef: _p, ...p } = queued(); return { ...p, providerConfigEnvelope: 'enc' }; })(), /earlier version of Breeze/],
  ])('refuses %s, never minting and never delivering a destination', async (_name, payload, message) => {
    const err = await deliverBackupWriteCommand(payload, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandDeliveryRefusedError);
    expect((err as Error).message).toMatch(message);
    expect(m.mint).not.toHaveBeenCalled();
    expect(m.materialize).not.toHaveBeenCalled();
  });

  it('delivers a local destination queued with its path inline (a path, not a credential)', async () => {
    const { providerConfigRef: _r, ...rest } = queued({ provider: 'local' });
    const inline = { ...rest, providerConfig: { path: '/backups' } };
    const out = await deliverBackupWriteCommand(inline, CTX);
    expect(out).toMatchObject({ materialized: true });
    expect(m.materialize).toHaveBeenCalledWith(inline, CTX);
    expect(m.mint).not.toHaveBeenCalled();
  });

  it('never delivers a backup_run row carrying an S3 destination', async () => {
    const { providerConfigRef: _r, ...rest } = queued();
    const err = await deliverBackupWriteCommand(
      { ...rest, providerConfig: S3 },
      { ...CTX, type: 'backup_run' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandDeliveryRefusedError);
    expect(m.materialize).not.toHaveBeenCalled();
    expect(m.mint).not.toHaveBeenCalled();
  });

  it('delivers a local destination through the destination refresher (a path, not a credential)', async () => {
    const out = await deliverBackupWriteCommand(queued({ provider: 'local' }), CTX);
    expect(out).toMatchObject({ materialized: true });
    expect(m.mint).not.toHaveBeenCalled();
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

    it('refuses once the device has reported an older helper', async () => {
      m.storedWriteProtocol.mockResolvedValueOnce(0);
      m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unsupported' });
      await expect(deliverBackupWriteCommand(queued(), NO_REPORT)).rejects.toThrow(BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE);
      expect(m.materialize).not.toHaveBeenCalled();
    });
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
    if (out.mode !== 'brokered') throw new Error('expected a payload');
    expect(out.payload).not.toHaveProperty('providerConfig');
    expect(out.payload).toMatchObject({ storageSession: ENVELOPE, provider: 's3', paths: ['/data'], storageEncryption: PLAN });
    expect(m.mint).toHaveBeenCalledWith(expect.objectContaining({ baseManifestKey: 'snapshots/snapshot-base/manifest.json' }));
  });

  it('refuses, with no payload at all, when the helper or the destination cannot be brokered', async () => {
    m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'helper_unsupported' });
    const a = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: null,
    });
    expect(a).toEqual({ mode: 'refused', reason: 'helper_unsupported', message: BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE });
    m.mint.mockResolvedValueOnce({ mode: 'unbrokered', reason: 'insecure_endpoint' });
    const b = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: null,
    });
    expect(b).toMatchObject({ mode: 'refused', reason: 'insecure_endpoint' });
    for (const out of [a, b]) expect(out).not.toHaveProperty('payload');
  });

  it('asks the worker to try again, with no payload, when issuing the session fails (a transient failure)', async () => {
    m.mint.mockRejectedValueOnce(new Error('db down'));
    const out = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 's3', providerConfig: S3, payload, baseSnapshotId: null,
    });
    expect(out).toEqual({ mode: 'retry', reason: 'mint_failed' });
  });

  it('refuses any provider other than S3 or local', async () => {
    const out = await brokerWorkerBackupPayload({
      orgId: ORG, jobId: JOB, deviceId: DEVICE, configId: CONFIG, commandType: 'backup_run',
      provider: 'azure_blob', providerConfig: { accountKey: 'k' }, payload, baseSnapshotId: null,
    });
    expect(out).toMatchObject({ mode: 'refused', reason: 'provider_not_s3' });
    expect(m.mint).not.toHaveBeenCalled();
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
