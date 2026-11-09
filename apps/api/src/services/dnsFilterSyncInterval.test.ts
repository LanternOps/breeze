import { describe, expect, it } from 'vitest';
import { syncIntervalMinutesFromConfig } from './dnsFilterSyncInterval';

describe('syncIntervalMinutesFromConfig', () => {
  it.each([
    [15, 15],
    [3, 5],
    [2000, 1440],
    [30.6, 31],
    ['abc', 15],
    [undefined, 15],
  ])('syncInterval %s -> %s', (syncInterval, expected) => {
    expect(syncIntervalMinutesFromConfig({ syncInterval } as never)).toBe(expected);
  });
});
