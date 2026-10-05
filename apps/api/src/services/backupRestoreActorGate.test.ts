import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('./backupRestoreIntegrity', () => ({ resolveRestoreIntegrity: resolveMock }));

import { restoreIntegrityRefusalForActor } from './backupRestoreActorGate';
import { RESTORE_INTEGRITY_MESSAGES } from './backupRestoreGate';

const SNAPSHOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const SNAP = 'snapshot-20261001T101500Z-0123456789abcdef01234567';
const input = { snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandType: 'backup_restore', actor: 'ai_agent' as const };

beforeEach(() => resolveMock.mockReset());

describe('restoreIntegrityRefusalForActor', () => {
  it('allows an attested snapshot', async () => {
    resolveMock.mockResolvedValue({ mode: 'attested', trust: 'server_verified', snapshotId: SNAP, sourceDeviceId: DEVICE, objects: [] });
    expect(await restoreIntegrityRefusalForActor(input)).toBeNull();
    expect(resolveMock).toHaveBeenCalledWith(SNAPSHOT);
  });

  it('an AI agent can never restore an unattested snapshot: a technician must, with two-factor confirmation', async () => {
    resolveMock.mockResolvedValue({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' });
    expect(await restoreIntegrityRefusalForActor(input)).toEqual({
      code: 'snapshot_integrity_unavailable',
      message: RESTORE_INTEGRITY_MESSAGES.ai_unattested,
    });
  });

  it('a system actor is refused the same way', async () => {
    resolveMock.mockResolvedValue({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested' });
    expect(await restoreIntegrityRefusalForActor({ ...input, actor: 'system' })).toMatchObject({ code: 'snapshot_integrity_unavailable' });
  });

  it('passes through pending, failed and unresolved refusals', async () => {
    resolveMock.mockResolvedValueOnce({ mode: 'unattested', snapshotId: SNAP, reason: 'pending' });
    expect(await restoreIntegrityRefusalForActor(input)).toMatchObject({ code: 'attestation_pending' });
    resolveMock.mockResolvedValueOnce(null);
    expect(await restoreIntegrityRefusalForActor(input)).toMatchObject({ code: 'snapshot_unresolved' });
  });

  it('read-only validation is never refused here', async () => {
    resolveMock.mockResolvedValue({ mode: 'unattested', snapshotId: SNAP, reason: 'unattested_legacy' });
    expect(await restoreIntegrityRefusalForActor({ ...input, commandType: 'backup_verify' })).toBeNull();
  });
});
