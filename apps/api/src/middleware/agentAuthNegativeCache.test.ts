import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';

import { metricsRegistry } from '../services/metricsRegistry';
import {
  AGENT_AUTH_NEGATIVE_CACHE_MAX_ENTRIES,
  AGENT_AUTH_NEGATIVE_CACHE_METRIC,
  AGENT_AUTH_NEGATIVE_CACHE_TTL_MS,
  AgentAuthNegativeCache,
  MAX_CACHEABLE_AGENT_ID_LENGTH,
} from './agentAuthNegativeCache';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function counterValue(labels: Record<string, string>): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(AGENT_AUTH_NEGATIVE_CACHE_METRIC);
  if (!metric) return 0;
  const snapshot = await metric.get();
  const match = snapshot.values.find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val),
  );
  return match?.value ?? 0;
}

describe('AgentAuthNegativeCache', () => {
  it('ships the contract defaults: 60 s TTL, 10k entry cap', () => {
    expect(AGENT_AUTH_NEGATIVE_CACHE_TTL_MS).toBe(60_000);
    expect(AGENT_AUTH_NEGATIVE_CACHE_MAX_ENTRIES).toBe(10_000);
  });

  it('returns the remembered rejection for the same (surface, agentId, tokenHash)', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.remember('rest', 'agent-1', sha('brz_a'), 'tenant_denied');
    expect(cache.lookup('rest', 'agent-1', sha('brz_a'))).toBe('tenant_denied');
  });

  it('never matches a different token for the same agentId (no lockout by agentId)', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.remember('rest', 'agent-1', sha('brz_forged'), 'token_mismatch');
    expect(cache.lookup('rest', 'agent-1', sha('brz_legit'))).toBeNull();
  });

  it('never matches the same token for a different agentId', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.remember('rest', 'agent-1', sha('brz_a'), 'device_not_found');
    expect(cache.lookup('rest', 'agent-2', sha('brz_a'))).toBeNull();
  });

  it('keeps the REST and WS surfaces in separate namespaces', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.remember('rest', 'agent-1', sha('brz_a'), 'decommissioned');
    expect(cache.lookup('ws', 'agent-1', sha('brz_a'))).toBeNull();
    expect(cache.lookup('rest', 'agent-1', sha('brz_a'))).toBe('decommissioned');
  });

  it('expires entries after the TTL', () => {
    const clock = makeClock();
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10, now: clock.now });
    cache.remember('rest', 'agent-1', sha('brz_a'), 'token_suspended');

    clock.advance(59_999);
    expect(cache.lookup('rest', 'agent-1', sha('brz_a'))).toBe('token_suspended');

    clock.advance(1);
    expect(cache.lookup('rest', 'agent-1', sha('brz_a'))).toBeNull();
    // The expired entry is dropped, not just hidden.
    expect(cache.size).toBe(0);
  });

  it('a re-store refreshes the TTL from the moment of the new rejection', () => {
    const clock = makeClock();
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10, now: clock.now });
    cache.remember('rest', 'agent-1', sha('brz_a'), 'token_mismatch');
    clock.advance(50_000);
    cache.remember('rest', 'agent-1', sha('brz_a'), 'token_mismatch');
    clock.advance(50_000);
    expect(cache.lookup('rest', 'agent-1', sha('brz_a'))).toBe('token_mismatch');
  });

  it('is bounded: inserting past the cap evicts the oldest entry', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 3 });
    cache.remember('rest', 'agent-1', sha('t'), 'device_not_found');
    cache.remember('rest', 'agent-2', sha('t'), 'device_not_found');
    cache.remember('rest', 'agent-3', sha('t'), 'device_not_found');
    cache.remember('rest', 'agent-4', sha('t'), 'device_not_found');

    expect(cache.size).toBe(3);
    expect(cache.lookup('rest', 'agent-1', sha('t'))).toBeNull();
    expect(cache.lookup('rest', 'agent-2', sha('t'))).toBe('device_not_found');
    expect(cache.lookup('rest', 'agent-4', sha('t'))).toBe('device_not_found');
  });

  it('a re-stored key moves to the young end and survives the next eviction', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 2 });
    cache.remember('rest', 'agent-1', sha('t'), 'device_not_found');
    cache.remember('rest', 'agent-2', sha('t'), 'device_not_found');
    cache.remember('rest', 'agent-1', sha('t'), 'device_not_found');
    cache.remember('rest', 'agent-3', sha('t'), 'device_not_found');

    expect(cache.lookup('rest', 'agent-1', sha('t'))).toBe('device_not_found');
    expect(cache.lookup('rest', 'agent-2', sha('t'))).toBeNull();
  });

  it('does not cache an agentId longer than the agent_id column (bounds key memory)', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    const longId = 'a'.repeat(MAX_CACHEABLE_AGENT_ID_LENGTH + 1);
    cache.remember('rest', longId, sha('t'), 'device_not_found');
    expect(cache.size).toBe(0);
    expect(cache.lookup('rest', longId, sha('t'))).toBeNull();
  });

  it('clear() empties the cache', () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.remember('ws', 'agent-1', sha('t'), 'device_not_found');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('counts hit / miss / store on the shared Prometheus registry', async () => {
    const cache = new AgentAuthNegativeCache({ ttlMs: 60_000, maxEntries: 10 });
    const before = {
      miss: await counterValue({ surface: 'ws', result: 'miss' }),
      store: await counterValue({ surface: 'ws', result: 'store', rejection: 'tenant_denied' }),
      hit: await counterValue({ surface: 'ws', result: 'hit', rejection: 'tenant_denied' }),
    };

    cache.lookup('ws', 'agent-m', sha('t'));
    cache.remember('ws', 'agent-m', sha('t'), 'tenant_denied');
    cache.lookup('ws', 'agent-m', sha('t'));
    cache.lookup('ws', 'agent-m', sha('t'));

    expect(await counterValue({ surface: 'ws', result: 'miss' })).toBe(before.miss + 1);
    expect(await counterValue({ surface: 'ws', result: 'store', rejection: 'tenant_denied' })).toBe(before.store + 1);
    expect(await counterValue({ surface: 'ws', result: 'hit', rejection: 'tenant_denied' })).toBe(before.hit + 2);
  });
});
