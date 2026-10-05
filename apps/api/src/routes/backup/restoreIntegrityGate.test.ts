import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRestoreIntegrity: vi.fn(),
  consumeStepUpGrant: vi.fn(),
  getUserEpochs: vi.fn(),
  recordRestoreAuthorization: vi.fn(),
  enable2fa: { value: true },
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../services/backupRestoreIntegrity', () => ({
  resolveRestoreIntegrity: mocks.resolveRestoreIntegrity,
}));
vi.mock('../../services/mfaStepUpGrant', () => ({
  consumeStepUpGrant: mocks.consumeStepUpGrant,
  unattestedRestoreResourceDigest: (t: { snapshotDbId: string; targetDeviceId: string; commandType: string }) =>
    `sha256:${t.snapshotDbId}:${t.targetDeviceId}:${t.commandType}`,
}));
vi.mock('../../services/authEpochs', () => ({ getUserEpochs: mocks.getUserEpochs }));
vi.mock('../../services/backupRestoreAuthorization', () => ({
  recordRestoreAuthorization: mocks.recordRestoreAuthorization,
}));
vi.mock('../auth/schemas', () => ({
  get ENABLE_2FA() {
    return mocks.enable2fa.value;
  },
}));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '203.0.113.7' }));

import { checkRestoreIntegrityRequest, gateRestoreCommand, recordRequestAuthorization } from './restoreIntegrityGate';
import { RESTORE_INTEGRITY_MESSAGES } from '../../services/backupRestoreGate';

const ORG = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const GRANT = '66666666-6666-4666-8666-666666666666';
const SNAP = 'snapshot-20261001T101500Z-0123456789abcdef01234567';

function ctx(auth: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {
    auth: { user: { id: USER, email: 'tech@example.com' }, token: { sid: 'sid-1' }, ...auth },
  };
  return {
    get: (k: string) => store[k],
    req: { header: (name: string) => (name.toLowerCase() === 'user-agent' ? 'vitest' : undefined) },
  } as any;
}

const request = (overrides: Record<string, unknown> = {}) => ({
  orgId: ORG,
  snapshotDbId: SNAPSHOT,
  targetDeviceId: SOURCE,
  commandType: 'backup_restore',
  ...overrides,
});

const attested = (trust = 'server_verified') => ({
  mode: 'attested', trust, snapshotId: SNAP, sourceDeviceId: SOURCE, objects: [],
});
const unattested = (reason: string) => ({ mode: 'unattested', snapshotId: SNAP, reason });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enable2fa.value = true;
  mocks.getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 5 });
});

describe('checkRestoreIntegrityRequest', () => {
  it('allows an attested snapshot without a step-up', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(attested());
    expect(await checkRestoreIntegrityRequest(ctx(), request())).toEqual({ ok: true, authorizationReason: null });
    expect(mocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('never asks for a step-up for read-only validation', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    expect(await checkRestoreIntegrityRequest(ctx(), request({ commandType: 'backup_verify' })))
      .toEqual({ ok: true, authorizationReason: null });
  });

  it('asks for a step-up bound to the exact restore when the snapshot is unattested', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    const out = await checkRestoreIntegrityRequest(ctx(), request());
    expect(out).toEqual({
      ok: false,
      status: 403,
      body: {
        error: RESTORE_INTEGRITY_MESSAGES.step_up_required,
        code: 'STEP_UP_REQUIRED',
        stepUp: {
          operation: 'backup_unattested_restore',
          method: 'mfa',
          reason: 'unattested_legacy',
          resource: { snapshotId: SNAPSHOT, targetDeviceId: SOURCE, commandType: 'backup_restore' },
        },
      },
    });
  });

  it('consumes a matching grant, bound to the user, session, epochs and the restore digest', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested'));
    mocks.consumeStepUpGrant.mockResolvedValue(true);
    const out = await checkRestoreIntegrityRequest(ctx(), request({ stepUpGrant: GRANT }));
    expect(out).toEqual({ ok: true, authorizationReason: 'unattested' });
    expect(mocks.consumeStepUpGrant).toHaveBeenCalledWith(GRANT, {
      userId: USER,
      operation: 'backup_unattested_restore',
      authEpoch: 3,
      mfaEpoch: 5,
      sid: 'sid-1',
      resourceDigest: `sha256:${SNAPSHOT}:${SOURCE}:backup_restore`,
    });
  });

  it('uses epochs the caller read in the request context instead of reading them again', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested'));
    mocks.consumeStepUpGrant.mockResolvedValue(true);
    const out = await checkRestoreIntegrityRequest(ctx(), request({ stepUpGrant: GRANT, userEpochs: { authEpoch: 7, mfaEpoch: 9 } }));
    expect(out).toEqual({ ok: true, authorizationReason: 'unattested' });
    expect(mocks.getUserEpochs).not.toHaveBeenCalled();
    expect(mocks.consumeStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({ authEpoch: 7, mfaEpoch: 9 }));
  });

  it('a grant that does not match (other restore, replayed, expired) is a step-up request again', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    mocks.consumeStepUpGrant.mockResolvedValue(false);
    const out = await checkRestoreIntegrityRequest(ctx(), request({ stepUpGrant: GRANT }));
    expect(out).toMatchObject({ ok: false, status: 403, body: { code: 'STEP_UP_REQUIRED' } });
  });

  it('a device-local snapshot restored onto its own device needs nothing; onto another device it needs a step-up', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(attested('producer_only'));
    expect(await checkRestoreIntegrityRequest(ctx(), request())).toEqual({ ok: true, authorizationReason: null });
    const out = await checkRestoreIntegrityRequest(ctx(), request({ targetDeviceId: OTHER }));
    expect(out).toMatchObject({
      ok: false,
      status: 403,
      body: { code: 'STEP_UP_REQUIRED', error: RESTORE_INTEGRITY_MESSAGES.producer_only_other_target, stepUp: { reason: 'producer_only_other_target' } },
    });
  });

  it.each([
    ['pending', 'attestation_pending'],
    ['attestation_failed', 'snapshot_integrity_failed'],
  ])('refuses a %s snapshot with a conflict, even with a grant', async (reason, code) => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested(reason));
    mocks.consumeStepUpGrant.mockResolvedValue(true);
    const out = await checkRestoreIntegrityRequest(ctx(), request({ stepUpGrant: GRANT }));
    expect(out).toMatchObject({ ok: false, status: 409, body: { code } });
    expect(mocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('refuses a snapshot that cannot be resolved', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(null);
    expect(await checkRestoreIntegrityRequest(ctx(), request())).toMatchObject({ ok: false, status: 409, body: { code: 'snapshot_unresolved' } });
  });

  it('a caller without an interactive session (API key) cannot confirm an unattested restore', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    const out = await checkRestoreIntegrityRequest(ctx({ token: undefined }), request({ stepUpGrant: GRANT }));
    expect(out).toMatchObject({ ok: false, status: 409, body: { code: 'snapshot_integrity_unavailable' } });
    expect(mocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('with two-factor authentication disabled on the deployment, an explicit confirmation stands in for the step-up', async () => {
    mocks.enable2fa.value = false;
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    expect(await checkRestoreIntegrityRequest(ctx(), request())).toMatchObject({
      ok: false, status: 403, body: { code: 'STEP_UP_REQUIRED', stepUp: { method: 'confirm' } },
    });
    expect(await checkRestoreIntegrityRequest(ctx(), request({ confirmUnattestedRestore: true })))
      .toEqual({ ok: true, authorizationReason: 'unattested_legacy' });
    expect(mocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('a confirmation flag alone is not enough while two-factor authentication is enabled', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    expect(await checkRestoreIntegrityRequest(ctx(), request({ confirmUnattestedRestore: true })))
      .toMatchObject({ ok: false, status: 403 });
  });
});

describe('recordRequestAuthorization', () => {
  it('records the authorization for the requesting user, bound as given, with request attribution', async () => {
    mocks.recordRestoreAuthorization.mockResolvedValue('auth-1');
    const id = await recordRequestAuthorization(ctx(), request(), 'unattested_legacy', { commandId: 'cmd-1' });
    expect(id).toBe('auth-1');
    expect(mocks.recordRestoreAuthorization).toHaveBeenCalledWith({
      orgId: ORG,
      snapshotDbId: SNAPSHOT,
      targetDeviceId: SOURCE,
      commandType: 'backup_restore',
      reason: 'unattested_legacy',
      userId: USER,
      userEmail: 'tech@example.com',
      binding: { commandId: 'cmd-1' },
      ipAddress: '203.0.113.7',
      userAgent: 'vitest',
    });
  });
});

describe('gateRestoreCommand', () => {
  it('an attested restore needs no reserved command id', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(attested());
    expect(await gateRestoreCommand(ctx(), request())).toEqual({ ok: true });
    expect(mocks.recordRestoreAuthorization).not.toHaveBeenCalled();
  });

  it('a confirmed restore reserves a command id and records the authorization bound to it', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    mocks.consumeStepUpGrant.mockResolvedValue(true);
    mocks.recordRestoreAuthorization.mockResolvedValue('auth-1');
    const out = await gateRestoreCommand(ctx(), request({ stepUpGrant: GRANT }));
    expect(out).toEqual({ ok: true, commandId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(mocks.recordRestoreAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'unattested_legacy',
      binding: { commandId: (out as { commandId: string }).commandId },
    }));
  });

  it('passes a refusal through', async () => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(unattested('unattested_legacy'));
    expect(await gateRestoreCommand(ctx(), request())).toMatchObject({ ok: false, status: 403 });
  });
});
