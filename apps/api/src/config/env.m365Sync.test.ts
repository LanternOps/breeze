import { afterEach, describe, expect, it } from 'vitest';
import {
  isM365TenantSyncEnabled,
  m365SyncConcurrency,
  m365SyncMaxBacklog,
  m365SyncTickBatch,
} from './env';

const KEYS = [
  'M365_TENANT_SYNC_ENABLED',
  'M365_SYNC_CONCURRENCY',
  'M365_SYNC_MAX_BACKLOG',
  'M365_SYNC_TICK_BATCH',
] as const;

describe('M365 tenant sync env (spec §10 step 1)', () => {
  const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      const v = original[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each([
    [undefined, false], ['', false], ['false', false], ['0', false], ['no', false],
    ['off', false], ['garbage', false],
    ['true', true], ['1', true], ['yes', true], ['on', true], ['TRUE', true], ['  true  ', true],
  ])('M365_TENANT_SYNC_ENABLED=%s → %s', (raw, expected) => {
    if (raw === undefined) delete process.env.M365_TENANT_SYNC_ENABLED;
    else process.env.M365_TENANT_SYNC_ENABLED = raw as string;
    expect(isM365TenantSyncEnabled()).toBe(expected);
  });

  it('is read at call time, so flipping the flag off actually turns the ticker off', () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    expect(isM365TenantSyncEnabled()).toBe(true);
    process.env.M365_TENANT_SYNC_ENABLED = 'false';
    expect(isM365TenantSyncEnabled()).toBe(false);
  });

  it('defaults the three knobs to 4 / 500 / 200 when unset', () => {
    delete process.env.M365_SYNC_CONCURRENCY;
    delete process.env.M365_SYNC_MAX_BACKLOG;
    delete process.env.M365_SYNC_TICK_BATCH;
    expect(m365SyncConcurrency()).toBe(4);
    expect(m365SyncMaxBacklog()).toBe(500);
    expect(m365SyncTickBatch()).toBe(200);
  });

  it.each([
    ['', 4], ['abc', 4], ['0', 4], ['-3', 4], ['4.9', 4], ['9999', 64],
    ['1', 1], ['16', 16],
  ])('M365_SYNC_CONCURRENCY=%s → %s (garbage and out-of-range fall back or clamp)', (raw, expected) => {
    process.env.M365_SYNC_CONCURRENCY = raw as string;
    expect(m365SyncConcurrency()).toBe(expected);
  });

  it('clamps the tick batch and backlog rather than trusting an operator typo', () => {
    process.env.M365_SYNC_TICK_BATCH = '999999';
    expect(m365SyncTickBatch()).toBe(5_000);
    process.env.M365_SYNC_MAX_BACKLOG = '0';
    expect(m365SyncMaxBacklog()).toBe(500);
  });
});
