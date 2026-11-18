import { afterEach, describe, expect, it } from 'vitest';

import {
  mcpMessageRateLimitPerMinute,
  mcpTaskPendingPollIntervalMs,
  mcpTaskPollIntervalMs,
  mcpTaskTtlGraceMs,
  mcpTasksEffective,
  mcpTasksEnabled,
} from './mcpIntentConfig';

const KEYS = [
  'MCP_TASKS_ENABLED',
  'MCP_STATELESS_ENABLED',
  'MCP_TASK_PENDING_POLL_INTERVAL_MS',
  'MCP_TASK_POLL_INTERVAL_MS',
  'MCP_TASK_TTL_GRACE_MS',
  'MCP_MESSAGE_RATE_LIMIT_PER_MINUTE',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function set(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

describe('MCP Tasks flag (B-W06 #6160, D-B55)', () => {
  it('is off by default', () => {
    set({});
    expect(mcpTasksEnabled()).toBe(false);
    expect(mcpTasksEffective()).toBe(false);
  });

  it.each([
    [{ MCP_TASKS_ENABLED: 'true', MCP_STATELESS_ENABLED: 'true' }, true, true],
    [{ MCP_TASKS_ENABLED: 'on', MCP_STATELESS_ENABLED: '1' }, true, true],
    [{ MCP_TASKS_ENABLED: 'true' }, true, false],
    [{ MCP_TASKS_ENABLED: 'true', MCP_STATELESS_ENABLED: 'false' }, true, false],
    [{ MCP_STATELESS_ENABLED: 'true' }, false, false],
    [{ MCP_TASKS_ENABLED: 'ture', MCP_STATELESS_ENABLED: 'true' }, false, false],
  ])('%j → enabled %s, effective %s', (env, enabled, effective) => {
    set(env);
    expect(mcpTasksEnabled()).toBe(enabled);
    expect(mcpTasksEffective()).toBe(effective);
  });

  it('is read per call', () => {
    set({ MCP_STATELESS_ENABLED: 'true' });
    expect(mcpTasksEffective()).toBe(false);
    process.env.MCP_TASKS_ENABLED = 'true';
    expect(mcpTasksEffective()).toBe(true);
  });
});

describe('MCP Tasks knobs (B-W06 #6160, D-B55)', () => {
  it('defaults: 30 s pending, 5 s running, 1 h grace, 120/min', () => {
    set({});
    expect(mcpTaskPendingPollIntervalMs()).toBe(30_000);
    expect(mcpTaskPollIntervalMs()).toBe(5_000);
    expect(mcpTaskTtlGraceMs()).toBe(3_600_000);
    expect(mcpMessageRateLimitPerMinute()).toBe(120);
  });

  it.each([
    ['MCP_TASK_PENDING_POLL_INTERVAL_MS', mcpTaskPendingPollIntervalMs, '1', 1_000, '999999999', 600_000],
    ['MCP_TASK_POLL_INTERVAL_MS', mcpTaskPollIntervalMs, '10', 1_000, '999999', 60_000],
    ['MCP_TASK_TTL_GRACE_MS', mcpTaskTtlGraceMs, '5', 60_000, '999999999999', 86_400_000],
  ] as const)('%s clamps to its range', (key, read, low, lowOut, high, highOut) => {
    set({ [key]: low });
    expect(read()).toBe(lowOut);
    set({ [key]: high });
    expect(read()).toBe(highOut);
  });

  it.each(['abc', '-5', '1.5', '0', ''])('an invalid value falls back to the default: %j', (raw) => {
    set({ MCP_TASK_POLL_INTERVAL_MS: raw, MCP_TASK_PENDING_POLL_INTERVAL_MS: raw, MCP_TASK_TTL_GRACE_MS: raw });
    expect(mcpTaskPollIntervalMs()).toBe(5_000);
    expect(mcpTaskPendingPollIntervalMs()).toBe(30_000);
    expect(mcpTaskTtlGraceMs()).toBe(3_600_000);
  });

  it.each([
    ['300', 300], ['abc', 120], ['', 120], ['5e3', 5], ['90 per min', 90], ['0', 0],
  ])('MCP_MESSAGE_RATE_LIMIT_PER_MINUTE=%j → %s (the limiter\'s historical parseInt semantics)', (raw, expected) => {
    set({ MCP_MESSAGE_RATE_LIMIT_PER_MINUTE: raw });
    expect(mcpMessageRateLimitPerMinute()).toBe(expected);
  });
});
