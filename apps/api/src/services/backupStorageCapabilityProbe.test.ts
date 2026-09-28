import { describe, expect, it } from 'vitest';
import {
  CONDITIONAL_WRITE_PROBE_MAX_AGE_MS,
  conditionalWriteProbeDue,
  readConditionalWrites,
  withConditionalWriteProbe,
} from './backupStorageCapabilityProbe';

const IDENTITY = 's3::storage.example::bucket';
const NOW = new Date('2026-11-08T12:00:00Z');

describe('readConditionalWrites', () => {
  it('trusts a recorded result only for the identity it was probed against', () => {
    const caps = withConditionalWriteProbe({ objectLock: { supported: true, error: null } }, true, IDENTITY, NOW);
    expect(readConditionalWrites(caps, IDENTITY)).toEqual({ supported: true, probedAt: NOW });
    expect(readConditionalWrites(caps, 's3::other.example::bucket')).toEqual({ supported: false, probedAt: null });
  });

  it('treats missing, malformed or null capabilities as unsupported', () => {
    for (const caps of [null, undefined, 'x', [], { conditionalWrites: 'yes' }, { conditionalWrites: { supported: 1 } }]) {
      expect(readConditionalWrites(caps, IDENTITY).supported).toBe(false);
    }
  });
});

describe('withConditionalWriteProbe', () => {
  it('keeps every other capability', () => {
    const caps = withConditionalWriteProbe({ objectLock: { supported: false, error: 'x' } }, false, IDENTITY, NOW);
    expect(caps).toMatchObject({ objectLock: { supported: false, error: 'x' } });
  });
});

describe('conditionalWriteProbeDue', () => {
  it('is due when never probed, probed for another identity, or older than a day', () => {
    expect(conditionalWriteProbeDue(null, IDENTITY, NOW)).toBe(true);
    const fresh = withConditionalWriteProbe({}, true, IDENTITY, NOW);
    expect(conditionalWriteProbeDue(fresh, IDENTITY, NOW)).toBe(false);
    expect(conditionalWriteProbeDue(fresh, 's3::other::b', NOW)).toBe(true);
    const later = new Date(NOW.getTime() + CONDITIONAL_WRITE_PROBE_MAX_AGE_MS + 1);
    expect(conditionalWriteProbeDue(fresh, IDENTITY, later)).toBe(true);
  });
});
