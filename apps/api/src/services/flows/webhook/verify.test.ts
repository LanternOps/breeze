import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

/** Tool Catalog W05 (#5220) Task A6 — flow webhook authentication (hmac / token modes). */

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { timingSafeEqual } from 'node:crypto';
import { verifyFlowWebhook } from './verify';

const SECRET = 'bwh_' + 'k'.repeat(43);
const NOW = 1_800_000_000_000;
const body = '{"customer":{"id":"C-1"}}';
const ts = String(NOW / 1000);
const sig = (payload = body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
const headers = (h: Record<string, string>) => new Headers(h);

describe('verifyFlowWebhook — hmac', () => {
  it('a valid signature yields its digest and the delivery id', () => {
    const r = verifyFlowWebhook({
      rawBody: body, now: NOW, secret: SECRET, mode: 'hmac',
      headers: headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': sig(), 'x-breeze-delivery-id': 'evt_1:a' }),
    });
    expect(r).toEqual({ ok: true, signatureDigest: createHash('sha256').update(sig()).digest('hex'), deliveryId: 'evt_1:a' });
  });

  it('maps every HMAC failure onto the flow auth-failure codes', () => {
    const base = { rawBody: body, now: NOW, secret: SECRET, mode: 'hmac' as const };
    expect(verifyFlowWebhook({ ...base, headers: headers({ 'x-breeze-timestamp': ts }) })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyFlowWebhook({ ...base, headers: headers({ 'x-breeze-signature': sig() }) })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyFlowWebhook({ ...base, headers: headers({ 'x-breeze-timestamp': 'x', 'x-breeze-signature': sig() }) })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyFlowWebhook({ ...base, headers: headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': sig(body, 'nope') }) }))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyFlowWebhook({ ...base, rawBody: '{"customer":{"id":"C-2"}}', headers: headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': sig() }) }))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bad delivery id is bad_delivery_id, even with a valid signature', () => {
    for (const id of ['a b', 'x'.repeat(129), 'a/b', '']) {
      const r = verifyFlowWebhook({
        rawBody: body, now: NOW, secret: SECRET, mode: 'hmac',
        headers: headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': sig(), 'x-breeze-delivery-id': id }),
      });
      if (id === '') expect(r.ok).toBe(true); // an empty header is absent
      else expect(r).toEqual({ ok: false, reason: 'bad_delivery_id' });
    }
  });

  it('a token header never authenticates an hmac flow', () => {
    expect(verifyFlowWebhook({ rawBody: body, now: NOW, secret: SECRET, mode: 'hmac', headers: headers({ 'x-breeze-webhook-token': SECRET }) }))
      .toEqual({ ok: false, reason: 'missing_signature' });
  });
});

describe('verifyFlowWebhook — token', () => {
  it('accepts the secret in X-Breeze-Webhook-Token (no signature digest)', () => {
    expect(verifyFlowWebhook({ rawBody: body, now: NOW, secret: SECRET, mode: 'token', headers: headers({ 'x-breeze-webhook-token': SECRET }) }))
      .toEqual({ ok: true, signatureDigest: null, deliveryId: null });
  });

  it('token mode compares in constant time', () => {
    vi.mocked(timingSafeEqual).mockClear();
    const r = verifyFlowWebhook({ rawBody: body, now: NOW, secret: SECRET, mode: 'token', headers: headers({ 'x-breeze-webhook-token': `${SECRET}x` }) });
    expect(r).toEqual({ ok: false, reason: 'bad_token' });
    // Called even for a different-length token (digests, never the raw strings).
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('token in Authorization header is missing_token', () => {
    expect(verifyFlowWebhook({ rawBody: body, now: NOW, secret: SECRET, mode: 'token', headers: headers({ authorization: `Bearer ${SECRET}` }) }))
      .toEqual({ ok: false, reason: 'missing_token' });
  });

  it('a signature never authenticates a token flow', () => {
    expect(verifyFlowWebhook({ rawBody: body, now: NOW, secret: SECRET, mode: 'token', headers: headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': sig() }) }))
      .toEqual({ ok: false, reason: 'missing_token' });
  });
});
