import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_TTL_MS } from './bareMetalRecoveryCodes';
import { hashRecoveryToken } from './recoveryBootstrap';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RECOVERY_ID = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_ID = '99999999-9999-4999-8999-999999999999';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'offset', 'leftJoin', 'innerJoin']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const { selectMock, insertMock, updateMock, createAuditLogAsyncMock } = vi.hoisted(() => ({
  selectMock: vi.fn<(...args: unknown[]) => any>(),
  insertMock: vi.fn<(...args: unknown[]) => any>(),
  updateMock: vi.fn<(...args: unknown[]) => any>(),
  createAuditLogAsyncMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(async () => undefined),
}));

vi.mock('../db', () => {
  const tx = {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  };
  return {
    db: { ...tx, transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) },
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
    withDbAccessContext: vi.fn((_context: unknown, fn: () => any) => fn()),
  };
});
vi.mock('./auditService', () => ({
  createAuditLogAsync: (entry: Record<string, unknown>) => createAuditLogAsyncMock(entry),
}));

import {
  BareMetalRecoveryError,
  applyRebuildCommandResult,
  cancelBareMetalRecovery,
  createBareMetalRecovery,
  mintRecoveryTokenForRecovery,
  reissueRecoveryCode,
} from './bareMetalRecoveryService';

function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null,
    identity: 'original', status: 'created', codeHash: 'a'.repeat(64), codeExpiresAt: new Date(Date.now() + 60_000),
    codeUsedAt: null, nonceHash: 'x'.repeat(64), target: null, plan: null, result: null, failureReason: null,
    warnings: null, createdBy: USER_ID, createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null,
    plannedAt: null, restoringAt: null, validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null,
    ...overrides,
  };
}

const restorableSnapshot = { id: SNAPSHOT_ID, deviceId: DEVICE_ID, orgId: ORG_ID, bareMetalRestorable: true, bareMetalReasons: [], referencedFiles: null };

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockImplementation(() => chainMock([]));
  insertMock.mockImplementation(() => chainMock([]));
  updateMock.mockImplementation(() => chainMock([]));
});

async function expectRecoveryError(promise: Promise<unknown>, code: string, status: number) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BareMetalRecoveryError);
  expect((err as BareMetalRecoveryError).code).toBe(code);
  expect((err as BareMetalRecoveryError).status).toBe(status);
  return err as BareMetalRecoveryError;
}

describe('createBareMetalRecovery', () => {
  // #6403 interim guard: an incremental snapshot's manifest references objects
  // under an OLDER snapshot's prefix, and token-mode recovery is confined to
  // one prefix — so the restore fails AFTER the target has been partitioned
  // and formatted. Refuse at creation instead, before any disk is touched.
  it('refuses a snapshot whose backup referenced objects from older snapshots (409), before any write', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ ...restorableSnapshot, referencedFiles: 98411 }]));
    const err = await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'dr' }),
      'snapshot_has_external_references', 409,
    );
    expect(err.details).toMatchObject({ referencedFiles: 98411, snapshotId: SNAPSHOT_ID });
    // The existing UI renders `reasons`; without it the operator sees only a code.
    expect((err.details as { reasons: string[] }).reasons[0]).toContain('98,411');
    expect(insertMock).not.toHaveBeenCalled();
  });

  // referenced_files is NULL for every self-contained snapshot: the agent's
  // `referencedFiles,omitempty` drops a zero, and the API only writes the
  // column when the field is present. Refusing NULL would refuse every full
  // backup, so NULL and 0 must both be allowed.
  it.each([[null], [0]])('allows a self-contained snapshot (referencedFiles=%s)', async (referencedFiles) => {
    selectMock.mockReturnValueOnce(chainMock([{ ...restorableSnapshot, referencedFiles }]));
    selectMock.mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow()]));
    const { row } = await createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' });
    expect(row.id).toBe(RECOVERY_ID);
    expect(insertMock).toHaveBeenCalled();
  });

  it('refuses a snapshot the guard marked non-restorable (409) naming the reasons', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ ...restorableSnapshot, bareMetalRestorable: false, bareMetalReasons: ['LVM volumes are not supported'] }]));
    const err = await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' }),
      'snapshot_not_bare_metal_restorable', 409,
    );
    expect(err.details).toEqual({ reasons: ['LVM volumes are not supported'] });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown snapshot (404)', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));
    await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' }),
      'snapshot_not_found', 404,
    );
  });

  it('refuses a second in-flight recovery for the device (409) and names it', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([{ id: 'rec-0', status: 'restoring' }]));
    const err = await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' }),
      'recovery_in_progress', 409,
    );
    expect(err.details).toEqual({ recoveryId: 'rec-0', status: 'restoring' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('inserts with the identity as given, a hashed code, and returns the formatted code once', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow({ identity: 'new' })]));

    const out = await createBareMetalRecovery({
      orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'new', createdBy: USER_ID, source: 'vm_restore',
      executingDeviceId: 'host-1', target: { kind: 'vhdx', path: '/srv/out.vhdx' },
    });

    expect(out.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(out.row.id).toBe(RECOVERY_ID);
    const inserted = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(inserted).toMatchObject({ orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'new', status: 'created', createdBy: USER_ID, target: { kind: 'vhdx', path: '/srv/out.vhdx' } });
    expect(inserted.codeHash).toBe(hashRecoveryCode(normalizeRecoveryCode(out.code)!));
    expect(inserted.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted).not.toHaveProperty('code');
    expect(inserted).not.toHaveProperty('nonce');
    const expiresIn = (inserted.codeExpiresAt as Date).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(RECOVERY_CODE_TTL_MS - 5_000);
    expect(expiresIn).toBeLessThanOrEqual(RECOVERY_CODE_TTL_MS);
  });

  // #6322: the SELECT-then-INSERT pre-check loses the race between two
  // concurrent creators. The partial unique index is the arbiter; the loser's
  // 23505 must surface as the same `recovery_in_progress` 409, not a 500.
  it('maps the one-in-flight unique violation to recovery_in_progress (409) naming the winner', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      // Pre-check sees nothing — both creators got this far.
      .mockReturnValueOnce(chainMock([]))
      // Re-read after the 23505 finds the row that won.
      .mockReturnValueOnce(chainMock([{ id: 'rec-winner', status: 'created' }]));
    insertMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint_name: 'bare_metal_recoveries_device_in_flight_idx',
      });
    });

    const err = await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' }),
      'recovery_in_progress', 409,
    );
    expect(err.details).toEqual({ recoveryId: 'rec-winner', status: 'created' });
  });

  it('still reports recovery_in_progress when the winner terminalised before the re-read', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint_name: 'bare_metal_recoveries_device_in_flight_idx',
      });
    });

    const err = await expectRecoveryError(
      createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' }),
      'recovery_in_progress', 409,
    );
    expect(err.details).toEqual({ recoveryId: null, status: null });
  });

  it('lets an unrelated unique violation escape instead of masking it as recovery_in_progress', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint_name: 'bare_metal_recoveries_code_hash_idx',
      });
    });

    const err = await createBareMetalRecovery({
      orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route',
    }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(BareMetalRecoveryError);
    expect((err as { code?: string }).code).toBe('23505');
  });

  it('writes the DR linkage and rebuild host onto the row (W05b Task 6)', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow()]));

    await createBareMetalRecovery({
      orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: null, source: 'dr',
      executingDeviceId: 'host-1', drExecutionId: 'exec-1', drGroupId: 'group-1',
    });

    const inserted = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(inserted).toMatchObject({ executingDeviceId: 'host-1', drExecutionId: 'exec-1', drGroupId: 'group-1' });
  });

  it('leaves the DR linkage NULL for a boot-media recovery', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow()]));

    await createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'route' });

    const inserted = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(inserted).toMatchObject({ executingDeviceId: null, drExecutionId: null, drGroupId: null });
  });

  it('audits bmr.recovery.create with the source and never the code', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([restorableSnapshot]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([recoveryRow()]));

    const out = await createBareMetalRecovery({ orgId: ORG_ID, snapshotId: SNAPSHOT_ID, identity: 'original', createdBy: USER_ID, source: 'dr' });

    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
    const entry = createAuditLogAsyncMock.mock.calls[0]![0];
    expect(entry).toMatchObject({
      orgId: ORG_ID, action: 'bmr.recovery.create', resourceType: 'bare_metal_recovery', resourceId: RECOVERY_ID,
      actorId: USER_ID, result: 'success',
      details: { snapshotId: SNAPSHOT_ID, deviceId: DEVICE_ID, identity: 'original', source: 'dr' },
    });
    expect(JSON.stringify(entry)).not.toContain(normalizeRecoveryCode(out.code));
  });
});

describe('mintRecoveryTokenForRecovery', () => {
  it('mints an authenticated bare_metal token and links it without advancing the status', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow()]));
    insertMock.mockReturnValueOnce(chainMock([{ id: TOKEN_ID }]));
    updateMock.mockReturnValueOnce(chainMock([recoveryRow({ recoveryTokenId: TOKEN_ID })]));

    const out = await mintRecoveryTokenForRecovery({ recoveryId: RECOVERY_ID, orgId: ORG_ID, createdBy: USER_ID });

    expect(out.tokenId).toBe(TOKEN_ID);
    expect(out.token).toMatch(/^brz_rec_[0-9a-f]{64}$/);
    const tokenInsert = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(tokenInsert).toMatchObject({
      orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal', status: 'authenticated',
      targetConfig: { bareMetalRecoveryId: RECOVERY_ID }, createdBy: USER_ID, tokenHash: hashRecoveryToken(out.token),
    });
    expect(tokenInsert.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    const linked = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(linked).toMatchObject({ recoveryTokenId: TOKEN_ID });
    expect(linked).not.toHaveProperty('status');
  });

  it('refuses to mint for a recovery that is no longer created (invalid_state)', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'failed' })]));
    await expectRecoveryError(mintRecoveryTokenForRecovery({ recoveryId: RECOVERY_ID, orgId: ORG_ID, createdBy: null }), 'invalid_state', 409);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('cancelBareMetalRecovery', () => {
  it('moves a restoring recovery to failed/cancelled and audits', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'restoring' })]));
    updateMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'failed', failureReason: 'cancelled' })]));

    const row = await cancelBareMetalRecovery({ recoveryId: RECOVERY_ID, orgId: ORG_ID, userId: USER_ID, reason: 'stuck rehearsal' });

    expect(row.status).toBe('failed');
    const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(set).toMatchObject({ status: 'failed', failureReason: 'cancelled' });
    expect(createAuditLogAsyncMock.mock.calls[0]![0]).toMatchObject({
      action: 'bmr.recovery.cancel', resourceId: RECOVERY_ID, actorId: USER_ID,
      details: { from: 'restoring', reason: 'stuck rehearsal' },
    });
  });

  it('refuses to cancel a completed recovery (invalid_state)', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'completed' })]));
    await expectRecoveryError(cancelBareMetalRecovery({ recoveryId: RECOVERY_ID, orgId: ORG_ID, userId: USER_ID }), 'invalid_state', 409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('404s an unknown recovery', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));
    await expectRecoveryError(cancelBareMetalRecovery({ recoveryId: RECOVERY_ID, orgId: ORG_ID, userId: USER_ID }), 'recovery_not_found', 404);
  });
});

describe('reissueRecoveryCode', () => {
  it.each(['created', 'media_booted'] as const)('rotates the code hash and expiry from %s, returning the new code once', async (status) => {
    const oldHash = hashRecoveryCode('ABCDEFGHJ');
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ status, codeHash: oldHash })]));
    updateMock.mockReturnValueOnce(chainMock([recoveryRow({ status })]));

    const out = await reissueRecoveryCode({ recoveryId: RECOVERY_ID, orgId: ORG_ID, userId: USER_ID });

    expect(out.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(set.codeHash).toBe(hashRecoveryCode(normalizeRecoveryCode(out.code)!));
    expect(set.codeHash).not.toBe(oldHash);
    expect(set.codeUsedAt).toBeNull();
    expect((set.codeExpiresAt as Date).getTime() - Date.now()).toBeGreaterThan(RECOVERY_CODE_TTL_MS - 5_000);
    expect(set).not.toHaveProperty('status');
    expect(createAuditLogAsyncMock.mock.calls[0]![0]).toMatchObject({ action: 'bmr.recovery.reissue_code', resourceId: RECOVERY_ID });
    expect(JSON.stringify(createAuditLogAsyncMock.mock.calls[0]![0])).not.toContain(normalizeRecoveryCode(out.code));
  });

  it('refuses once the helper has started (planned) — the old code has already been exchanged', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'planned' })]));
    await expectRecoveryError(reissueRecoveryCode({ recoveryId: RECOVERY_ID, orgId: ORG_ID, userId: USER_ID }), 'invalid_state', 409);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('applyRebuildCommandResult', () => {
  it('leaves an identity:new recovery completed on a completed command result', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ identity: 'new', status: 'restoring' })]));
    updateMock.mockReturnValueOnce(chainMock([recoveryRow({ identity: 'new', status: 'completed' })]));

    await applyRebuildCommandResult({ recoveryId: RECOVERY_ID, orgId: ORG_ID, result: { status: 'completed', result: { status: 'completed', phaseReached: 'convert' } } });

    const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(set).toMatchObject({ status: 'completed' });
    expect(set.validatedAt).toBeInstanceOf(Date);
    expect(set.completedAt).toBeInstanceOf(Date);
  });

  it('records a refusal as refused with the refusal text as failureReason', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ identity: 'new', status: 'media_booted' })]));
    updateMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'refused' })]));

    await applyRebuildCommandResult({ recoveryId: RECOVERY_ID, orgId: ORG_ID, result: { status: 'failed', result: { status: 'refused', refusal: 'qemu-img not installed on this host; install qemu-utils' } } });

    const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(set).toMatchObject({ status: 'refused', failureReason: 'qemu-img not installed on this host; install qemu-utils' });
  });

  it('records a failed command as failed with the error', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'restoring' })]));
    updateMock.mockReturnValueOnce(chainMock([recoveryRow({ status: 'failed' })]));

    await applyRebuildCommandResult({ recoveryId: RECOVERY_ID, orgId: ORG_ID, result: { status: 'failed', error: 'loop attach failed' } });

    const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(set).toMatchObject({ status: 'failed', failureReason: 'loop attach failed' });
  });

  it('is idempotent: a recovery the progress route already terminalised is left alone', async () => {
    selectMock.mockReturnValueOnce(chainMock([recoveryRow({ identity: 'new', status: 'completed' })]));
    await applyRebuildCommandResult({ recoveryId: RECOVERY_ID, orgId: ORG_ID, result: { status: 'completed' } });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
