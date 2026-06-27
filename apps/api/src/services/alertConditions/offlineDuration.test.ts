import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_REEVAL_HORIZON_MINUTES,
  resolveReevalHorizonMinutes,
  findOfflineDurationViolation,
} from './offlineDuration';

afterEach(() => {
  delete process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES;
});

describe('resolveReevalHorizonMinutes', () => {
  it('defaults to 24h (1440 min)', () => {
    expect(DEFAULT_REEVAL_HORIZON_MINUTES).toBe(1440);
    expect(resolveReevalHorizonMinutes()).toBe(1440);
  });

  it('honors the env override', () => {
    process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES = '10080';
    expect(resolveReevalHorizonMinutes()).toBe(10080);
  });

  it('clamps to at least 1', () => {
    process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES = '0';
    expect(resolveReevalHorizonMinutes()).toBe(1);
  });
});

describe('findOfflineDurationViolation', () => {
  it('returns null when there are no items', () => {
    expect(findOfflineDurationViolation({})).toBeNull();
    expect(findOfflineDurationViolation(null)).toBeNull();
    expect(findOfflineDurationViolation({ items: [] })).toBeNull();
  });

  it('returns null when an offline duration is within the horizon', () => {
    const settings = { items: [{ name: 'r', conditions: { type: 'offline', durationMinutes: 60 } }] };
    expect(findOfflineDurationViolation(settings)).toBeNull();
  });

  it('allows a duration exactly at the horizon', () => {
    const settings = { items: [{ conditions: { type: 'offline', durationMinutes: 1440 } }] };
    expect(findOfflineDurationViolation(settings)).toBeNull();
  });

  it('flags a duration beyond the horizon and names the rule', () => {
    const settings = { items: [{ name: 'Weekly offline', conditions: { type: 'offline', durationMinutes: 10080 } }] };
    const error = findOfflineDurationViolation(settings);
    expect(error).toContain('Weekly offline');
    expect(error).toContain('10080');
    expect(error).toContain('1440');
  });

  it('flags a legacy { type: status, duration } condition beyond the horizon', () => {
    const settings = { items: [{ conditions: { type: 'status', duration: 2880 } }] };
    expect(findOfflineDurationViolation(settings)).toContain('2880');
  });

  it('finds an oversized offline condition nested inside a group', () => {
    const settings = {
      items: [
        {
          name: 'Grouped',
          conditions: { operator: 'and', conditions: [{ type: 'metric', metric: 'cpu' }, { type: 'offline', durationMinutes: 5000 }] },
        },
      ],
    };
    expect(findOfflineDurationViolation(settings)).toContain('5000');
  });

  it('respects an env-raised horizon', () => {
    process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES = '20000';
    const settings = { items: [{ conditions: { type: 'offline', durationMinutes: 10080 } }] };
    expect(findOfflineDurationViolation(settings)).toBeNull();
  });
});
