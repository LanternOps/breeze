import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = {
  set: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
  del: vi.fn(),
};
vi.mock('./redis', () => ({ getRedis: vi.fn(() => redisMock) }));

import { getRedis } from './redis';
import {
  AGENT_PRESENCE_TTL_MS,
  clearAgentPresence,
  clearAgentPresenceUnfenced,
  readAgentPresence,
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
});
