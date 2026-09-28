import { describe, expect, it, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { SortedSetRedisFake } from '../__tests__/helpers/sortedSetRedisFake';
import {
  AGENT_STORAGE_DEVICE_RATE_LIMIT,
  AGENT_STORAGE_RATE_WINDOW_SECONDS,
  AGENT_STORAGE_SESSION_RATE_LIMIT,
  agentStorageSessionRateKeys,
  checkAgentStorageSessionRateLimit,
} from './agentStorageSessionRateLimit';
import { STORAGE_SESSION_CALLS_PER_MINUTE, STORAGE_SESSION_CALL_BURST } from './backupStorageSessionBudget';

const DEVICE = '3f0c2a1e-8b7d-4c6e-9a5f-1d2c3b4a5e6f';
const OTHER_DEVICE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const S1 = '0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39';
const S2 = '1c7a1d8f-4e3b-4a6c-8f2d-9b8e7d6c5b4a';
const S3 = '2d8b2e9a-5f4c-4b7d-9a3e-0c9f8e7d6c5b';
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const WINDOW_MS = AGENT_STORAGE_RATE_WINDOW_SECONDS * 1000;

let redis: SortedSetRedisFake;
const r = () => redis as unknown as Redis;

async function call(deviceId: string, sessionId: string, now: number) {
  return checkAgentStorageSessionRateLimit(r(), { deviceId, sessionId }, now);
}

async function fill(deviceId: string, sessionId: string, n: number, now: number) {
  for (let i = 0; i < n; i += 1) {
    const d = await call(deviceId, sessionId, now);
    expect(d.allowed).toBe(true);
  }
}

beforeEach(() => {
  redis = new SortedSetRedisFake();
});

describe('storage-session limiter sizing', () => {
  it('sizes the per-session gate to the session budget and the device ceiling to two full-rate sessions', () => {
    expect(AGENT_STORAGE_RATE_WINDOW_SECONDS).toBe(60);
    // One call per multipart part: 600/min is 10 parts/s, i.e. ~50 MiB/s even at
    // the 5 MiB storage minimum part size, and 640 MiB/s at the 64 MiB part size
    // the server issues.
    expect(AGENT_STORAGE_SESSION_RATE_LIMIT).toBe(600);
    expect(AGENT_STORAGE_DEVICE_RATE_LIMIT).toBe(1200);
    // The session's own token bucket admits the same rate, so neither layer
    // throttles a helper the other would admit.
    expect(STORAGE_SESSION_CALLS_PER_MINUTE).toBe(AGENT_STORAGE_SESSION_RATE_LIMIT);
    expect(STORAGE_SESSION_CALL_BURST).toBe(AGENT_STORAGE_SESSION_RATE_LIMIT);
  });
});

describe('checkAgentStorageSessionRateLimit keying', () => {
  it('keys the session bucket by device and session, and the ceiling by device', () => {
    const keys = agentStorageSessionRateKeys(DEVICE, S1.toUpperCase());
    expect(keys.session).toBe(`agent_storage_rate:session:${DEVICE}:${S1}`);
    expect(keys.device).toBe(`agent_storage_rate:device:${DEVICE}`);
    // Never shares a key with the general agent limiters.
    expect(keys.session.startsWith('agent_rate')).toBe(false);
    expect(keys.device.startsWith('agent_rate')).toBe(false);
  });

  it('folds a session id that is not a UUID into one bounded bucket per device', () => {
    const a = agentStorageSessionRateKeys(DEVICE, 'not-a-session');
    const b = agentStorageSessionRateKeys(DEVICE, 'x'.repeat(5000));
    expect(a.session).toBe(b.session);
    expect(a.session.length).toBeLessThan(120);
  });

  it('gives each session its own bucket', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    expect((await call(DEVICE, S1, T0)).allowed).toBe(false);
    expect((await call(DEVICE, S2, T0)).allowed).toBe(true);
  });

  it('keeps devices independent', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    await fill(DEVICE, S2, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    expect((await call(DEVICE, S3, T0)).allowed).toBe(false);
    expect((await call(OTHER_DEVICE, S3, T0)).allowed).toBe(true);
  });

  it('caps a device across sessions at the device ceiling', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    await fill(DEVICE, S2, AGENT_STORAGE_DEVICE_RATE_LIMIT - AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    const refused = await call(DEVICE, S3, T0 + 1000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: AGENT_STORAGE_RATE_WINDOW_SECONDS - 1 });
  });
});

describe('checkAgentStorageSessionRateLimit refusals', () => {
  it('does not record a refused request in either bucket', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    const keys = agentStorageSessionRateKeys(DEVICE, S1);
    for (let i = 0; i < 500; i += 1) {
      expect((await call(DEVICE, S1, T0 + 30_000)).allowed).toBe(false);
    }
    expect(await redis.zcard(keys.session)).toBe(AGENT_STORAGE_SESSION_RATE_LIMIT);
    expect(await redis.zcard(keys.device)).toBe(AGENT_STORAGE_SESSION_RATE_LIMIT);
  });

  it('a session refused by the device ceiling spends nothing from its own bucket', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    await fill(DEVICE, S2, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    for (let i = 0; i < 50; i += 1) expect((await call(DEVICE, S3, T0)).allowed).toBe(false);
    expect(await redis.zcard(agentStorageSessionRateKeys(DEVICE, S3).session)).toBe(0);
  });

  it('continuous retries while refused do not push recovery out: capacity returns when the window rolls', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    // A client retrying every second for the whole window.
    for (let t = T0 + 1000; t < T0 + WINDOW_MS; t += 1000) {
      expect((await call(DEVICE, S1, t)).allowed).toBe(false);
    }
    expect((await call(DEVICE, S1, T0 + WINDOW_MS)).allowed).toBe(true);
  });

  it('answers Retry-After with the time until capacity actually returns', async () => {
    // 300 calls at T0, 300 at T0+20s; a refused call at T0+25s can only be
    // admitted once the T0 entries leave the window at T0+60s.
    await fill(DEVICE, S1, 300, T0);
    await fill(DEVICE, S1, 300, T0 + 20_000);
    const refused = await call(DEVICE, S1, T0 + 25_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 35 });
    // Honouring it works; one millisecond early does not.
    expect((await call(DEVICE, S1, T0 + WINDOW_MS - 1)).allowed).toBe(false);
    expect((await call(DEVICE, S1, T0 + WINDOW_MS)).allowed).toBe(true);
  });

  it('rounds a sub-second wait up to one second', async () => {
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    expect(await call(DEVICE, S1, T0 + WINDOW_MS - 200)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('reports the later of the two buckets when both are full', async () => {
    await fill(DEVICE, S2, AGENT_STORAGE_SESSION_RATE_LIMIT, T0);
    await fill(DEVICE, S1, AGENT_STORAGE_SESSION_RATE_LIMIT, T0 + 10_000);
    // Device bucket frees at T0+60s; S1's own bucket not until T0+70s.
    expect(await call(DEVICE, S1, T0 + 15_000)).toEqual({ allowed: false, retryAfterSeconds: 55 });
  });

  it('fails closed without Redis and advertises the window', async () => {
    expect(await checkAgentStorageSessionRateLimit(null, { deviceId: DEVICE, sessionId: S1 }, T0)).toEqual({
      allowed: false,
      retryAfterSeconds: AGENT_STORAGE_RATE_WINDOW_SECONDS,
    });
  });

  it('fails closed when Redis errors', async () => {
    const broken = { multi: () => { throw new Error('connection lost'); } } as unknown as Redis;
    expect(await checkAgentStorageSessionRateLimit(broken, { deviceId: DEVICE, sessionId: S1 }, T0)).toEqual({
      allowed: false,
      retryAfterSeconds: AGENT_STORAGE_RATE_WINDOW_SECONDS,
    });
  });
});
