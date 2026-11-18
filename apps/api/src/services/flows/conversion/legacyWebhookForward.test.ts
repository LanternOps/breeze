import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';

/**
 * #5221 B6 — the legacy webhook URL of a switched Job forwards to its flow's
 * ingest. Unit level: the switched-row read is a stand-in, ingest is a spy.
 * The real-DB + Redis path is flowConversionWebhook.integration.test.ts.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  executes: 0,
  contexts: [] as string[],
}));

vi.mock('../../../db', () => ({
  db: {
    execute: vi.fn(async () => {
      h.executes += 1;
      return h.rows;
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown, label: string) => {
    h.contexts.push(label);
    return fn();
  },
}));
vi.mock('../webhook/ingest', () => ({ ingestFlowWebhook: vi.fn() }));
vi.mock('../../sentry', () => ({ captureException: vi.fn() }));

import { FLOW_WEBHOOK_HEADERS } from '@breeze/shared';
import { captureException } from '../../sentry';
import { verifyBreezeHmacSignature } from '../../webhookSignature';
import { verifyFlowWebhook } from '../webhook/verify';
import { ingestFlowWebhook } from '../webhook/ingest';
import { forwardedWebhookHeaders, forwardLegacyWebhook } from './legacyWebhookForward';
import { legacyWebhookDeliveryIdHeader, webhookOccurrenceInstant, webhookOccurrenceKeys } from './webhookOccurrence';

const AUTO = '11111111-1111-4111-8111-111111111111';
const FLOW = '33333333-3333-4333-8333-333333333333';
const SECRET = 'legacy-secret-b6';

/** The legacy route's shape: the forwarder's answer, else legacy continues (a sentinel 299 here). */
const forwardingApp = () => new Hono().post('/hooks/:id', async (c) =>
  (await forwardLegacyWebhook(c, c.req.param('id'))) ?? new Response(JSON.stringify({ fellThrough: true }), { status: 299 }));

function sign(body: string, ts = String(Math.floor(Date.now() / 1000))) {
  return { ts, signature: `sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}` };
}

beforeEach(() => {
  h.rows = [{ flow_id: FLOW }];
  h.executes = 0;
  h.contexts.length = 0;
  vi.mocked(ingestFlowWebhook).mockReset().mockResolvedValue({ http: 202, body: { status: 'accepted', runId: 'r1', deliveryId: 'd1' } });
  vi.mocked(captureException).mockClear();
});

describe('forwardLegacyWebhook', () => {
  it('returns null (legacy continues) when the row has no switched conversion, reading the body never', async () => {
    h.rows = [];
    const res = await forwardingApp().request(`/hooks/${AUTO}`, { method: 'POST', body: '{"a":1}' });
    expect(res.status).toBe(299);
    expect(ingestFlowWebhook).not.toHaveBeenCalled();
    // One read-only lookup in system scope, outside any request context.
    expect(h.executes).toBe(1);
    expect(h.contexts).toEqual(['automations.webhook.forward']);
  });

  it('forwards the unchanged raw body and the other headers to the conversion flow', async () => {
    const body = '{ "ticket" :\n 42 }  ';
    const { ts, signature } = sign(body);
    const res = await forwardingApp().request(`/hooks/${AUTO}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-breeze-timestamp': ts, 'x-breeze-signature': signature, 'x-custom': 'kept' },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted', runId: 'r1', deliveryId: 'd1' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const call = vi.mocked(ingestFlowWebhook).mock.calls[0]![0];
    expect(call.flowId).toBe(FLOW);
    expect(call.rawBody).toBe(body);
    expect(call.headers.get('x-breeze-signature')).toBe(signature);
    expect(call.headers.get('x-breeze-timestamp')).toBe(ts);
    expect(call.headers.get('x-custom')).toBe('kept');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.receivedAt).toBeInstanceOf(Date);
  });

  it('a 429 carries Retry-After, as the flow route answers', async () => {
    vi.mocked(ingestFlowWebhook).mockResolvedValueOnce({ http: 429, body: { status: 'refused', code: 'rate_limited' }, retryAfterSec: 17 });
    const res = await forwardingApp().request(`/hooks/${AUTO}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
  });

  it('an ingest failure is a 503 that never echoes headers or body', async () => {
    vi.mocked(ingestFlowWebhook).mockRejectedValueOnce(new Error('db down'));
    const res = await forwardingApp().request(`/hooks/${AUTO}`, {
      method: 'POST', body: '{"secretish":"bwh_SUPERSECRET"}', headers: { 'x-webhook-secret': 'bwh_SUPERSECRET' },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain('bwh_SUPERSECRET');
  });

  it('a query-string secret on a switched row is the uniform 401, never forwarded', async () => {
    const res = await forwardingApp().request(`/hooks/${AUTO}?secret=abc`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(ingestFlowWebhook).not.toHaveBeenCalled();
  });
});

describe('forwardedWebhookHeaders', () => {
  it('maps x-breeze-event-id to X-Breeze-Delivery-Id', () => {
    const out = forwardedWebhookHeaders(new Headers({ 'x-breeze-event-id': ' evt_1 ', 'x-breeze-nonce': 'n_1' }));
    expect(out.get(FLOW_WEBHOOK_HEADERS.deliveryId)).toBe('evt_1');
  });

  it('falls back to x-breeze-nonce', () => {
    const out = forwardedWebhookHeaders(new Headers({ 'x-breeze-nonce': 'n_1' }));
    expect(out.get(FLOW_WEBHOOK_HEADERS.deliveryId)).toBe('n_1');
  });

  it('an id the flow cannot carry is not mapped, and a sender delivery id is replaced by what legacy reads', () => {
    expect(forwardedWebhookHeaders(new Headers({ 'x-breeze-event-id': 'has spaces/slashes', 'x-breeze-delivery-id': 'other' }))
      .get(FLOW_WEBHOOK_HEADERS.deliveryId)).toBeNull();
    expect(forwardedWebhookHeaders(new Headers({ 'x-breeze-delivery-id': 'other' })).get(FLOW_WEBHOOK_HEADERS.deliveryId)).toBeNull();
    expect(forwardedWebhookHeaders(new Headers({ 'x-breeze-event-id': 'e'.repeat(129) })).get(FLOW_WEBHOOK_HEADERS.deliveryId)).toBeNull();
  });

  it('does not mutate the incoming headers', () => {
    const incoming = new Headers({ 'x-breeze-event-id': 'evt_1' });
    forwardedWebhookHeaders(incoming);
    expect(incoming.get(FLOW_WEBHOOK_HEADERS.deliveryId)).toBeNull();
  });
});

describe('webhook occurrence identity is the same on both engines', () => {
  /** What the legacy route claims for a request (B2): its verified digest and the header it reads. */
  function legacyKeys(body: string, headers: Headers) {
    const v = verifyBreezeHmacSignature({
      secret: SECRET, timestamp: headers.get('x-breeze-timestamp'), signature: headers.get('x-breeze-signature'),
      payload: body, now: Date.now(), windowMs: 300_000,
    });
    if (!v.ok) throw new Error(v.reason);
    return webhookOccurrenceKeys(v.signatureDigest, legacyWebhookDeliveryIdHeader((n) => headers.get(n) ?? undefined));
  }
  /** What flow ingest claims for the forwarded request. */
  function flowKeys(body: string, headers: Headers) {
    const v = verifyFlowWebhook({ rawBody: body, headers: forwardedWebhookHeaders(headers), secret: SECRET, mode: 'hmac', now: Date.now() });
    if (!v.ok) throw new Error(v.reason);
    return webhookOccurrenceKeys(v.signatureDigest, v.deliveryId);
  }

  it.each([
    ['event id', { 'x-breeze-event-id': 'evt_1' }],
    ['nonce', { 'x-breeze-nonce': 'n:1' }],
    ['no id', {}],
    ['an id the flow cannot carry', { 'x-breeze-event-id': 'a b' }],
  ])('%s: legacy and the forwarded flow claim identical keys', (_label, extra) => {
    const body = '{"n":1}';
    const { ts, signature } = sign(body);
    const headers = new Headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': signature, ...extra });
    const legacy = legacyKeys(body, headers);
    expect(legacy[0]).toMatch(/^webhook:sig:[0-9a-f]{64}$/);
    expect(flowKeys(body, headers)).toEqual(legacy);
  });

  it('the signature digest ignores the sha256= prefix on both sides (bare hex is accepted)', () => {
    const body = '{"n":1}';
    const { ts, signature } = sign(body);
    const bare = new Headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': signature.slice('sha256='.length) });
    const prefixed = new Headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': signature });
    expect(flowKeys(body, bare)).toEqual(legacyKeys(body, prefixed));
  });

  it('the instant is the signed timestamp, seconds or milliseconds, as the verifier reads it', () => {
    expect(webhookOccurrenceInstant('1767225600')).toEqual(new Date(1_767_225_600_000));
    expect(webhookOccurrenceInstant('1767225600123')).toEqual(new Date(1_767_225_600_123));
    expect(webhookOccurrenceInstant(' 1767225600 ')).toEqual(new Date(1_767_225_600_000));
    expect(webhookOccurrenceInstant('nope')).toBeNull();
    expect(webhookOccurrenceInstant(undefined)).toBeNull();
    expect(webhookOccurrenceInstant('-5')).toBeNull();
  });
});
