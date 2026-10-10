import { describe, it, expect, vi } from 'vitest';

const { createGuardedFetch, createEdrRateLimiter } = vi.hoisted(() => ({
  createGuardedFetch: vi.fn(() => 'FETCH'),
  createEdrRateLimiter: vi.fn(() => 'LIMITER'),
}));
vi.mock('./guardedFetch', () => ({ createGuardedFetch }));
vi.mock('./rateLimiter', () => ({ createEdrRateLimiter }));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));

import { buildEdrAdapterContext } from './context';
import { credentialFingerprint } from './credentials';
import type { EdrProviderAdapter } from './types';

const adapter = {
  key: 'bitdefender',
  hostAllowlist: ['.gravityzone.bitdefender.com'],
  capabilities: {
    requestBudget: { perSecond: 10 },
    operationBudgets: { incidents: { perMinute: 2 } },
  },
} as unknown as EdrProviderAdapter;

describe('buildEdrAdapterContext', () => {
  it('wires the allowlisted fetch, a fingerprint-keyed limiter and a fresh runCache', () => {
    const creds = { apiKey: 'k' };
    const redis = {} as never;
    const a = buildEdrAdapterContext(adapter, { creds, baseUrl: 'https://x', region: null, vendorRootId: 'root', redis });
    const b = buildEdrAdapterContext(adapter, { creds, baseUrl: null, region: 'eu', vendorRootId: 'root', redis });
    expect(createGuardedFetch).toHaveBeenCalledWith(['.gravityzone.bitdefender.com']);
    expect(createEdrRateLimiter).toHaveBeenCalledWith({
      redis,
      fingerprint: credentialFingerprint('bitdefender', null, creds),
      budget: { perSecond: 10 },
      operationBudgets: { incidents: { perMinute: 2 } },
    });
    expect(a).toMatchObject({ creds, baseUrl: 'https://x', region: null, fetch: 'FETCH', limiter: 'LIMITER' });
    expect(a.runCache).toBeInstanceOf(Map);
    expect(a.runCache).not.toBe(b.runCache);
  });

  it('L1: one key -> one budget, regardless of vendorRootId (testConnection has none, sync has one)', () => {
    const creds = { apiKey: 'k' };
    createEdrRateLimiter.mockClear();
    buildEdrAdapterContext(adapter, { creds, baseUrl: null, region: null, vendorRootId: null, redis: null });
    buildEdrAdapterContext(adapter, { creds, baseUrl: null, region: null, vendorRootId: 'root', redis: null });
    const [a, b] = createEdrRateLimiter.mock.calls.map((c) => (c as unknown as [{ fingerprint: string }])[0].fingerprint);
    expect(a).toBe(b);
  });
});
