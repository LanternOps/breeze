import { describe, expect, it } from 'vitest';
import { BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY } from './backupObjectKey';
import { negotiateRecoveryCapabilities, RECOVERY_REFUSAL_MESSAGES } from './recoveryCapabilities';

const CAP = BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY;
const completeFileIndex = { status: 'complete' as const, manifestSha256: 'a'.repeat(64), externalCount: 3, originSnapshotIds: ['older'], error: null, retryable: false };
const noneFileIndex = { status: 'none' as const, manifestSha256: null, externalCount: null, originSnapshotIds: [], error: null, retryable: false };

function base(overrides: Partial<Parameters<typeof negotiateRecoveryCapabilities>[0]> = {}) {
  return {
    clientCapabilities: undefined,
    previouslyNegotiated: null,
    referencedFiles: null,
    storageIdentity: 's3::endpoint::bucket',
    resolvedProviderIdentity: 's3::endpoint::bucket',
    fileIndex: noneFileIndex,
    ...overrides,
  };
}

describe('negotiateRecoveryCapabilities', () => {
  it('R1: self-contained snapshot grants regardless of client capabilities, no fileIndex', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: null }));
    expect(result).toMatchObject({ ok: true, granted: [], fileIndex: null, enqueueHydration: false });
  });

  it('R1: self-contained snapshot with referencedFiles=0 behaves identically to null', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 0, clientCapabilities: [CAP] }));
    expect(result).toMatchObject({ ok: true, granted: [CAP], fileIndex: null });
  });

  it('R2: referenced snapshot, legacy client (no capabilities array) is refused client_capability_required', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: undefined, fileIndex: completeFileIndex }));
    expect(result).toMatchObject({ ok: false, status: 409, error: 'client_capability_required' });
  });

  it('R2: referenced snapshot, client sends capabilities but not the membership one, is also refused', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: ['some-other-cap'], fileIndex: completeFileIndex }));
    expect(result).toMatchObject({ ok: false, error: 'client_capability_required' });
  });

  it('R3: referenced snapshot, index none/agent enqueues hydration and returns snapshot_index_pending', () => {
    for (const status of ['none', 'agent'] as const) {
      const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], fileIndex: { ...noneFileIndex, status } }));
      expect(result).toMatchObject({ ok: false, error: 'snapshot_index_pending', retryAfterSeconds: 30, enqueueHydration: true });
    }
  });

  it('R3: index hydrating also returns snapshot_index_pending but does not re-enqueue', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], fileIndex: { ...noneFileIndex, status: 'hydrating' } }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_pending', enqueueHydration: false });
  });

  it('R3: snapshot_index_pending message interpolates the real referenced-file count, not a literal "N"', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 98411, clientCapabilities: [CAP], fileIndex: { ...noneFileIndex, status: 'agent' } }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_pending' });
    const message = (result as { message: string }).message;
    expect(message).not.toContain('(N files');
    expect(message).toContain('98411 files reference earlier snapshots');
  });

  it('R3: prefers externalCount over referencedFiles for the interpolated count when externalCount is already known', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 98411,
      clientCapabilities: [CAP],
      fileIndex: { ...noneFileIndex, status: 'agent', externalCount: 200 },
    }));
    const message = (result as { message: string }).message;
    expect(message).toContain('200 files reference earlier snapshots');
  });

  it('a retryable failed index re-enqueues and reports snapshot_index_failed', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, clientCapabilities: [CAP],
      fileIndex: { ...noneFileIndex, status: 'failed', error: 'manifest fetch timed out', retryable: true },
    }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_failed', enqueueHydration: true });
    expect((result as any).message).toContain('manifest fetch timed out');
  });

  it('a NON-retryable failed index reports snapshot_index_failed without re-enqueueing', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, clientCapabilities: [CAP],
      fileIndex: { ...noneFileIndex, status: 'failed', error: 'manifest id mismatch', retryable: false },
    }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_index_failed', enqueueHydration: false });
  });

  it('R4: referenced snapshot, complete index, capability present — grants and returns fileIndex', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], fileIndex: completeFileIndex }));
    expect(result).toMatchObject({
      ok: true, granted: [CAP], enqueueHydration: false,
      fileIndex: { status: 'complete', manifestSha256: completeFileIndex.manifestSha256, externalCount: 3, originSnapshotIds: ['older'] },
    });
  });

  it('R5: re-authenticate without the capability on a token that already negotiated it is a downgrade', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, previouslyNegotiated: [CAP], clientCapabilities: undefined, fileIndex: completeFileIndex,
    }));
    expect(result).toMatchObject({ ok: false, error: 'capability_downgrade' });
  });

  it('R10: storage_identity NULL on the snapshot is refused before the index is even consulted', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: 5, clientCapabilities: [CAP], storageIdentity: null, fileIndex: completeFileIndex }));
    expect(result).toMatchObject({ ok: false, error: 'snapshot_storage_identity_unknown' });
  });

  it('R11: resolved provider identity drifted from the pinned identity is refused', () => {
    const result = negotiateRecoveryCapabilities(base({
      referencedFiles: 5, clientCapabilities: [CAP], storageIdentity: 's3::e::old-bucket',
      resolvedProviderIdentity: 's3::e::new-bucket', fileIndex: completeFileIndex,
    }));
    expect(result).toMatchObject({ ok: false, error: 'storage_identity_drift' });
  });

  it('unknown client capability strings are ignored, not rejected — forward compatibility', () => {
    const result = negotiateRecoveryCapabilities(base({ referencedFiles: null, clientCapabilities: [CAP, 'future-cap-v2'] }));
    expect(result).toMatchObject({ ok: true, granted: [CAP] });
  });

  it('RECOVERY_REFUSAL_MESSAGES has the exact copy for every error code', () => {
    expect(RECOVERY_REFUSAL_MESSAGES.client_capability_required).toContain('too old to read them');
    expect(RECOVERY_REFUSAL_MESSAGES.capability_downgrade).toContain('cannot continue without it');
    expect(RECOVERY_REFUSAL_MESSAGES.snapshot_storage_identity_unknown).toContain('Wait for the next retention run');
    expect(RECOVERY_REFUSAL_MESSAGES.storage_identity_drift).toContain('backup destination');
    expect(RECOVERY_REFUSAL_MESSAGES.snapshot_index_pending).toContain('preparing the file index');
    expect(RECOVERY_REFUSAL_MESSAGES.snapshot_index_failed).toContain('could not verify this snapshot');
  });
});
