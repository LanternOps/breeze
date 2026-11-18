import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = {
  set: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
  del: vi.fn(),
  mget: vi.fn(),
};
vi.mock('./redis', () => ({ getRedis: vi.fn(() => redisMock) }));

import { getRedis } from './redis';
import {
  AGENT_PRESENCE_TTL_MS,
  clearAgentPresence,
  clearAgentPresenceUnfenced,
  probeAgentPresence,
  PRESENCE_BATCH_READ_SIZE,
  readAgentPresence,
  readAgentPresenceBatch,
  refreshAgentPresence,
  setAgentPresence,
} from './agentPresence';

describe('agentPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() resets call history but not a prior mockReturnValue —
    // re-anchor to the live redisMock so the "Redis unavailable" test's
    // `mockReturnValue(null)` doesn't leak into later tests.
    vi.mocked(getRedis).mockReturnValue(redisMock as never);
  });

  it('setAgentPresence SETs JSON with PX TTL', async () => {
    await setAgentPresence('agent-1', { instanceId: 'i-1', connectionToken: 't-1' });
    expect(redisMock.set).toHaveBeenCalledWith(
      'agent-presence:agent-1',
      JSON.stringify({ instanceId: 'i-1', connectionToken: 't-1' }),
      'PX',
      AGENT_PRESENCE_TTL_MS,
    );
  });

  it('refreshAgentPresence evals the compare-refresh Lua with token + TTL and maps 1→true, 0→false', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await refreshAgentPresence('agent-1', 't-1')).toBe(true);
    expect(await refreshAgentPresence('agent-1', 't-2')).toBe(false);
    const [script, numKeys, key, token, ttl] = redisMock.eval.mock.calls[0]!;
    expect(script).toContain('PEXPIRE');
    expect(numKeys).toBe(1);
    expect(key).toBe('agent-presence:agent-1');
    expect(token).toBe('t-1');
    expect(ttl).toBe(String(AGENT_PRESENCE_TTL_MS));
  });

  it('clearAgentPresence deletes only when the token matches (Lua DEL script)', async () => {
    redisMock.eval.mockResolvedValueOnce(1);
    expect(await clearAgentPresence('agent-1', 't-1')).toBe(true);
    expect(redisMock.eval.mock.calls[0]![0]).toContain("redis.call('DEL', KEYS[1])");
  });

  it('readAgentPresence parses the lease and returns null on missing/corrupt', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ instanceId: 'i-1', connectionToken: 't-1' }));
    expect(await readAgentPresence('agent-1')).toEqual({ instanceId: 'i-1', connectionToken: 't-1' });
    redisMock.get.mockResolvedValueOnce(null);
    expect(await readAgentPresence('agent-1')).toBeNull();
    redisMock.get.mockResolvedValueOnce('{not json');
    expect(await readAgentPresence('agent-1')).toBeNull();
  });

  it('clearAgentPresenceUnfenced unconditionally DELs the key (no token check)', async () => {
    await clearAgentPresenceUnfenced('agent-1');
    expect(redisMock.del).toHaveBeenCalledWith('agent-presence:agent-1');
  });

  it('every helper is a safe no-op when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null as never);
    await expect(setAgentPresence('a', { instanceId: 'i', connectionToken: 't' })).resolves.toBeUndefined();
    await expect(refreshAgentPresence('a', 't')).resolves.toBe(false);
    await expect(clearAgentPresence('a', 't')).resolves.toBe(false);
    await expect(readAgentPresence('a')).resolves.toBeNull();
    await expect(clearAgentPresenceUnfenced('a')).resolves.toBeUndefined();
  });

  it('helpers swallow Redis errors (log, never throw)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisMock.set.mockRejectedValueOnce(new Error('boom'));
    await expect(setAgentPresence('a', { instanceId: 'i', connectionToken: 't' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  // #8318 §6.5: the reattach confirm must tell "no lease" from "cannot read".
  it('probeAgentPresence: present / absent / unavailable (no Redis, a throwing getRedis, a failed read)', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ instanceId: 'i', connectionToken: 't' }));
    await expect(probeAgentPresence('a')).resolves.toEqual({ present: true });
    expect(redisMock.get).toHaveBeenLastCalledWith('agent-presence:a');
    redisMock.get.mockResolvedValueOnce(null);
    await expect(probeAgentPresence('a')).resolves.toEqual({ present: false });
    redisMock.get.mockRejectedValueOnce(new Error('boom'));
    await expect(probeAgentPresence('a')).resolves.toEqual({ unavailable: true });
    vi.mocked(getRedis).mockReturnValueOnce(null as never);
    await expect(probeAgentPresence('a')).resolves.toEqual({ unavailable: true });
    vi.mocked(getRedis).mockImplementationOnce(() => { throw new Error('not initialised'); });
    await expect(probeAgentPresence('a')).resolves.toEqual({ unavailable: true });
  });

  // #4142 W2: the eviction producer routes many agents at once and must tell
  // "no lease" apart from "Redis could not answer".
  describe('readAgentPresenceBatch', () => {
    it('reads leases with MGET, mapping absent and malformed values to null', async () => {
      redisMock.mget.mockResolvedValueOnce([
        JSON.stringify({ instanceId: 'i-1', connectionToken: 't-1' }),
        null,
        'not json',
        JSON.stringify({ instanceId: 7 }),
      ]);

      const leases = await readAgentPresenceBatch(['a-1', 'a-2', 'a-3', 'a-4']);

      expect(redisMock.mget).toHaveBeenCalledWith(
        'agent-presence:a-1', 'agent-presence:a-2', 'agent-presence:a-3', 'agent-presence:a-4',
      );
      expect([...leases.entries()]).toEqual([
        ['a-1', { instanceId: 'i-1', connectionToken: 't-1' }],
        ['a-2', null],
        ['a-3', null],
        ['a-4', null],
      ]);
    });

    it('reads in chunks of PRESENCE_BATCH_READ_SIZE and de-duplicates ids', async () => {
      const ids = Array.from({ length: PRESENCE_BATCH_READ_SIZE + 3 }, (_, i) => `a-${i}`);
      redisMock.mget.mockImplementation(async (...keys: string[]) => keys.map(() => null));

      const leases = await readAgentPresenceBatch([...ids, 'a-0']);

      expect(redisMock.mget).toHaveBeenCalledTimes(2);
      expect(redisMock.mget.mock.calls[0]).toHaveLength(PRESENCE_BATCH_READ_SIZE);
      expect(redisMock.mget.mock.calls[1]).toHaveLength(3);
      expect(leases.size).toBe(ids.length);
    });

    it('throws when Redis fails: a failure is never collapsed into absence', async () => {
      redisMock.mget.mockRejectedValueOnce(new Error('redis down'));
      await expect(readAgentPresenceBatch(['a-1'])).rejects.toThrow('redis down');
    });

    it('throws when no Redis client is configured', async () => {
      vi.mocked(getRedis).mockReturnValue(null as never);
      await expect(readAgentPresenceBatch(['a-1'])).rejects.toThrow(/Redis/);
    });

    it('answers an empty map for no ids without touching Redis', async () => {
      await expect(readAgentPresenceBatch([])).resolves.toEqual(new Map());
      expect(redisMock.mget).not.toHaveBeenCalled();
    });
  });
});
