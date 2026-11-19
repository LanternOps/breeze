import { describe, expect, it } from 'vitest';
import { syncIntervalMinutesFromConfig } from './dnsFilterSyncInterval';

describe('dns-sync repeat interval', () => {
  it('the job keeps a statically readable literal equal to the shared default', async () => {
    const { DNS_SYNC_INTERVAL_MINUTES } = await import('../db/schema/dnsSecurity');
    const { DEFAULT_SYNC_INTERVAL_MINUTES } = await import('../jobs/dnsSyncJob');
    expect(DEFAULT_SYNC_INTERVAL_MINUTES).toBe(DNS_SYNC_INTERVAL_MINUTES.DEFAULT);
  });
});

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
