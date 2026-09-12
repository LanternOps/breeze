import { describe, expect, it } from 'vitest';
import { __testOnly } from './staleCommandReaper';

describe('stale execution deadline resolution', () => {
  it('uses the execution snapshot when it is present', () => {
    expect(__testOnly.resolveExecutionTimeoutSeconds({ timeoutSeconds: 900, scriptTimeoutSeconds: 300 })).toBe(900);
  });

  it('falls back to the joined script for rows written before the snapshot column', () => {
    expect(__testOnly.resolveExecutionTimeoutSeconds({ timeoutSeconds: null, scriptTimeoutSeconds: 300 })).toBe(300);
  });

  it('falls back to the platform default when neither is available (a proposal row, no script)', () => {
    expect(__testOnly.resolveExecutionTimeoutSeconds({ timeoutSeconds: null, scriptTimeoutSeconds: null }))
      .toBe(__testOnly.DEFAULT_EXECUTION_TIMEOUT_SECONDS);
  });
});
