import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  rateLimiterMock, redisSet, redisDel, redisRef, incrementMock,
  enqueueSyncMock, enqueueAutoSuspendMock, selectRows, configMock, captureMock,
} = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: new Date() })),
  redisSet: vi.fn(async () => 'OK' as string | null),
  redisDel: vi.fn(async (_key: string) => 1),
  redisRef: { value: null as unknown },
  incrementMock: vi.fn(async (_partnerId: string, _column: string, _at?: Date) => true),
  enqueueSyncMock: vi.fn(async (_domainId: string) => undefined),
  enqueueAutoSuspendMock: vi.fn(async (_partnerId: string) => undefined),
  selectRows: [] as unknown[][],
  configMock: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/redis', () => ({ getRedis: () => redisRef.value }));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => '203.0.113.9'),
}));
vi.mock('../../services/sentry', () => ({ captureException: captureMock }));
vi.mock('../../services/emailDomains/config', () => ({ getEmailDomainsConfig: configMock }));
vi.mock('../../services/emailDomains/deliveryStats', () => ({ incrementPartnerSendingStat: incrementMock }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({
  enqueueSyncDomain: enqueueSyncMock,
  enqueueAutoSuspendEvaluation: enqueueAutoSuspendMock,
}));
vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (r: (v: unknown) => unknown) =>
      Promise.resolve(selectRows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { resendWebhookRoutes } from './emailProvider';

const SECRET = `whsec_${Buffer.from('a-thirty-two-byte-test-secret!!!').toString('base64')}`;
const PARTNER = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';

function app(): Hono {
  const a = new Hono();
  a.route('/webhooks', resendWebhookRoutes);
  return a;
}

let messageCounter = 0;
function post(payload: unknown, over: { id?: string; timestamp?: string; signature?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  messageCounter += 1;
  const id = over.id ?? `msg_${messageCounter}`;
  const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
  const key = Buffer.from((over.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const signature = over.signature
    ?? `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  return app().request('/webhooks/email-provider/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    },
    body,
  });
}

// Rest parameter, NOT a default: `emailEvent(type, undefined)` must mean "this
// event carries no tags at all", and a default parameter would silently hand it
// the tagged fixture instead — which would make the untagged case vacuous.
function emailEvent(type: string, ...tagsArg: Array<Record<string, string> | undefined>) {
  const tags = tagsArg.length === 0 ? { partner_id: PARTNER } : tagsArg[0];
  return { type, created_at: '2026-09-17T12:00:00.000Z', data: { email_id: 'e1', from: 'x@acme.test', to: ['y@z.test'], subject: 's', created_at: '2026-09-17T12:00:00.000Z', tags } };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.length = 0;
  configMock.mockReturnValue({ webhookSecret: SECRET });
  redisRef.value = { set: redisSet, del: redisDel };
  redisSet.mockResolvedValue('OK');
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() });
  incrementMock.mockResolvedValue(true);
});

describe('inertness', () => {
  it('404s and does NO work when EMAIL_DOMAINS_WEBHOOK_SECRET is unset', async () => {
    configMock.mockReturnValue({ webhookSecret: null });
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(404);
    expect(incrementMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect(enqueueSyncMock).not.toHaveBeenCalled();
  });

  // "Inert" means inert: an instance that never configured the feature must do
  // ZERO Redis work for a misdirected caller, so the secret check comes before
  // the limiter rather than after it.
  it('does not touch the rate limiter at all when the secret is unset', async () => {
    configMock.mockReturnValue({ webhookSecret: null });
    await post(emailEvent('email.delivered'));
    expect(rateLimiterMock).not.toHaveBeenCalled();
  });

  // And it must answer 404, never 429 — a 429 would tell a misdirected caller
  // to keep retrying against an endpoint that will never exist.
  it('404s rather than 429 when the secret is unset and the limiter would refuse', async () => {
    configMock.mockReturnValue({ webhookSecret: null });
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(404);
  });
});

describe('signature', () => {
  it('202s a correctly signed event', async () => {
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(202);
  });

  it('401s a payload signed with another secret', async () => {
    const other = `whsec_${Buffer.from('a-different-thirty-two-byte-key!').toString('base64')}`;
    const res = await post(emailEvent('email.delivered'), { secret: other });
    expect(res.status).toBe(401);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('401s a stale timestamp', async () => {
    const res = await post(emailEvent('email.delivered'), { timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
    expect(res.status).toBe(401);
  });

  it('401s missing svix headers', async () => {
    const res = await app().request('/webhooks/email-provider/resend', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // An unauthenticated caller must never be able to burn a dedupe key.
  it('does not reserve the svix-id before the signature is verified', async () => {
    await post(emailEvent('email.delivered'), { signature: 'v1,bogus' });
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe('rate limiting and replay', () => {
  it('429s when the per-IP limiter refuses', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(429);
  });

  it('202s but does NOT count a redelivery of the same svix-id', async () => {
    redisSet.mockResolvedValue(null); // SET … NX lost the race
    const res = await post(emailEvent('email.bounced'));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });

  // 503 makes svix retry; processing without the guard would double-count.
  it('503s when Redis cannot answer, so the provider retries', async () => {
    redisRef.value = null;
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(503);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('503s when the Redis reservation throws', async () => {
    redisSet.mockRejectedValue(new Error('ECONNRESET'));
    const res = await post(emailEvent('email.delivered'));
    expect(res.status).toBe(503);
  });
});

describe('event handling', () => {
  it.each([
    ['email.sent', 'sent'],
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.failed', 'failed'],
    ['email.suppressed', 'suppressed'],
  ])('%s increments the %s counter for the tagged partner', async (type, column) => {
    const res = await post(emailEvent(type));
    expect(res.status).toBe(202);
    expect(incrementMock).toHaveBeenCalledWith(PARTNER, column, expect.any(Date));
  });

  it('enqueues an auto-suspend evaluation after a bounce and after a complaint', async () => {
    await post(emailEvent('email.bounced'));
    expect(enqueueAutoSuspendMock).toHaveBeenCalledWith(PARTNER);
    enqueueAutoSuspendMock.mockClear();
    await post(emailEvent('email.complained'));
    expect(enqueueAutoSuspendMock).toHaveBeenCalledWith(PARTNER);
  });

  it('does NOT enqueue an evaluation after a delivered or sent event', async () => {
    await post(emailEvent('email.delivered'));
    await post(emailEvent('email.sent'));
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });

  it('ignores an event type it does not handle, with a 202', async () => {
    const res = await post(emailEvent('email.opened'));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('counts nothing when the event carries no tags at all', async () => {
    const res = await post(emailEvent('email.bounced', undefined));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });

  it('counts nothing when partner_id is not a UUID', async () => {
    const res = await post(emailEvent('email.bounced', { partner_id: 'not-a-uuid' }));
    expect(res.status).toBe(202);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  // The statement's row source is a SELECT over partners, so a forged but
  // well-formed id simply affects no rows — and must not enqueue an evaluation.
  it('does not enqueue an evaluation for a partner id that matched no partner', async () => {
    incrementMock.mockResolvedValue(false);
    const res = await post(emailEvent('email.bounced'));
    expect(res.status).toBe(202);
    expect(enqueueAutoSuspendMock).not.toHaveBeenCalled();
  });
});

describe('domain.updated', () => {
  it('enqueues sync-domain for the matching local row', async () => {
    selectRows.push([{ id: DOMAIN_ID }]);
    const res = await post({
      type: 'domain.updated', created_at: '2026-09-17T12:00:00.000Z',
      data: { id: 'prov-abc', name: 'mail.acme.test', status: 'verified', created_at: '2026-09-01T00:00:00.000Z', region: 'us-east-1', records: [] },
    });
    expect(res.status).toBe(202);
    expect(enqueueSyncMock).toHaveBeenCalledWith(DOMAIN_ID);
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('202s and enqueues nothing when no local row owns that provider domain id', async () => {
    selectRows.push([]);
    const res = await post({
      type: 'domain.updated', created_at: '2026-09-17T12:00:00.000Z',
      data: { id: 'prov-unknown', name: 'someone-else.test', status: 'verified', created_at: '2026-09-01T00:00:00.000Z', region: 'us-east-1', records: [] },
    });
    expect(res.status).toBe(202);
    expect(enqueueSyncMock).not.toHaveBeenCalled();
  });
});

describe('malformed payloads', () => {
  it('400s a body that is not JSON', async () => {
    const body = 'not json';
    const id = 'msg_bad';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
    const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    const res = await app().request('/webhooks/email-provider/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('400s a JSON body with no string `type`', async () => {
    const res = await post({ data: {} });
    expect(res.status).toBe(400);
  });
});

describe('the replay reservation is released when the handler fails', () => {
  // The reservation is claimed BEFORE the handler runs, so a transient DB blip
  // that 500s would otherwise leave the svix-id burned for 24 h: the provider's
  // retry hits the dedupe branch, gets 202, and the event is dropped forever.
  it('deletes the svix-id key before answering 500', async () => {
    incrementMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const res = await post(emailEvent('email.bounced'), { id: 'msg_boom' });
    expect(res.status).toBe(500);
    expect(redisDel).toHaveBeenCalledWith('emaildomains:webhook:msg_boom');
  });

  it("a retry after a failed handler is PROCESSED, not deduped", async () => {
    // Real reservation semantics: SET NX succeeds only while the key is absent.
    const held = new Set<string>();
    redisSet.mockImplementation(async (...args: unknown[]) => {
      const key = args[0] as string;
      if (held.has(key)) return null;
      held.add(key);
      return 'OK';
    });
    redisDel.mockImplementation(async (key: string) => { held.delete(key); return 1; });

    incrementMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await post(emailEvent('email.bounced'), { id: 'msg_retry' })).status).toBe(500);

    incrementMock.mockResolvedValue(true);
    const retry = await post(emailEvent('email.bounced'), { id: 'msg_retry' });
    expect(retry.status).toBe(202);
    expect(incrementMock).toHaveBeenCalledTimes(2);
  });

  // A failed release must not turn a 500 into a 500-plus-crash.
  it('still answers 500 when the release itself throws', async () => {
    incrementMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    redisDel.mockRejectedValueOnce(new Error('redis gone'));
    const res = await post(emailEvent('email.bounced'), { id: 'msg_del_fails' });
    expect(res.status).toBe(500);
  });
});

describe('a failure AFTER the counter committed is not retried', () => {
  // Releasing unconditionally would trade a dropped event for a double-counted
  // one. Once the upsert has committed, the event IS counted, and a retry would
  // count a second complaint — three of which suspend every domain a partner
  // owns. Everything after the upsert (the enqueues) is already best-effort:
  // the sweep and the next event re-evaluate.
  it('keeps the reservation and answers 202 when the enqueue fails post-commit', async () => {
    enqueueAutoSuspendMock.mockRejectedValueOnce(new Error('redis gone'));
    const res = await post(emailEvent('email.bounced'), { id: 'msg_post_commit' });
    expect(res.status).toBe(202);
    expect(incrementMock).toHaveBeenCalledTimes(1);
    expect(redisDel).not.toHaveBeenCalled();
  });

  it("a retry after a post-commit failure is deduped, so the count stays 1", async () => {
    const held = new Set<string>();
    redisSet.mockImplementation(async (...args: unknown[]) => {
      const key = args[0] as string;
      if (held.has(key)) return null;
      held.add(key);
      return 'OK';
    });
    redisDel.mockImplementation(async (key: string) => { held.delete(key); return 1; });

    enqueueAutoSuspendMock.mockRejectedValueOnce(new Error('redis gone'));
    expect((await post(emailEvent('email.bounced'), { id: 'msg_pc_retry' })).status).toBe(202);

    const retry = await post(emailEvent('email.bounced'), { id: 'msg_pc_retry' });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ duplicate: true });
    // The whole point: the bounce was counted exactly once.
    expect(incrementMock).toHaveBeenCalledTimes(1);
  });

  // domain.updated writes no counter at all, so a failure there is always safe
  // to retry — "counted" must mean the stats upsert affected a row, not merely
  // that the handler got far along.
  it('releases the reservation when a domain.updated handler fails (nothing was counted)', async () => {
    selectRows.push([{ id: DOMAIN_ID }]);
    enqueueSyncMock.mockRejectedValueOnce(new Error('boom'));
    const res = await post({
      type: 'domain.updated', created_at: '2026-09-17T12:00:00.000Z',
      data: { id: 'prov-abc', name: 'mail.acme.test', status: 'verified', created_at: '2026-09-01T00:00:00.000Z', region: 'us-east-1', records: [] },
    }, { id: 'msg_domain_fail' });
    expect(res.status).toBe(500);
    expect(redisDel).toHaveBeenCalledWith('emaildomains:webhook:msg_domain_fail');
  });
});
