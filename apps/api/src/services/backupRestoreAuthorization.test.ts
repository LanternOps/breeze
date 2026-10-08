import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => true,
  withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

import {
  UNATTESTED_RESTORE_AUDIT_ACTION,
  authorizationCovers,
  recordRestoreAuthorization,
  unattestedRestoreResourceDigest,
  type RestoreAuthorizationWriter,
} from './backupRestoreAuthorization';

const ORG = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const COMMAND = '66666666-6666-4666-8666-666666666666';

/** A writer whose `atomically` keeps writes only when the whole callback succeeds. */
function transactionalWriter(opts: { failAudit?: boolean } = {}) {
  const committed: { authorizations: any[]; audits: any[] } = { authorizations: [], audits: [] };
  let pending: { authorizations: any[]; audits: any[] } | null = null;
  const writer: RestoreAuthorizationWriter = {
    insertAuthorization: async (row) => {
      pending!.authorizations.push(row);
    },
    insertAudit: async (row) => {
      if (opts.failAudit) throw new Error('audit insert failed');
      pending!.audits.push(row);
    },
    atomically: async (fn) => {
      pending = { authorizations: [], audits: [] };
      try {
        const out = await fn();
        committed.authorizations.push(...pending.authorizations);
        committed.audits.push(...pending.audits);
        return out;
      } finally {
        pending = null;
      }
    },
  };
  return { writer, committed };
}

const input = () => ({
  orgId: ORG,
  snapshotDbId: SNAPSHOT,
  targetDeviceId: DEVICE,
  commandType: 'backup_restore',
  reason: 'unattested_legacy' as const,
  userId: USER,
  userEmail: 'tech@example.com',
  binding: { commandId: COMMAND },
});

describe('unattestedRestoreResourceDigest', () => {
  it('binds the snapshot, the target device and the command type', () => {
    const base = unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandType: 'backup_restore' });
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(unattestedRestoreResourceDigest({ snapshotDbId: OTHER, targetDeviceId: DEVICE, commandType: 'backup_restore' })).not.toBe(base);
    expect(unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT, targetDeviceId: OTHER, commandType: 'backup_restore' })).not.toBe(base);
    expect(unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandType: 'mssql_restore' })).not.toBe(base);
  });

  it('is independent of id letter case', () => {
    expect(unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT.toUpperCase(), targetDeviceId: DEVICE.toUpperCase(), commandType: 'backup_restore' }))
      .toBe(unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandType: 'backup_restore' }));
  });
});

describe('recordRestoreAuthorization', () => {
  it('records how the restore was confirmed in the audit event, and only there', async () => {
    const { writer, committed } = transactionalWriter();
    await recordRestoreAuthorization({ ...input(), confirmationMethod: 'typed' }, writer);
    expect(committed.audits[0].details).toMatchObject({ confirmationMethod: 'typed', reason: 'unattested_legacy' });
    expect(committed.authorizations[0]).not.toHaveProperty('confirmationMethod');
  });

  it('writes the authorization and its audit event together, bound to the reserved command id', async () => {
    const { writer, committed } = transactionalWriter();
    const id = await recordRestoreAuthorization(input(), writer);

    expect(committed.authorizations).toHaveLength(1);
    expect(committed.authorizations[0]).toMatchObject({
      id,
      orgId: ORG,
      snapshotDbId: SNAPSHOT,
      deviceId: DEVICE,
      commandType: 'backup_restore',
      reason: 'unattested_legacy',
      authorizedByUserId: USER,
      commandId: COMMAND,
      recoveryTokenId: null,
      recoveryId: null,
      resourceDigest: unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandType: 'backup_restore' }),
    });
    expect(committed.authorizations[0].auditWrittenAt).toBeInstanceOf(Date);

    expect(committed.audits).toEqual([
      expect.objectContaining({
        orgId: ORG,
        actorType: 'user',
        actorId: USER,
        action: UNATTESTED_RESTORE_AUDIT_ACTION,
        resourceType: 'backup_snapshot',
        resourceId: SNAPSHOT,
        result: 'success',
        details: {
          authorizationId: id,
          snapshotDbId: SNAPSHOT,
          targetDeviceId: DEVICE,
          commandType: 'backup_restore',
          reason: 'unattested_legacy',
          commandId: COMMAND,
        },
      }),
    ]);
  });

  it('a failed audit write leaves no authorization', async () => {
    const { writer, committed } = transactionalWriter({ failAudit: true });
    await expect(recordRestoreAuthorization(input(), writer)).rejects.toThrow('audit insert failed');
    expect(committed.authorizations).toHaveLength(0);
    expect(committed.audits).toHaveLength(0);
  });

  it('binds a recovery token or a recovery instead of a command', async () => {
    const { writer, committed } = transactionalWriter();
    await recordRestoreAuthorization({ ...input(), commandType: 'bmr_recover', binding: { recoveryTokenId: COMMAND } }, writer);
    await recordRestoreAuthorization({ ...input(), commandType: 'bmr_recover', binding: { recoveryId: OTHER } }, writer);
    expect(committed.authorizations.map((a) => [a.commandId, a.recoveryTokenId, a.recoveryId])).toEqual([
      [null, COMMAND, null],
      [null, null, OTHER],
    ]);
  });
});

describe('authorizationCovers', () => {
  const stored = { id: 'a', orgId: ORG, snapshotDbId: SNAPSHOT, deviceId: DEVICE, commandType: 'backup_restore', reason: 'unattested' };

  it('covers exactly its own snapshot, device and command type', () => {
    expect(authorizationCovers(stored, { snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandTypes: ['backup_restore'] })).toBe(true);
    expect(authorizationCovers(stored, { snapshotDbId: OTHER, targetDeviceId: DEVICE, commandTypes: ['backup_restore'] })).toBe(false);
    expect(authorizationCovers(stored, { snapshotDbId: SNAPSHOT, targetDeviceId: OTHER, commandTypes: ['backup_restore'] })).toBe(false);
    expect(authorizationCovers(stored, { snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandTypes: ['mssql_restore'] })).toBe(false);
    expect(authorizationCovers(null, { snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandTypes: ['backup_restore'] })).toBe(false);
  });
});
