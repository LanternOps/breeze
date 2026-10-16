import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ map: new Map<string, string>(), ttl: new Map<string, number>(), down: false }));

vi.mock('../redis', () => ({
  getRedis: () => (store.down ? null : fakeRedis),
}));

const fakeRedis = {
  async set(k: string, v: string, _ex: string, seconds: number, nx?: string) {
    if (nx === 'NX' && store.map.has(k)) return null;
    store.map.set(k, v);
    store.ttl.set(k, seconds);
    return 'OK';
  },
  async get(k: string) { return store.map.get(k) ?? null; },
  async del(k: string) { return store.map.delete(k) ? 1 : 0; },
};

import {
  claimMessageIdempotency,
  completeMessageIdempotency,
  releaseMessageIdempotency,
} from './idempotency';
import { computeSendFingerprint } from './requestFingerprint';

const A = 'actor-1';
const M = '33333333-3333-4333-8333-333333333333';

describe('endpoint message idempotency', () => {
  beforeEach(() => { store.map.clear(); store.ttl.clear(); store.down = false; });

  it('first claim wins, a second sees in_progress while pending', async () => {
    expect(await claimMessageIdempotency(A, M, 'fp1')).toEqual({ state: 'claimed' });
    expect(await claimMessageIdempotency(A, M, 'fp1')).toEqual({ state: 'in_progress' });
  });

  it('replays the stored body once complete, for the same fingerprint', async () => {
    await claimMessageIdempotency(A, M, 'fp1');
    await completeMessageIdempotency(A, M, 'fp1', { batchId: 'b' });
    expect(await claimMessageIdempotency(A, M, 'fp1')).toEqual({ state: 'replay', body: { batchId: 'b' } });
    expect(store.ttl.get(`endpoint-msg:idem:${A}:${M}`)).toBe(86400);
  });

  it('a different fingerprint is a conflict, both while pending and once done', async () => {
    await claimMessageIdempotency(A, M, 'fp1');
    expect(await claimMessageIdempotency(A, M, 'fp2')).toEqual({ state: 'conflict' });
    await completeMessageIdempotency(A, M, 'fp1', { batchId: 'b' });
    expect(await claimMessageIdempotency(A, M, 'fp2')).toEqual({ state: 'conflict' });
  });

  it('release frees the key so the id can be reused', async () => {
    await claimMessageIdempotency(A, M, 'fp1');
    await releaseMessageIdempotency(A, M);
    expect(await claimMessageIdempotency(A, M, 'fp2')).toEqual({ state: 'claimed' });
  });

  it('keys are per actor', async () => {
    await claimMessageIdempotency(A, M, 'fp1');
    expect(await claimMessageIdempotency('actor-2', M, 'fp1')).toEqual({ state: 'claimed' });
  });

  it('fails closed (unavailable) without Redis', async () => {
    store.down = true;
    expect(await claimMessageIdempotency(A, M, 'fp1')).toEqual({ state: 'unavailable' });
  });
});

describe('computeSendFingerprint', () => {
  const base = {
    targets: { deviceIds: ['b', 'a'], siteIds: ['s'] },
    title: 't', body: 'b', severity: 'info', requiresAck: false, expiresInMinutes: 60,
  } as never;

  it('is order-insensitive for target ids and ignores confirmedCount and messageId', () => {
    const a = computeSendFingerprint(base);
    const b = computeSendFingerprint({ ...(base as object), targets: { siteIds: ['s'], deviceIds: ['a', 'b'] }, confirmedCount: 5, messageId: 'x' } as never);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['title', { title: 'u' }],
    ['body', { body: 'c' }],
    ['severity', { severity: 'critical' }],
    ['requiresAck', { requiresAck: true }],
    ['expiresInMinutes', { expiresInMinutes: null }],
    ['targets', { targets: { deviceIds: ['a'] } }],
  ])('changes with %s', (_n, over) => {
    expect(computeSendFingerprint({ ...(base as object), ...over } as never)).not.toBe(computeSendFingerprint(base));
  });
});
