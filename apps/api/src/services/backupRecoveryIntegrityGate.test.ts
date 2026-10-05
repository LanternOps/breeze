import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  RECOVERY_CLIENT_UPDATE_REQUIRED_MESSAGE,
  evaluateRecoveryIntegrity,
  type RecoveryIntegrityDeps,
} from './backupRecoveryIntegrityGate';
import { RESTORE_INTEGRITY_MESSAGES } from './backupRestoreGate';
import type { RestoreIntegrity } from './backupRestoreIntegrity';

const SNAPSHOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const RECOVERY = '55555555-5555-4555-8555-555555555555';
const AUTH = '66666666-6666-4666-8666-666666666666';
const SNAP = 'snapshot-20261001T101500Z-0123456789abcdef01234567';

const attested: RestoreIntegrity = {
  mode: 'attested', trust: 'server_verified', snapshotId: SNAP, sourceDeviceId: DEVICE,
  objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: 'a'.repeat(64), size: 1 }],
};

function deps(overrides: Partial<RecoveryIntegrityDeps> = {}) {
  return {
    resolve: vi.fn(async () => attested as RestoreIntegrity | null),
    findAuthorizations: vi.fn(async () => [] as Awaited<ReturnType<RecoveryIntegrityDeps['findAuthorizations']>>),
    recordIntegrity: vi.fn(),
    ...overrides,
  } satisfies RecoveryIntegrityDeps;
}

const input = (overrides: Record<string, unknown> = {}) => ({
  snapshotDbId: SNAPSHOT,
  targetDeviceId: DEVICE,
  clientIntegrityProtocolVersion: 2,
  recoveryTokenId: TOKEN,
  ...overrides,
});

describe('evaluateRecoveryIntegrity', () => {
  it.each([undefined, null, 0, 1, '2', 'x'])('refuses a recovery client reporting integrity protocol %j', async (version) => {
    const d = deps();
    const out = await evaluateRecoveryIntegrity(input({ clientIntegrityProtocolVersion: version }), d);
    expect(out).toEqual({
      ok: false,
      status: 409,
      body: { error: 'recovery_client_update_required', message: RECOVERY_CLIENT_UPDATE_REQUIRED_MESSAGE },
    });
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it('tells the operator to get current recovery media', () => {
    expect(RECOVERY_CLIENT_UPDATE_REQUIRED_MESSAGE).toBe(
      'This recovery tool is too old to check backup integrity. Download current recovery media or the current recovery tool, then try again.',
    );
  });

  it('an attested snapshot gets its attested block', async () => {
    const d = deps();
    const out = await evaluateRecoveryIntegrity(input(), d);
    expect(out).toEqual({
      ok: true,
      integrity: {
        v: 1, mode: 'attested', trust: 'server_verified', snapshotId: SNAP,
        objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: 'a'.repeat(64), size: 1 }],
      },
    });
    expect(d.recordIntegrity).toHaveBeenCalledWith('recovery_bootstrap', 'attested', 'server_verified');
  });

  it('an unattested snapshot needs an authorization bound to this token or its recovery', async () => {
    const d = deps({ resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' }) as RestoreIntegrity) });
    const refused = await evaluateRecoveryIntegrity(input({ recoveryId: RECOVERY }), d);
    expect(refused).toEqual({
      ok: false, status: 409, body: { error: 'authorization_missing', message: RESTORE_INTEGRITY_MESSAGES.authorization_missing },
    });
    expect(d.findAuthorizations).toHaveBeenCalledWith({ recoveryTokenId: TOKEN, recoveryId: RECOVERY });

    d.findAuthorizations.mockResolvedValueOnce([{
      id: AUTH, orgId: 'o', snapshotDbId: SNAPSHOT, deviceId: DEVICE, commandType: 'bmr_recover', reason: 'unattested_legacy',
    }]);
    expect(await evaluateRecoveryIntegrity(input({ recoveryId: RECOVERY }), d)).toEqual({
      ok: true,
      integrity: { v: 1, mode: 'unattested_override', snapshotId: SNAP, authorizationId: AUTH },
    });
  });

  it('a rebuild recovery is covered by its bare_metal_rebuild authorization', async () => {
    const d = deps({
      resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested' }) as RestoreIntegrity),
      findAuthorizations: vi.fn(async () => [{
        id: AUTH, orgId: 'o', snapshotDbId: SNAPSHOT, deviceId: DEVICE, commandType: 'bare_metal_rebuild', reason: 'unattested',
      }]),
    });
    expect(await evaluateRecoveryIntegrity(input(), d)).toMatchObject({ ok: true, integrity: { mode: 'unattested_override' } });
  });

  it('an authorization for another snapshot or device does not cover the recovery', async () => {
    const d = deps({
      resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested' }) as RestoreIntegrity),
      findAuthorizations: vi.fn(async () => [
        { id: AUTH, orgId: 'o', snapshotDbId: RECOVERY, deviceId: DEVICE, commandType: 'bmr_recover', reason: 'unattested' },
        { id: AUTH, orgId: 'o', snapshotDbId: SNAPSHOT, deviceId: TOKEN, commandType: 'bmr_recover', reason: 'unattested' },
        { id: AUTH, orgId: 'o', snapshotDbId: SNAPSHOT, deviceId: DEVICE, commandType: 'backup_restore', reason: 'unattested' },
      ]),
    });
    expect(await evaluateRecoveryIntegrity(input(), d)).toMatchObject({ ok: false, body: { error: 'authorization_missing' } });
  });

  it('asks the client to retry while the attestation is being checked, and refuses a failed or unresolved snapshot', async () => {
    const pending = deps({ resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'pending' }) as RestoreIntegrity) });
    expect(await evaluateRecoveryIntegrity(input(), pending)).toEqual({
      ok: false, status: 409,
      body: { error: 'attestation_pending', message: RESTORE_INTEGRITY_MESSAGES.attestation_pending, retryAfterSeconds: 60 },
    });
    const failed = deps({ resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'attestation_failed' }) as RestoreIntegrity) });
    expect(await evaluateRecoveryIntegrity(input(), failed)).toMatchObject({ ok: false, body: { error: 'snapshot_integrity_failed' } });
    const missing = deps({ resolve: vi.fn(async () => null) });
    expect(await evaluateRecoveryIntegrity(input(), missing)).toMatchObject({ ok: false, body: { error: 'snapshot_unresolved' } });
  });
});
