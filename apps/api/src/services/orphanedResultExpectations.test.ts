import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn() }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));

import {
  DEGRADED_LOG_INTERVAL_MS,
  ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS,
  ORPHANED_RESULT_EXPECTATION_TTL_MS,
  consumeOrphanedResultExpectation,
  orphanedResultExpectationKey,
  peekOrphanedResultExpectation,
  recordOrphanedResultExpectation,
  resetOrphanedResultExpectationsForTests,
  type OrphanedResultExpectation,
} from './orphanedResultExpectations';

type Store = Map<string, { value: string; expiresAt: number }>;

/** A Redis that several API replicas share: TTL-aware GET / SET PX / GETDEL. */
function fakeRedis(entries: Store = new Map()) {
  const live = (key: string): string | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    entries,
    status: 'ready' as string,
    get: vi.fn(async (key: string) => live(key)),
    set: vi.fn(async (key: string, value: string, _mode: 'PX', ttlMs: number) => {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = live(key);
      entries.delete(key);
      return value;
    }),
  };
}

function snmp(agentId: string, targetId = 'snmp-device-1'): OrphanedResultExpectation {
  return { agentId, kind: 'snmp', targetId, expiresAt: Date.now() + ORPHANED_RESULT_EXPECTATION_TTL_MS };
}

describe('orphanedResultExpectations (#4135)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useRealTimers();
    getRedisMock.mockReset();
    resetOrphanedResultExpectationsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('with Redis reachable', () => {
    it('stores the expectation under an agent-scoped key with a PX TTL', async () => {
      const redis = fakeRedis();
      getRedisMock.mockReturnValue(redis);
      const expectation = snmp('agent-a');

      await recordOrphanedResultExpectation('cmd-1', expectation);

      expect(redis.set).toHaveBeenCalledWith(
        orphanedResultExpectationKey('agent-a', 'cmd-1'),
        JSON.stringify(expectation),
        'PX',
        expect.any(Number),
      );
      const ttl = redis.set.mock.calls[0]![3];
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(ORPHANED_RESULT_EXPECTATION_TTL_MS);
    });

    it('lets another replica consume what this replica recorded, exactly once', async () => {
      const shared: Store = new Map();
      getRedisMock.mockReturnValue(fakeRedis(shared));
      await recordOrphanedResultExpectation('cmd-hop', snmp('agent-a'));

      // A second API process: fresh module state, same Redis.
      vi.resetModules();
      const replicaB = await import('./orphanedResultExpectations');
      const consumed = await replicaB.consumeOrphanedResultExpectation('agent-a', 'cmd-hop');
      expect(consumed).toMatchObject({ agentId: 'agent-a', kind: 'snmp', targetId: 'snmp-device-1' });

      // Single use, on either replica.
      await expect(replicaB.consumeOrphanedResultExpectation('agent-a', 'cmd-hop')).resolves.toBeNull();
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-hop')).resolves.toBeNull();
    });

    it('never hands one agent another agent\'s expectation, and leaves it in place', async () => {
      const redis = fakeRedis();
      getRedisMock.mockReturnValue(redis);
      await recordOrphanedResultExpectation('cmd-2', snmp('agent-a'));

      await expect(consumeOrphanedResultExpectation('agent-b', 'cmd-2')).resolves.toBeNull();
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-2')).resolves.toMatchObject({ agentId: 'agent-a' });
    });

    it('uses a lazy client that has not connected yet (its first command connects it)', async () => {
      const redis = fakeRedis();
      redis.status = 'wait';
      getRedisMock.mockReturnValue(redis);

      await recordOrphanedResultExpectation('cmd-lazy', snmp('agent-a'));

      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.entries.has(orphanedResultExpectationKey('agent-a', 'cmd-lazy'))).toBe(true);
    });

    it('peeks without consuming', async () => {
      getRedisMock.mockReturnValue(fakeRedis());
      await recordOrphanedResultExpectation('cmd-3', snmp('agent-a'));

      await expect(peekOrphanedResultExpectation('agent-a', 'cmd-3')).resolves.toMatchObject({ kind: 'snmp' });
      await expect(peekOrphanedResultExpectation('agent-a', 'cmd-3')).resolves.toMatchObject({ kind: 'snmp' });
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-3')).resolves.toMatchObject({ kind: 'snmp' });
      await expect(peekOrphanedResultExpectation('agent-a', 'cmd-3')).resolves.toBeNull();
    });

    it('round-trips a probe expectation with its dispatch-time ip and site', async () => {
      getRedisMock.mockReturnValue(fakeRedis());
      const probe: OrphanedResultExpectation = {
        agentId: 'agent-a', kind: 'probe', targetId: 'asset-1', ipAddress: '192.0.2.10', siteId: 'site-1',
        expiresAt: Date.now() + 1000,
      };
      await recordOrphanedResultExpectation('probe-asset-1-x', probe);

      await expect(consumeOrphanedResultExpectation('agent-a', 'probe-asset-1-x')).resolves.toEqual(probe);
    });

    it('waits for its own in-flight write before reading', async () => {
      const redis = fakeRedis();
      let land!: () => void;
      redis.set.mockImplementationOnce(async (key: string, value: string, _mode: 'PX', ttlMs: number) => {
        await new Promise<void>((resolve) => { land = resolve; });
        redis.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        return 'OK';
      });
      getRedisMock.mockReturnValue(redis);

      void recordOrphanedResultExpectation('cmd-race', snmp('agent-a'));
      const consumed = consumeOrphanedResultExpectation('agent-a', 'cmd-race');
      await vi.waitFor(() => expect(land).toBeTypeOf('function'));
      land();

      await expect(consumed).resolves.toMatchObject({ agentId: 'agent-a' });
    });

    it('rejects a malformed or mismatched stored record', async () => {
      const redis = fakeRedis();
      getRedisMock.mockReturnValue(redis);
      const far = Date.now() + 60_000;
      redis.entries.set(orphanedResultExpectationKey('agent-a', 'bad-json'), { value: '{not json', expiresAt: far });
      redis.entries.set(orphanedResultExpectationKey('agent-a', 'bad-kind'), {
        value: JSON.stringify({ agentId: 'agent-a', kind: 'shell', targetId: 't', expiresAt: far }), expiresAt: far,
      });
      redis.entries.set(orphanedResultExpectationKey('agent-a', 'wrong-agent'), {
        value: JSON.stringify(snmp('agent-b')), expiresAt: far,
      });

      await expect(consumeOrphanedResultExpectation('agent-a', 'bad-json')).resolves.toBeNull();
      await expect(consumeOrphanedResultExpectation('agent-a', 'bad-kind')).resolves.toBeNull();
      await expect(consumeOrphanedResultExpectation('agent-a', 'wrong-agent')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable expectation'));
    });

    it('treats a failed read as no expectation, and says so', async () => {
      const redis = fakeRedis();
      redis.getdel.mockRejectedValueOnce(new Error('READONLY'));
      getRedisMock.mockReturnValue(redis);

      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-4')).resolves.toBeNull();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('READONLY'));
    });
  });

  describe('in-process fallback (Redis unavailable)', () => {
    it('holds the expectation locally when there is no Redis client, and logs once', async () => {
      getRedisMock.mockReturnValue(null);

      await recordOrphanedResultExpectation('cmd-5', snmp('agent-a'));
      await recordOrphanedResultExpectation('cmd-6', snmp('agent-a'));

      await expect(peekOrphanedResultExpectation('agent-a', 'cmd-5')).resolves.toMatchObject({ kind: 'snmp' });
      await expect(consumeOrphanedResultExpectation('agent-b', 'cmd-5')).resolves.toBeNull();
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-5')).resolves.toMatchObject({ agentId: 'agent-a' });
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-5')).resolves.toBeNull();
      const fallbackWarnings = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('in-process'));
      expect(fallbackWarnings).toHaveLength(1);
    });

    it('holds locally while the client is reconnecting', async () => {
      const redis = fakeRedis();
      redis.status = 'reconnecting';
      getRedisMock.mockReturnValue(redis);

      await recordOrphanedResultExpectation('cmd-7', snmp('agent-a'));

      expect(redis.set).not.toHaveBeenCalled();
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-7')).resolves.toMatchObject({ agentId: 'agent-a' });
    });

    it('holds locally when the client cannot be created', async () => {
      getRedisMock.mockImplementation(() => {
        throw new Error('REDIS_PASSWORD_FILE is set but could not be read');
      });

      await expect(recordOrphanedResultExpectation('cmd-13', snmp('agent-a'))).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('REDIS_PASSWORD_FILE'));
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-13')).resolves.toMatchObject({ agentId: 'agent-a' });
    });

    it('holds locally when the Redis write fails', async () => {
      const redis = fakeRedis();
      redis.set.mockRejectedValueOnce(new Error('OOM command not allowed'));
      getRedisMock.mockReturnValue(redis);

      await recordOrphanedResultExpectation('cmd-8', snmp('agent-a'));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OOM command not allowed'));
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-8')).resolves.toMatchObject({ agentId: 'agent-a' });
    });

    it('a write that timed out but landed later is still single-use', async () => {
      vi.useFakeTimers();
      const redis = fakeRedis();
      let land!: () => void;
      redis.set.mockImplementationOnce(async (key: string, value: string, _mode: 'PX', ttlMs: number) => {
        await new Promise<void>((resolve) => { land = resolve; });
        redis.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        return 'OK';
      });
      getRedisMock.mockReturnValue(redis);

      const recorded = recordOrphanedResultExpectation('cmd-late', snmp('agent-a'));
      await vi.advanceTimersByTimeAsync(ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS + 1);
      await recorded;
      land();
      await vi.advanceTimersByTimeAsync(0);
      expect(redis.entries.has(orphanedResultExpectationKey('agent-a', 'cmd-late'))).toBe(true);

      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-late')).resolves.toMatchObject({ agentId: 'agent-a' });
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-late')).resolves.toBeNull();
      expect(redis.entries.size).toBe(0);
    });

    it('expires local entries on the expectation TTL', async () => {
      vi.useFakeTimers();
      getRedisMock.mockReturnValue(null);
      await recordOrphanedResultExpectation('cmd-9', snmp('agent-a'));

      vi.setSystemTime(Date.now() + ORPHANED_RESULT_EXPECTATION_TTL_MS + 1);

      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-9')).resolves.toBeNull();
    });

    it('rate-limits degraded logs and reports how many it suppressed', async () => {
      vi.useFakeTimers();
      getRedisMock.mockReturnValue(null);
      await recordOrphanedResultExpectation('cmd-10', snmp('agent-a'));
      await recordOrphanedResultExpectation('cmd-11', snmp('agent-a'));
      await consumeOrphanedResultExpectation('agent-a', 'cmd-11');
      expect(warn).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + DEGRADED_LOG_INTERVAL_MS);
      await recordOrphanedResultExpectation('cmd-12', snmp('agent-a'));

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]![0]).toContain('2 similar event(s) suppressed');
    });

    it('says so when a read cannot reach Redis at all', async () => {
      const redis = fakeRedis();
      redis.status = 'end';
      getRedisMock.mockReturnValue(redis);

      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-14')).resolves.toBeNull();

      expect(redis.getdel).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('consume skipped Redis (Redis client is end)'));
    });
  });

  describe('bounded reads', () => {
    it.each([
      ['consume', 'getdel', consumeOrphanedResultExpectation],
      ['peek', 'get', peekOrphanedResultExpectation],
    ] as const)('a %s that outlives the timeout fails closed and is logged', async (operation, command, read) => {
      vi.useFakeTimers();
      const redis = fakeRedis();
      redis[command].mockImplementationOnce(() => new Promise<string | null>(() => {}));
      getRedisMock.mockReturnValue(redis);

      const outcome = read('agent-a', `cmd-stall-${operation}`);
      await vi.advanceTimersByTimeAsync(ORPHANED_RESULT_EXPECTATION_REDIS_TIMEOUT_MS + 1);

      await expect(outcome).resolves.toBeNull();
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`${operation} timed out`));
    });

    it('ignores a stored record whose expiry has passed', async () => {
      const redis = fakeRedis();
      getRedisMock.mockReturnValue(redis);
      const stale = { ...snmp('agent-a'), expiresAt: Date.now() - 1 };
      redis.entries.set(orphanedResultExpectationKey('agent-a', 'cmd-stale'), {
        value: JSON.stringify(stale), expiresAt: Date.now() + 60_000,
      });

      await expect(peekOrphanedResultExpectation('agent-a', 'cmd-stale')).resolves.toBeNull();
      await expect(consumeOrphanedResultExpectation('agent-a', 'cmd-stale')).resolves.toBeNull();
    });
  });
});
