import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// UNAUTHENTICATED route; the per-connection secret is the whole defence. The
// REAL bitdefender adapter (via the real registry) verifies, so these tests
// prove the secret check end to end. DB, crypto, limiter, hint store and queue
// are mocked.
const m = vi.hoisted(() => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: new Date() })),
  recordEdrHint: vi.fn(async () => true),
  enqueueEdrSync: vi.fn(async () => 'job-1'),
  decryptEdrSecret: vi.fn((): unknown => 'q9Hk3bQ0V4m2Zc8pXw7tYr1uNs6aLd5eFg0hJiKoMlP'),
  row: null as null | Record<string, unknown>,
  depth: 0,
  recordDepths: [] as number[],
  enqueueDepths: [] as number[],
  insert: vi.fn(),
  update: vi.fn(),
  persistDetections: vi.fn(),
}));

vi.mock('../../services/rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({ fake: 'redis' }) }));
vi.mock('../../services/edrProviders/credentials', () => ({ decryptEdrSecret: m.decryptEdrSecret }));
vi.mock('../../services/edrProviders/hints', () => ({
  recordEdrHint: (...a: unknown[]) => { m.recordDepths.push(m.depth); return (m.recordEdrHint as (...x: unknown[]) => unknown)(...a); },
}));
vi.mock('../../jobs/edrProviderSync', () => ({
  enqueueEdrSync: (...a: unknown[]) => { m.enqueueDepths.push(m.depth); return (m.enqueueEdrSync as (...x: unknown[]) => unknown)(...a); },
}));
vi.mock('../../services/edrProviders/persist', () => ({ persistDetections: m.persistDetections }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'limit']) chain[k] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(m.row ? [m.row] : []).then(res);
  return {
    db: { select: vi.fn(() => chain), insert: m.insert, update: m.update },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => {
      m.depth += 1;
      try { return await fn(); } finally { m.depth -= 1; }
    }),
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => {
      const saved = m.depth; m.depth = 0;
      try { return await fn(); } finally { m.depth = saved; }
    }),
  };
});

import { withSystemDbAccessContext } from '../../db';
import { EDR_WEBHOOK_RATE_LIMIT, edrWebhookRoutes } from './edr';

const ID = '7d2b1c4e-0a3f-4b5c-9d6e-1f2a3b4c5d6e';
const SECRET = 'q9Hk3bQ0V4m2Zc8pXw7tYr1uNs6aLd5eFg0hJiKoMlP';
const FIXTURE = readFileSync(
  join(__dirname, '../../services/edrProviders/bitdefender/__fixtures__/push-event-add-events.json'), 'utf8',
);
const ACTIVE = { id: ID, provider: 'bitdefender', isActive: true, pushEnabled: true, webhookSecretEncrypted: 'sealed' };

function post(path: string, o: { auth?: string | null; body?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.auth !== null) headers.authorization = o.auth ?? SECRET;
  return edrWebhookRoutes.request(path, { method: 'POST', headers, body: o.body ?? FIXTURE });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.row = { ...ACTIVE };
  m.depth = 0; m.recordDepths = []; m.enqueueDepths = [];
  m.rateLimiter.mockResolvedValue({ allowed: true, remaining: 59, resetAt: new Date() });
  m.recordEdrHint.mockResolvedValue(true);
  m.enqueueEdrSync.mockResolvedValue('job-1');
  m.decryptEdrSecret.mockReturnValue(SECRET);
});

const expectNothingRecorded = () => {
  expect(m.recordEdrHint).not.toHaveBeenCalled();
  expect(m.enqueueEdrSync).not.toHaveBeenCalled();
};

describe('POST /webhooks/edr/:connectionId — handler order', () => {
  it('1. a non-uuid id -> 404 before the limiter or any DB read', async () => {
    for (const p of ['/edr/not-a-uuid', `/edr/${ID}x`, '/edr/12345']) {
      const res = await post(p);
      expect(res.status).toBe(404);
    }
    expect(m.rateLimiter).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expectNothingRecorded();
  });

  it(`2. per-connection limit (${EDR_WEBHOOK_RATE_LIMIT}/min) is checked BEFORE any DB read -> 429`, async () => {
    m.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) });
    const res = await post(`/edr/${ID}`);
    expect(res.status).toBe(429);
    expect(m.rateLimiter).toHaveBeenCalledWith({ fake: 'redis' }, `edr-webhook:${ID}`, 60, 60);
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expectNothingRecorded();
  });

  it('2b. the limiter key is case-normalised (one bucket per connection)', async () => {
    await post(`/edr/${ID.toUpperCase()}`);
    expect(m.rateLimiter).toHaveBeenCalledWith(expect.anything(), `edr-webhook:${ID}`, 60, 60);
  });

  it('4. missing / inactive / push-disabled / unknown-provider connections get ONE uniform 404', async () => {
    const bodies: string[] = [];
    for (const row of [null, { ...ACTIVE, isActive: false }, { ...ACTIVE, pushEnabled: false }, { ...ACTIVE, provider: 'nope' }]) {
      m.row = row;
      const res = await post(`/edr/${ID}`);
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(m.decryptEdrSecret).not.toHaveBeenCalled();
    expectNothingRecorded();
  });

  it('5. no stored secret -> 403; an undecryptable secret -> 403; neither verifies', async () => {
    m.row = { ...ACTIVE, webhookSecretEncrypted: null };
    expect((await post(`/edr/${ID}`)).status).toBe(403);
    m.row = { ...ACTIVE };
    m.decryptEdrSecret.mockImplementation(() => { throw new Error('bad aad'); });
    expect((await post(`/edr/${ID}`)).status).toBe(403);
    m.decryptEdrSecret.mockReturnValue({ not: 'a string' });
    expect((await post(`/edr/${ID}`)).status).toBe(403);
    expectNothingRecorded();
  });

  it('5b. the secret is decrypted with the row-bound spec and the ROW id', async () => {
    await post(`/edr/${ID.toUpperCase()}`);
    expect(m.decryptEdrSecret).toHaveBeenCalledWith('connection_webhook_secret', ID, 'sealed');
  });

  it.each([
    ['wrong secret', `${SECRET}x`],
    ['empty secret', ''],
    ['missing header', null],
    ['bearer-shaped token', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'],
  ])('6. %s -> 401 with a uniform body; nothing reaches recordEdrHint or enqueueEdrSync', async (_n, auth) => {
    const res = await post(`/edr/${ID}`, { auth });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expectNothingRecorded();
  });

  it('7. a valid push -> hint recorded OUTSIDE any DB context, one detections enqueue, 202 { accepted: true }', async () => {
    const res = await post(`/edr/${ID}`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(m.recordEdrHint).toHaveBeenCalledTimes(1);
    expect(m.recordEdrHint).toHaveBeenCalledWith(ID, [
      { vendorTenantId: '5f0a1b2c3d4e5f60718293a1' },
      { vendorTenantId: '5f0a1b2c3d4e5f60718293a2', vendorDetectionId: '6b0000000000000000000c01' },
    ], { fake: 'redis' });
    expect(m.enqueueEdrSync).toHaveBeenCalledTimes(1);
    expect(m.enqueueEdrSync).toHaveBeenCalledWith(ID, 'detections');
    expect(m.recordDepths).toEqual([0]);
    expect(m.enqueueDepths).toEqual([0]);
    expect(m.recordEdrHint.mock.invocationCallOrder[0]!).toBeLessThan(m.enqueueEdrSync.mock.invocationCallOrder[0]!);
  });

  it('a valid push carrying a fake detection payload writes NO detection (no insert, no persist) and passes only ids', async () => {
    const forged = JSON.stringify({
      jsonrpc: '2.0', method: 'addEvents',
      params: { events: [{ module: 'new-incident', companyId: 'c0ffee', incidentId: 'i1', severity: 'critical',
        title: 'FORGED', detections: [{ vendorDetectionId: 'x', status: 'resolved' }] }] },
    });
    const res = await post(`/edr/${ID}`, { body: forged });
    expect(res.status).toBe(202);
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.persistDetections).not.toHaveBeenCalled();
    expect(m.recordEdrHint).toHaveBeenCalledWith(ID, [{ vendorTenantId: 'c0ffee', vendorDetectionId: 'i1' }], expect.anything());
  });

  it('the body is never echoed in a response and never logged', async () => {
    const marker = 'UNIQUE-BODY-MARKER-91f3';
    const body = JSON.stringify({ method: 'addEvents', params: { events: [{ companyId: 'c1', note: marker }] } });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      m.recordEdrHint.mockRejectedValueOnce(new Error('pg down'));
      for (const auth of [SECRET, 'wrong', SECRET]) {
        const res = await post(`/edr/${ID}`, { auth, body });
        expect(await res.text()).not.toContain(marker);
      }
      for (const s of spies) {
        for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(marker);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('a hint-store failure -> 503 (vendor may retry), no enqueue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.recordEdrHint.mockRejectedValue(new Error('pg down'));
    const res = await post(`/edr/${ID}`);
    expect(res.status).toBe(503);
    expect(m.enqueueEdrSync).not.toHaveBeenCalled();
  });

  it('a connection disabled between the lookup and the record (recordEdrHint false) -> uniform 404, no enqueue', async () => {
    m.recordEdrHint.mockResolvedValue(false);
    const res = await post(`/edr/${ID}`);
    expect(res.status).toBe(404);
    expect(m.enqueueEdrSync).not.toHaveBeenCalled();
  });

  it('an enqueue failure still answers 202: the durable marker makes the next sync-all tick pick it up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.enqueueEdrSync.mockRejectedValue(new Error('redis down'));
    const res = await post(`/edr/${ID}`);
    expect(res.status).toBe(202);
    expect(m.recordEdrHint).toHaveBeenCalledTimes(1);
  });

  it('only POST /edr/<uuid> exists (no GET, no trailing segment)', async () => {
    expect((await edrWebhookRoutes.request(`/edr/${ID}`, { method: 'GET' })).status).toBe(404);
    expect((await post(`/edr/${ID}/extra`)).status).toBe(404);
    expect(m.rateLimiter).not.toHaveBeenCalled();
  });
});
