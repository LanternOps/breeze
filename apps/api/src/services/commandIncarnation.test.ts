import { describe, expect, it } from 'vitest';
import { commandStampIncarnation, commandStampIsCurrent, SUPERSEDED_BY_REATTACH_REASON } from './commandIncarnation';

describe('command incarnation stamps (#8318 §4.1 null rule)', () => {
  it('reads a NULL stamp as incarnation 1', () => {
    expect(commandStampIncarnation(null)).toBe(1);
    expect(commandStampIncarnation(undefined)).toBe(1);
    expect(commandStampIncarnation(3)).toBe(3);
  });

  it('a stamp is current only when it equals the device incarnation', () => {
    expect(commandStampIsCurrent(null, 1)).toBe(true);
    expect(commandStampIsCurrent(1, 1)).toBe(true);
    expect(commandStampIsCurrent(null, 2)).toBe(false);
    expect(commandStampIsCurrent(1, 2)).toBe(false);
    expect(commandStampIsCurrent(3, 2)).toBe(false);
  });

  it('names the spec reason', () => {
    expect(SUPERSEDED_BY_REATTACH_REASON).toBe('superseded_by_reattach');
  });
});
