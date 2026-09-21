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
});
