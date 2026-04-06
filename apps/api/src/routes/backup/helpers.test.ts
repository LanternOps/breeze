import { describe, expect, it } from 'vitest';
import { getDueOccurrenceKey } from './helpers';

describe('backup schedule helpers', () => {
  it('returns an occurrence key for an exact scheduled minute', () => {
    expect(
      getDueOccurrenceKey(
        { frequency: 'daily', time: '02:00', timezone: 'UTC' },
        new Date('2026-03-31T02:00:15.000Z'),
        'UTC',
      ),
    ).toBe('2026-03-31T02:00');
  });

  it('catches up within the configured lookback window', () => {
    expect(
      getDueOccurrenceKey(
        { frequency: 'daily', time: '02:00', timezone: 'UTC' },
        new Date('2026-03-31T02:04:00.000Z'),
        'UTC',
        5,
      ),
    ).toBe('2026-03-31T02:00');
  });

  it('does not catch up once the lookback window has elapsed', () => {
    expect(
      getDueOccurrenceKey(
        { frequency: 'daily', time: '02:00', timezone: 'UTC' },
        new Date('2026-03-31T02:06:00.000Z'),
        'UTC',
        5,
      ),
    ).toBeNull();
  });

  it('can catch up across a date boundary', () => {
    expect(
      getDueOccurrenceKey(
        { frequency: 'daily', time: '23:58', timezone: 'UTC' },
        new Date('2026-04-01T00:02:00.000Z'),
        'UTC',
        5,
      ),
    ).toBe('2026-03-31T23:58');
  });
});
