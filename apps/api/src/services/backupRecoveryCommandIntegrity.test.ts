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

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_DB_ID = '77777777-7777-4777-8777-777777777777';
const RECOVERY = '88888888-8888-4888-8888-888888888888';
const SNAP = 'snapshot-20260930T101500Z-0123456789abcdef01234567';
const SHA = 'a'.repeat(64);

const attested: RestoreIntegrity = {
  mode: 'attested',
  trust: 'server_verified',
  snapshotId: SNAP,
  sourceDeviceId: DEVICE,
  objects: [{ role: 'manifest', key: `snapshots/${SNAP}/manifest.json`, sha256: SHA, size: 10 }],
};
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
    inOrgContext: vi.fn(async (_orgId: string, fn: () => Promise<unknown>) => fn()) as unknown as RecoveryCommandIntegrityDeps['inOrgContext'],
    findSnapshotIds: vi.fn(async (_orgId: string, ref: string) => (ref === SNAP || ref === SNAPSHOT_DB_ID ? [SNAPSHOT_DB_ID] : [])),
    findRecoverySnapshotId: vi.fn(async (_orgId: string, recoveryId: string) => (recoveryId === RECOVERY ? SNAPSHOT_DB_ID : null)),
    resolve: vi.fn(async (id: string) => (id === SNAPSHOT_DB_ID ? attested : null)),
    recordIntegrity: vi.fn(),
    ...overrides,
  };
  return deps as typeof deps & RecoveryCommandIntegrityDeps;
}

const ctx = (type: string) => ({ commandId: 'c1', deviceId: DEVICE, type, claimedAt: new Date() });

describe('integrity expectations on bare-metal recovery commands', () => {
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
    const payload = { recoveryId: RECOVERY, token: 'enc:v1:token', server: 'https://api.example', identity: 'original' };
    const out = await deliverRecoveryCommandIntegrity(payload, ctx('bare_metal_rebuild'), deps);
    expect(out).toEqual({ ...payload, integrity: attestedBlock });
    expect(deps.findRecoverySnapshotId).toHaveBeenCalledWith(ORG, RECOVERY);
  });

  it('an unattested snapshot is delivered with its reason', async () => {
    const deps = makeDeps({ resolve: vi.fn(async () => ({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' }) as RestoreIntegrity) });
    const out = await deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps);
    expect(out.integrity).toEqual({ v: 1, mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' });
    expect(deps.recordIntegrity).toHaveBeenCalledWith('bmr_recover', 'unattested', 'unattested_legacy');
  });

  it.each([
    ['no snapshot reference', {}],
    ['an ambiguous reference', { snapshotId: 'dup' }],
    ['an unknown recovery', { recoveryId: '99999999-9999-4999-8999-999999999999' }],
  ])('with %s the command is delivered without a block, and counted', async (_name, payload) => {
    const deps = makeDeps({ findSnapshotIds: vi.fn(async () => ['a', 'b']) });
    const type = 'recoveryId' in payload ? 'bare_metal_rebuild' : 'bmr_recover';
    const out = await deliverRecoveryCommandIntegrity(payload, ctx(type), deps);
    expect(out).toEqual(payload);
    expect(deps.recordIntegrity).toHaveBeenCalledWith(type, 'absent', 'snapshot_unresolved');
  });

  it('a device with no organization gets no block', async () => {
    const deps = makeDeps({ lookupDeviceOrg: vi.fn(async () => null) });
    const out = await deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps);
    expect(out).toEqual({ snapshotId: SNAP });
  });

  it('a queued integrity block is never passed through', async () => {
    const deps = makeDeps({ resolve: vi.fn(async () => null) });
    const out = await deliverRecoveryCommandIntegrity(
      { snapshotId: SNAP, integrity: { v: 1, mode: 'unattested_override', snapshotId: SNAP, authorizationId: RECOVERY } },
      ctx('bmr_recover'),
      deps,
    );
    expect(out).toEqual({ snapshotId: SNAP });
  });

  it('a lookup failure never holds the command back: it is delivered without a block, and counted', async () => {
    const deps = makeDeps({ resolve: vi.fn(async () => { throw new Error('connection reset'); }) });
    const out = await deliverRecoveryCommandIntegrity({ snapshotId: SNAP, integrity: { v: 1 } }, ctx('bmr_recover'), deps);
    expect(out).toEqual({ snapshotId: SNAP });
    expect(deps.recordIntegrity).toHaveBeenCalledWith('bmr_recover', 'absent', 'lookup_failed');
  });

  it('a failed device lookup is counted the same way', async () => {
    const deps = makeDeps({ lookupDeviceOrg: vi.fn(async () => { throw new Error('pool exhausted'); }) });
    const out = await deliverRecoveryCommandIntegrity({ snapshotId: SNAP }, ctx('bmr_recover'), deps);
    expect(out).toEqual({ snapshotId: SNAP });
    expect(deps.recordIntegrity).toHaveBeenCalledWith('bmr_recover', 'absent', 'lookup_failed');
  });
});
