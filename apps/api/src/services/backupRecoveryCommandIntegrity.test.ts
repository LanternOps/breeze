import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => true,
  withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
}));

import {
  RECOVERY_INTEGRITY_COMMAND_TYPES,
  deliverRecoveryCommandIntegrity,
  type RecoveryCommandIntegrityDeps,
} from './backupRecoveryCommandIntegrity';
import type { RestoreIntegrity } from './backupRestoreIntegrity';
import type { StoredRestoreAuthorization } from './backupRestoreAuthorization';
import { RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE, RESTORE_INTEGRITY_MESSAGES } from './backupRestoreGate';
import { CommandDeliveryDeferredError, CommandDeliveryRefusedError } from './commandDeliveryRefusal';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const HOST = '44444444-4444-4444-8444-444444444444';
const SNAPSHOT_DB_ID = '77777777-7777-4777-8777-777777777777';
const RECOVERY = '88888888-8888-4888-8888-888888888888';
const AUTH_ID = '99999999-9999-4999-8999-999999999990';
const SNAP = 'snapshot-20260930T101500Z-0123456789abcdef01234567';
const SHA = 'a'.repeat(64);

const attested: RestoreIntegrity = {
  mode: 'attested',
  trust: 'server_verified',
  snapshotId: SNAP,
  sourceDeviceId: DEVICE,
  objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: SHA, size: 10 }],
};
const unattested: RestoreIntegrity = { mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' };
const attestedBlock = {
  v: 1,
  mode: 'attested',
  trust: 'server_verified',
  snapshotId: SNAP,
  objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: SHA, size: 10 }],
};

function makeDeps(overrides: Partial<RecoveryCommandIntegrityDeps> = {}) {
  const deps = {
    lookupDeviceOrg: vi.fn(async () => ORG),
    lookupDeviceIntegrityProtocol: vi.fn(async () => 2 as number | null | undefined),
    inOrgContext: vi.fn(async (_orgId: string, fn: () => Promise<unknown>) => fn()) as unknown as RecoveryCommandIntegrityDeps['inOrgContext'],
    findSnapshotIds: vi.fn(async (_orgId: string, ref: string) => (ref === SNAP || ref === SNAPSHOT_DB_ID ? [SNAPSHOT_DB_ID] : [])),
    findRecovery: vi.fn(async (_orgId: string, recoveryId: string) =>
      (recoveryId === RECOVERY ? { snapshotDbId: SNAPSHOT_DB_ID, deviceId: DEVICE } : null)),
    findAuthorizations: vi.fn(async () => [] as StoredRestoreAuthorization[]),
    resolve: vi.fn(async (id: string) => (id === SNAPSHOT_DB_ID ? attested : null)),
    recordIntegrity: vi.fn(),
    ...overrides,
  };
  return deps as typeof deps & RecoveryCommandIntegrityDeps;
}

const ctx = (type: string, overrides: Record<string, unknown> = {}) => ({
  commandId: 'c1',
  deviceId: type === 'bare_metal_rebuild' ? HOST : DEVICE,
  type,
  claimedAt: new Date(),
  ...overrides,
});
const rebuildPayload = () => ({ recoveryId: RECOVERY, token: 'enc:v1:token', server: 'https://api.example', identity: 'original' });

describe('integrity on bare-metal recovery commands', () => {
  it('covers bmr_recover and bare_metal_rebuild', () => {
    expect([...RECOVERY_INTEGRITY_COMMAND_TYPES].sort()).toEqual(['bare_metal_rebuild', 'bmr_recover']);
  });

  it.each([SNAP, SNAPSHOT_DB_ID])('bmr_recover resolves its snapshot (%s) in the device organization', async (ref) => {
    const deps = makeDeps();
    const payload = { recoveryToken: 'enc:v1:token', serverUrl: 'https://api.example', snapshotId: ref };
    const out = await deliverRecoveryCommandIntegrity(payload, ctx('bmr_recover'), deps);
    expect(out).toEqual({ ...payload, integrity: attestedBlock });
    expect(deps.findSnapshotIds).toHaveBeenCalledWith(ORG, ref);
    expect(deps.inOrgContext).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(deps.recordIntegrity).toHaveBeenCalledWith('bmr_recover', 'attested', 'server_verified');
  });

  it('bare_metal_rebuild resolves the snapshot of the recovery it runs', async () => {
    const deps = makeDeps();
    const out = await deliverRecoveryCommandIntegrity(rebuildPayload(), ctx('bare_metal_rebuild'), deps);
    expect(out).toEqual({ ...rebuildPayload(), integrity: attestedBlock });
    expect(deps.findRecovery).toHaveBeenCalledWith(ORG, RECOVERY);
  });

  it.each(['bmr_recover', 'bare_metal_rebuild'])('refuses %s to a helper below integrity protocol 2', async (type) => {
    const deps = makeDeps({ lookupDeviceIntegrityProtocol: vi.fn(async () => 1) });
    const payload = type === 'bmr_recover' ? { snapshotId: SNAP } : rebuildPayload();
    const outcome = deliverRecoveryCommandIntegrity(payload, ctx(type), deps);
    await expect(outcome).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    await expect(outcome).rejects.toThrow(RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(deps.recordIntegrity).toHaveBeenCalledWith(type, 'refused', 'helper_update_required');
  });

  it('decides by the protocol this heartbeat reports, and waits for a device that has not reported', async () => {
    const reported = makeDeps({ lookupDeviceIntegrityProtocol: vi.fn(async () => 1) });
    const out = await deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover', { reportedBackupIntegrityProtocolVersion: 2 }), reported);
    expect(out.integrity).toEqual(attestedBlock);

    const unreported = makeDeps({ lookupDeviceIntegrityProtocol: vi.fn(async () => null) });
    await expect(deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), unreported))
      .rejects.toBeInstanceOf(CommandDeliveryDeferredError);
  });

  it('refuses an unattested snapshot without a confirmed authorization', async () => {
    const deps = makeDeps({ resolve: vi.fn(async () => unattested) });
    await expect(deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps))
      .rejects.toThrow(RESTORE_INTEGRITY_MESSAGES.authorization_missing);
    expect(deps.findAuthorizations).toHaveBeenCalledWith({ commandId: 'c1', recoveryId: null });
  });

  it('delivers an unattested bmr_recover confirmed for this command with an override block', async () => {
    const deps = makeDeps({
      resolve: vi.fn(async () => unattested),
      findAuthorizations: vi.fn(async () => [{
        id: AUTH_ID, orgId: ORG, snapshotDbId: SNAPSHOT_DB_ID, deviceId: DEVICE, commandType: 'bmr_recover', reason: 'unattested_legacy',
      }]),
    });
    const out = await deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps);
    expect(out.integrity).toEqual({ v: 1, mode: 'unattested_override', snapshotId: SNAP, authorizationId: AUTH_ID });
    expect(deps.recordIntegrity).toHaveBeenCalledWith('bmr_recover', 'override', 'unattested_legacy');
  });

  it('a rebuild is covered by the authorization bound to its recovery, for the recovered device', async () => {
    const deps = makeDeps({
      resolve: vi.fn(async () => unattested),
      findAuthorizations: vi.fn(async () => [{
        id: AUTH_ID, orgId: ORG, snapshotDbId: SNAPSHOT_DB_ID, deviceId: DEVICE, commandType: 'bare_metal_rebuild', reason: 'unattested_legacy',
      }]),
    });
    const out = await deliverRecoveryCommandIntegrity(rebuildPayload(), ctx('bare_metal_rebuild'), deps);
    expect(out.integrity).toEqual({ v: 1, mode: 'unattested_override', snapshotId: SNAP, authorizationId: AUTH_ID });
    expect(deps.findAuthorizations).toHaveBeenCalledWith({ commandId: 'c1', recoveryId: RECOVERY });
  });

  it('an authorization for another command type does not cover the command', async () => {
    const deps = makeDeps({
      resolve: vi.fn(async () => unattested),
      findAuthorizations: vi.fn(async () => [{
        id: AUTH_ID, orgId: ORG, snapshotDbId: SNAPSHOT_DB_ID, deviceId: DEVICE, commandType: 'backup_restore', reason: 'unattested_legacy',
      }]),
    });
    await expect(deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps))
      .rejects.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  it('waits while the attestation is being checked and refuses a snapshot that failed it', async () => {
    const pending = makeDeps({ resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'pending' }) as RestoreIntegrity) });
    await expect(deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), pending))
      .rejects.toBeInstanceOf(CommandDeliveryDeferredError);
    const failed = makeDeps({ resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'attestation_failed' }) as RestoreIntegrity) });
    await expect(deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), failed))
      .rejects.toThrow(RESTORE_INTEGRITY_MESSAGES.snapshot_integrity_failed);
  });

  it.each([
    ['no snapshot reference', {}],
    ['an ambiguous reference', { snapshotId: 'dup' }],
    ['an unknown recovery', { recoveryId: '99999999-9999-4999-8999-999999999999' }],
  ])('with %s the command is refused: its integrity cannot be decided', async (_name, payload) => {
    const deps = makeDeps({ findSnapshotIds: vi.fn(async () => ['a', 'b']) });
    const type = 'recoveryId' in payload ? 'bare_metal_rebuild' : 'bmr_recover';
    await expect(deliverRecoveryCommandIntegrity(payload, ctx(type), deps))
      .rejects.toThrow(RESTORE_INTEGRITY_MESSAGES.snapshot_unresolved);
    expect(deps.recordIntegrity).toHaveBeenCalledWith(type, 'refused', 'snapshot_unresolved');
  });

  it('a queued override block is never passed through', async () => {
    const deps = makeDeps();
    const out = await deliverRecoveryCommandIntegrity(
      { snapshotId: SNAP, integrity: { v: 1, mode: 'unattested_override', snapshotId: SNAP, authorizationId: RECOVERY } },
      ctx('bmr_recover'),
      deps,
    );
    expect(out).toEqual({ snapshotId: SNAP, integrity: attestedBlock });
  });

  it.each([
    ['the snapshot lookup', { resolve: vi.fn(async () => { throw new Error('connection reset'); }) }],
    ['the device lookup', { lookupDeviceOrg: vi.fn(async () => { throw new Error('pool exhausted'); }) }],
  ])('a failure in %s is not delivered: the row is released for a later attempt', async (_name, overrides) => {
    const deps = makeDeps(overrides as Partial<RecoveryCommandIntegrityDeps>);
    const outcome = deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps);
    await expect(outcome).rejects.toThrow();
    await expect(outcome).rejects.not.toBeInstanceOf(CommandDeliveryRefusedError);
  });
});
