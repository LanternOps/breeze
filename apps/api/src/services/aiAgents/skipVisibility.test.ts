import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({
  redis: null as unknown,
}));

vi.mock('../redis', () => ({
  getRedis: () => redisState.redis,
}));

import {
  readAgentRunSkipSummary,
  recordAgentRunSkip,
  _resetSkipVisibilityForTest,
} from './skipVisibility';

/**
 * Minimal ioredis stand-in: the module only ever uses `multi()` (hincrby /
 * hsetnx / hset / expire) on the write path and `hgetall` on the read path.
 */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    let h = hashes.get(key);
    if (!h) { h = new Map(); hashes.set(key, h); }
    return h;
  };
  const expires: string[] = [];
  const multi = () => {
    const chain = {
      hincrby(key: string, field: string, by: number) {
        const h = hash(key);
        h.set(field, String(Number(h.get(field) ?? '0') + by));
        return chain;
      },
      hsetnx(key: string, field: string, value: string) {
        const h = hash(key);
        if (!h.has(field)) h.set(field, value);
        return chain;
      },
      hset(key: string, field: string, value: string) {
        hash(key).set(field, value);
        return chain;
      },
      expire(key: string, _seconds: number) {
        expires.push(key);
        return chain;
      },
      // ioredis resolves a pipeline with one [error, result] tuple per
      // command; a command-level failure (OOM, WRONGTYPE, an ACL denial) does
      // NOT reject. `execResult` lets a test model exactly that.
      exec: async () => state.execResult ?? [],
    };
    return chain;
  };
  const state: { execResult: [Error | null, unknown][] | null } = { execResult: null };
  return {
    hashes,
    expires,
    multi,
    state,
    hgetall: async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map()),
  };
}

describe('skipVisibility', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetSkipVisibilityForTest();
    redisState.redis = null;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordAgentRunSkip', () => {
    it('logs a structured warn line naming the skip reason (#5381)', () => {
      recordAgentRunSkip({
        orgId: 'org-1',
        reason: 'kill_switch_off',
        kind: 'triage',
        triggerKind: 'alert',
        alertId: 'alert-9',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('[aiAgents] run skipped');
      expect(context).toMatchObject({
        reason: 'kill_switch_off',
        orgId: 'org-1',
        kind: 'triage',
        triggerKind: 'alert',
        alertId: 'alert-9',
      });
    });

    it('throttles repeats of the same (org, reason) and reports how many it suppressed', () => {
      for (let i = 0; i < 5; i += 1) {
        recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });
      }
      // A busy alert stream must not flood the log: one line, four swallowed.
      expect(warn).toHaveBeenCalledTimes(1);

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
      recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });
      expect(warn).toHaveBeenCalledTimes(2);
      const [, context] = warn.mock.calls[1] as [string, Record<string, unknown>];
      expect(context).toMatchObject({ suppressedSinceLastLog: 4 });
    });

    it('does not throttle a DIFFERENT reason or a different org', () => {
      recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });
      recordAgentRunSkip({ orgId: 'org-1', reason: 'cooldown' });
      recordAgentRunSkip({ orgId: 'org-2', reason: 'kill_switch_off' });
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it('counts the skip in Redis so the UI can show a trace', async () => {
      const redis = fakeRedis();
      redisState.redis = redis;

      recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });
      recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });
      await vi.waitFor(() => {
        expect(redis.hashes.get('breeze:ai-agents:skips:org-1')?.get('count:kill_switch_off')).toBe('2');
      });
      expect(redis.expires).toContain('breeze:ai-agents:skips:org-1');
    });

    it('never throws when Redis is unavailable', () => {
      redisState.redis = null;
      expect(() => recordAgentRunSkip({ orgId: 'org-1', reason: 'cooldown' })).not.toThrow();
    });

    // Review finding (#5681): ioredis RESOLVES a pipeline with one
    // [error, result] tuple per command — only a connection-level failure
    // rejects. A Redis under memory pressure (`OOM command not allowed`) is
    // exactly the incident this counter exists to make visible, and a bare
    // `.catch()` would never see it: the counter would silently stop moving
    // while the banner kept reporting a summary that looked complete.
    it('logs a command-level pipeline error that ioredis reports WITHOUT rejecting', async () => {
      const redis = fakeRedis();
      redis.state.execResult = [
        [new Error("OOM command not allowed when used memory > 'maxmemory'"), null],
        [null, 1],
        [null, 'OK'],
        [null, 1],
      ];
      redisState.redis = redis;
      const error = vi.mocked(console.error);

      recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });

      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      const [message, context] = error.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('run-skip counter');
      expect(context).toMatchObject({ orgId: 'org-1', reason: 'kill_switch_off' });
    });

    it('stays quiet when every pipeline command succeeded', async () => {
      const redis = fakeRedis();
      redis.state.execResult = [[null, 1], [null, 1], [null, 'OK'], [null, 1]];
      redisState.redis = redis;

      recordAgentRunSkip({ orgId: 'org-1', reason: 'kill_switch_off' });

      await vi.waitFor(() => {
        expect(redis.hashes.get('breeze:ai-agents:skips:org-1')?.get('count:kill_switch_off')).toBe('1');
      });
      expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    });

    it('never throws when the pipeline itself rejects (connection down)', async () => {
      redisState.redis = {
        multi: () => ({
          hincrby() { return this; }, hsetnx() { return this; },
          hset() { return this; }, expire() { return this; },
          exec: async () => { throw new Error('connection is closed'); },
        }),
      };
      const error = vi.mocked(console.error);

      expect(() => recordAgentRunSkip({ orgId: 'org-1', reason: 'cooldown' })).not.toThrow();
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
    });
  });

  describe('readAgentRunSkipSummary', () => {
    it('returns null when Redis is unavailable — "unknown", never a false zero', async () => {
      redisState.redis = null;
      expect(await readAgentRunSkipSummary(['org-1'])).toBeNull();
    });

    it('returns null for an empty org list rather than an empty summary', async () => {
      redisState.redis = fakeRedis();
      expect(await readAgentRunSkipSummary([])).toBeNull();
    });

    it('aggregates counts per reason across orgs, newest reason first', async () => {
      const redis = fakeRedis();
      redisState.redis = redis;
      const now = Date.now();
      redis.hashes.set('breeze:ai-agents:skips:org-1', new Map([
        ['count:kill_switch_off', '3'],
        ['first:kill_switch_off', String(now - 5_000)],
        ['last:kill_switch_off', String(now - 1_000)],
        ['count:cooldown', '1'],
        ['first:cooldown', String(now - 9_000)],
        ['last:cooldown', String(now - 9_000)],
      ]));
      redis.hashes.set('breeze:ai-agents:skips:org-2', new Map([
        ['count:kill_switch_off', '2'],
        ['first:kill_switch_off', String(now - 8_000)],
        ['last:kill_switch_off', String(now - 500)],
      ]));

      const summary = await readAgentRunSkipSummary(['org-1', 'org-2']);
      expect(summary).not.toBeNull();
      expect(summary!.total).toBe(6);
      const [top, second] = summary!.reasons;
      expect(top).toMatchObject({
        reason: 'kill_switch_off',
        count: 5,
        // Widest span across both orgs: org-2's last, org-1's first.
        lastAt: new Date(now - 500).toISOString(),
        firstAt: new Date(now - 8_000).toISOString(),
      });
      expect(second).toMatchObject({ reason: 'cooldown', count: 1 });
    });

    it('caps the fan-out at the documented org limit rather than reading thousands of keys', async () => {
      const redis = fakeRedis();
      redisState.redis = redis;
      const reads: string[] = [];
      redis.hgetall = async (key: string) => { reads.push(key); return {}; };

      await readAgentRunSkipSummary(Array.from({ length: 60 }, (_, i) => `org-${i}`));

      // A partner-scoped caller can reach thousands of orgs; the summary is a
      // banner line, not an analytics surface.
      expect(reads).toHaveLength(25);
    });

    it('returns null when the Redis read fails — never a misleading zero', async () => {
      redisState.redis = { hgetall: async () => { throw new Error('redis down'); } };
      expect(await readAgentRunSkipSummary(['org-1'])).toBeNull();
    });
  });

});
