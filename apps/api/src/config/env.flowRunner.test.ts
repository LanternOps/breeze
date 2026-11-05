import { afterEach, describe, expect, it } from 'vitest';
import {
  flowForEachMaxParallel,
  flowMaxRunningPerOwner,
  flowRunRetentionDays,
  flowWebhookDeliveryRetentionDays,
  flowWebhookRatePerMinute,
} from './env';

/** Tool catalog W04 (#5219), plan Task A8: the runner's capacity and retention knobs. */
const KEYS = ['FLOW_MAX_RUNNING_PER_OWNER', 'FLOW_RUN_RETENTION_DAYS'] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe('FLOW_MAX_RUNNING_PER_OWNER', () => {
  it('defaults to 20 when unset', () => {
    delete process.env.FLOW_MAX_RUNNING_PER_OWNER;
    expect(flowMaxRunningPerOwner()).toBe(20);
  });

  it.each([
    ['', 20], ['abc', 20], ['0', 20], ['-3', 20], ['2.5', 20],
    ['1', 1], ['64', 64], ['500', 500], ['9999', 500],
  ])('FLOW_MAX_RUNNING_PER_OWNER=%s → %s (garbage falls back, out-of-range clamps to 1..500)', (raw, expected) => {
    process.env.FLOW_MAX_RUNNING_PER_OWNER = raw as string;
    expect(flowMaxRunningPerOwner()).toBe(expected);
  });
});

describe('FLOW_RUN_RETENTION_DAYS', () => {
  it('defaults to 90 when unset', () => {
    delete process.env.FLOW_RUN_RETENTION_DAYS;
    expect(flowRunRetentionDays()).toBe(90);
  });

  it.each([
    ['', 90], ['abc', 90], ['0', 90], ['-3', 90],
    ['3', 7], ['7', 7], ['365', 365], ['3650', 3650], ['10000', 3650],
  ])('FLOW_RUN_RETENTION_DAYS=%s → %s (garbage falls back, out-of-range clamps to 7..3650)', (raw, expected) => {
    process.env.FLOW_RUN_RETENTION_DAYS = raw as string;
    expect(flowRunRetentionDays()).toBe(expected);
  });

  it('is read at call time', () => {
    process.env.FLOW_RUN_RETENTION_DAYS = '30';
    expect(flowRunRetentionDays()).toBe(30);
    process.env.FLOW_RUN_RETENTION_DAYS = '31';
    expect(flowRunRetentionDays()).toBe(31);
  });
});

/** Tool catalog W05 (#5220): webhook intake and for-each fan-out knobs. */
describe.each([
  ['FLOW_WEBHOOK_RATE_PER_MINUTE', flowWebhookRatePerMinute, 120, 1, 6000],
  ['FLOW_WEBHOOK_DELIVERY_RETENTION_DAYS', flowWebhookDeliveryRetentionDays, 30, 1, 365],
  ['FLOW_FOREACH_MAX_PARALLEL', flowForEachMaxParallel, 5, 1, 10],
] as const)('%s (W05)', (key, fn, def, min, max) => {
  afterEach(() => {
    delete process.env[key];
  });

  it(`defaults to ${def} when unset`, () => {
    delete process.env[key];
    expect(fn()).toBe(def);
  });

  it.each([
    ['', def], ['abc', def], ['0', def], ['-3', def], ['2.5', def],
    [String(min), min], [String(max), max], [String(max + 1000), max],
  ])(`${key}=%s → %s (garbage falls back, out-of-range clamps)`, (raw, expected) => {
    process.env[key] = raw as string;
    expect(fn()).toBe(expected);
  });
});
