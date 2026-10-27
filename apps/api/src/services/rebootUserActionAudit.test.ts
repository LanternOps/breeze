import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const redis = vi.hoisted(() => ({ status: 'ready', set: vi.fn() }));
const redisState = vi.hoisted(() => ({ available: true, throws: false }));
vi.mock('./redis', () => ({
  getRedis: () => {
    if (redisState.throws) throw new Error('client construction failed');
    return redisState.available ? redis : null;
  },
}));

const writeAuditEvent = vi.hoisted(() => vi.fn());
vi.mock('./auditEvents', () => ({ writeAuditEvent }));

import {
  REBOOT_USER_ACTION_DEDUPE_TTL_SECONDS,
  REBOOT_USER_ACTION_MAX_AGE_MS,
  REBOOT_USER_ACTION_MAX_FUTURE_SKEW_MS,
  __resetRebootUserActionLogThrottleForTests,
  rebootUserActionKey,
  recordRebootUserAction,
  type RebootUserActionContext,
} from './rebootUserActionAudit';

const DEVICE = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-27T12:00:00.000Z');
const AT = NOW.getTime() - 90_000;
const SCHEDULED_AT = '2026-10-27T13:00:00.000Z';
const requestLike = { req: { header: () => undefined } };

function context(overrides: Partial<RebootUserActionContext> = {}): RebootUserActionContext {
  return {
    c: requestLike,
    scheduledAt: SCHEDULED_AT,
    deferralsUsed: 1,
    maxDeferrals: 3,
    now: NOW,
    ...overrides,
  };
}

/** A tiny in-memory stand-in for Redis `SET key value EX ttl NX`. */
function nxStore() {
  const keys = new Set<string>();
  redis.set.mockImplementation(async (key: string, _value: string, ...args: unknown[]) => {
    if (args.includes('NX') && keys.has(key)) return null;
    keys.add(key);
    return 'OK';
  });
  return keys;
}

let warn: MockInstance;
let error: MockInstance;

beforeEach(() => {
  vi.resetAllMocks();
  redis.status = 'ready';
  redisState.available = true;
  redisState.throws = false;
  __resetRebootUserActionLogThrottleForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('rebootUserActionKey', () => {
  it('is reboot-user-action:<deviceId>:<atUnixMs>', () => {
    expect(rebootUserActionKey(DEVICE, AT)).toBe(`reboot-user-action:${DEVICE}:${AT}`);
  });
});

describe('recordRebootUserAction', () => {
  it('postpone audit written once per atUnixMs', async () => {
    nxStore();
    const action = { action: 'postponed' as const, atUnixMs: AT, renderer: 'assist' as const };

    // The agent re-sends the same decision on every beat while the restart is
    // scheduled: only the first one writes a row.
    expect(await recordRebootUserAction(DEVICE, ORG, action, context())).toBe('written');
    expect(await recordRebootUserAction(DEVICE, ORG, action, context())).toBe('duplicate');
    expect(await recordRebootUserAction(DEVICE, ORG, action, context())).toBe('duplicate');
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      action: 'device.reboot.user_postponed',
      resourceType: 'device',
      resourceId: DEVICE,
      actorType: 'agent',
      result: 'success',
      details: {
        renderer: 'assist',
        deferralsUsed: 1,
        maxDeferrals: 3,
        scheduledAt: SCHEDULED_AT,
        decidedAt: new Date(AT).toISOString(),
      },
    });

    // A later decision (a second Postpone) is a new row.
    const later = { ...action, atUnixMs: AT + 60_000 };
    expect(await recordRebootUserAction(DEVICE, ORG, later, context())).toBe('written');
    expect(writeAuditEvent).toHaveBeenCalledTimes(2);
  });

  it('dedupes with SET NX and a 7-day expiry on the device + decision-time key', async () => {
    redis.set.mockResolvedValue('OK');
    await recordRebootUserAction(DEVICE, ORG, { action: 'postponed', atUnixMs: AT, renderer: 'native' }, context());
    expect(REBOOT_USER_ACTION_DEDUPE_TTL_SECONDS).toBe(604_800);
    expect(redis.set).toHaveBeenCalledWith(`reboot-user-action:${DEVICE}:${AT}`, '1', 'EX', 604_800, 'NX');
  });

  it('dedupe is per device', async () => {
    nxStore();
    const action = { action: 'postponed' as const, atUnixMs: AT, renderer: 'assist' as const };
    const other = '44444444-4444-4444-8444-444444444444';
    expect(await recordRebootUserAction(DEVICE, ORG, action, context())).toBe('written');
    expect(await recordRebootUserAction(other, ORG, action, context())).toBe('written');
    expect(writeAuditEvent).toHaveBeenCalledTimes(2);
  });

  it('restart_now audit carries renderer', async () => {
    redis.set.mockResolvedValue('OK');
    const outcome = await recordRebootUserAction(
      DEVICE,
      ORG,
      { action: 'restart_now', atUnixMs: AT, renderer: 'native' },
      context({ deferralsUsed: 3, maxDeferrals: 3 }),
    );
    expect(outcome).toBe('written');
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const [c, event] = writeAuditEvent.mock.calls[0]!;
    // The agent request is what the IP / user-agent attribution reads.
    expect(c).toBe(requestLike);
    expect(event).toMatchObject({
      action: 'device.reboot.user_restart_now',
      actorType: 'agent',
      details: { renderer: 'native', deferralsUsed: 3, maxDeferrals: 3, scheduledAt: SCHEDULED_AT },
    });
  });

  it('records missing counters as null rather than dropping the keys', async () => {
    redis.set.mockResolvedValue('OK');
    await recordRebootUserAction(
      DEVICE,
      ORG,
      { action: 'postponed', atUnixMs: AT, renderer: 'headless' },
      context({ deferralsUsed: undefined, maxDeferrals: undefined }),
    );
    expect(writeAuditEvent.mock.calls[0]![1].details).toEqual({
      renderer: 'headless',
      deferralsUsed: null,
      maxDeferrals: null,
      scheduledAt: SCHEDULED_AT,
      decidedAt: new Date(AT).toISOString(),
    });
  });

  it('stale action ignored', async () => {
    redis.set.mockResolvedValue('OK');
    expect(REBOOT_USER_ACTION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    const stale = NOW.getTime() - REBOOT_USER_ACTION_MAX_AGE_MS - 1;
    const outcome = await recordRebootUserAction(
      DEVICE,
      ORG,
      { action: 'postponed', atUnixMs: stale, renderer: 'assist' },
      context(),
    );
    expect(outcome).toBe('stale');
    // Ignored before Redis: a stale decision must not even claim a key.
    expect(redis.set).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('accepts a decision exactly 24 h old', async () => {
    redis.set.mockResolvedValue('OK');
    const edge = NOW.getTime() - REBOOT_USER_ACTION_MAX_AGE_MS;
    expect(
      await recordRebootUserAction(DEVICE, ORG, { action: 'postponed', atUnixMs: edge, renderer: 'assist' }, context()),
    ).toBe('written');
  });

  it('ignores a decision dated more than 5 minutes in the future, accepts clock skew within it', async () => {
    redis.set.mockResolvedValue('OK');
    expect(REBOOT_USER_ACTION_MAX_FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
    const tooFar = NOW.getTime() + REBOOT_USER_ACTION_MAX_FUTURE_SKEW_MS + 1;
    expect(
      await recordRebootUserAction(DEVICE, ORG, { action: 'restart_now', atUnixMs: tooFar, renderer: 'assist' }, context()),
    ).toBe('future');
    expect(redis.set).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();

    const skewed = NOW.getTime() + REBOOT_USER_ACTION_MAX_FUTURE_SKEW_MS;
    expect(
      await recordRebootUserAction(DEVICE, ORG, { action: 'restart_now', atUnixMs: skewed, renderer: 'assist' }, context()),
    ).toBe('written');
  });

  it('writes no audit when the NX set does not succeed', async () => {
    redis.set.mockResolvedValue(null);
    const outcome = await recordRebootUserAction(
      DEVICE,
      ORG,
      { action: 'postponed', atUnixMs: AT, renderer: 'assist' },
      context(),
    );
    expect(outcome).toBe('duplicate');
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('a Redis error is warned and never thrown, and writes no audit', async () => {
    redis.set.mockRejectedValue(new Error('READONLY You cannot write against a read only replica.'));
    await expect(
      recordRebootUserAction(DEVICE, ORG, { action: 'postponed', atUnixMs: AT, renderer: 'assist' }, context()),
    ).resolves.toBe('redis_error');
    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(DEVICE);
  });

  it('skips with a warning when Redis is unavailable, not ready, or the client throws', async () => {
    const action = { action: 'postponed' as const, atUnixMs: AT, renderer: 'assist' as const };

    redisState.available = false;
    expect(await recordRebootUserAction(DEVICE, ORG, action, context())).toBe('redis_unavailable');

    redisState.available = true;
    redis.status = 'reconnecting';
    __resetRebootUserActionLogThrottleForTests();
    expect(await recordRebootUserAction(DEVICE, ORG, action, context())).toBe('redis_unavailable');
    // A client that is not ready is never handed the command: its offline
    // queue would replay it later, after this beat has already given up.
    expect(redis.set).not.toHaveBeenCalled();

    redis.status = 'ready';
    redisState.throws = true;
    __resetRebootUserActionLogThrottleForTests();
    await expect(recordRebootUserAction(DEVICE, ORG, action, context())).resolves.toBe('redis_error');

    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('throttles the Redis warning so an outage cannot flood the log', async () => {
    redisState.available = false;
    const action = { action: 'postponed' as const, atUnixMs: AT, renderer: 'assist' as const };
    for (let i = 0; i < 5; i++) await recordRebootUserAction(DEVICE, ORG, action, context());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an audit writer failure is logged and never thrown', async () => {
    redis.set.mockResolvedValue('OK');
    writeAuditEvent.mockImplementation(() => {
      throw new Error('sanitizer exploded');
    });
    await expect(
      recordRebootUserAction(DEVICE, ORG, { action: 'restart_now', atUnixMs: AT, renderer: 'assist' }, context()),
    ).resolves.toBe('audit_error');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
