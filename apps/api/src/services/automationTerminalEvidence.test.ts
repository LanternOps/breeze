import { describe, expect, it } from 'vitest';
import { mapCommandTerminalEvidence } from './automationTerminalEvidence';

describe('command terminal evidence mapping', () => {
  it('maps completed exit zero to succeeded', () => {
    expect(mapCommandTerminalEvidence({ status: 'completed', exitCode: 0 })).toBe('succeeded');
  });

  it('maps completed nonzero exit to failed', () => {
    expect(mapCommandTerminalEvidence({ status: 'completed', exitCode: 23 })).toBe('failed');
  });

  it.each(['failed', 'timeout'] as const)('maps %s to failed', (status) => {
    expect(mapCommandTerminalEvidence({ status })).toBe('failed');
  });
});
