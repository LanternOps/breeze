import { describe, expect, it } from 'vitest';

import { restoreFailureReason } from './RecoveryBootstrapTab';

describe('restoreFailureReason', () => {
  it('prefers the terminal error the agent now sets (#5479)', () => {
    expect(
      restoreFailureReason({
        error: 'system state not applied: artifact .resolv.conf.bak failed verification, discarding: size mismatch',
        warnings: ['something else'],
      }),
    ).toBe('system state not applied: artifact .resolv.conf.bak failed verification, discarding: size mismatch');
  });

  it('falls back to the first warning for recoveries from an older agent', () => {
    expect(restoreFailureReason({ warnings: ['', '   ', 'artifact x failed verification'] })).toBe(
      'artifact x failed verification',
    );
  });

  it('returns null when there is nothing to show', () => {
    expect(restoreFailureReason(null)).toBeNull();
    expect(restoreFailureReason(undefined)).toBeNull();
    expect(restoreFailureReason({})).toBeNull();
    expect(restoreFailureReason({ error: '   ', warnings: [] })).toBeNull();
    expect(restoreFailureReason({ error: 42, warnings: 'not-an-array' })).toBeNull();
  });

  it('never presents a warning on a completed recovery as its failure reason', () => {
    expect(
      restoreFailureReason({
        status: 'completed',
        warnings: ['restored from an unattested snapshot: files were not checked against a snapshot attestation'],
      }),
    ).toBeNull();
  });

  it('skips informational warnings when looking for a failure reason', () => {
    expect(
      restoreFailureReason({
        status: 'partial',
        code: 'system_state_requires_rebuild',
        warnings: [
          'system_state_requires_rebuild: system state is applied by a bare-metal rebuild; this recovery restored files only',
          'unattested snapshot: files were not checked against a snapshot attestation',
          'vault copy differs from backup; restored from primary storage: snapshots/s1/manifest.json',
          'C:\\Data\\x.bin: access denied',
        ],
      }),
    ).toBe('C:\\Data\\x.bin: access denied');
    expect(
      restoreFailureReason({
        status: 'failed',
        warnings: ['system_state_requires_rebuild: system state is applied by a bare-metal rebuild; this recovery restored files only'],
      }),
    ).toBeNull();
  });
});
