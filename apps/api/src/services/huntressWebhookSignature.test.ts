import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildHuntressWebhookSignature } from './huntressClient';
import {
  HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS,
  verifyHuntressWebhookRequest,
} from './huntressWebhookSignature';

// Huntress delivers Standard Webhooks through Svix (#10335 capture): a
// `whsec_<base64>` secret, `webhook-id` / `webhook-timestamp` (unix seconds) /
// `webhook-signature: v1,<base64 HMAC-SHA256("{id}.{timestamp}.{body}")>`.
const KEY_BYTES = Buffer.from('huntress-standard-webhooks-key-32');
const WHSEC_SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const MSG_ID = 'msg_2pHuntressTestDelivery';
const BODY = '{"event_type":"test.event","message":"Hello World"}';
const NOW = new Date('2026-10-28T18:35:42.000Z');
// A verified Standard Webhooks delivery reports its webhook-id for replay reservation.
const OK_STANDARD = { ok: true, scheme: 'standard-webhooks', messageId: MSG_ID } as const;

function seconds(offset = 0): string {
  return String(Math.floor(NOW.getTime() / 1000) + offset);
}

function svixSign(key: Buffer, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function headers(map: Record<string, string | undefined>): (name: string) => string | undefined {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower[name.toLowerCase()];
}

function standardHeaders(over: {
  id?: string;
  timestamp?: string;
  signature?: string;
  key?: Buffer;
  body?: string;
} = {}): Record<string, string> {
  const id = over.id ?? MSG_ID;
  const timestamp = over.timestamp ?? seconds();
  const signature = over.signature
    ?? `v1,${svixSign(over.key ?? KEY_BYTES, id, timestamp, over.body ?? BODY)}`;
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature };
}

function verify(map: Record<string, string | undefined>, opts: { secret?: string; body?: string } = {}) {
  return verifyHuntressWebhookRequest({
    secret: opts.secret ?? WHSEC_SECRET,
    payload: opts.body ?? BODY,
    header: headers(map),
    now: NOW,
  });
}

describe('verifyHuntressWebhookRequest — Standard Webhooks (Svix)', () => {
  it('accepts a delivery signed the way Huntress signs it (webhook-* headers, whsec_ secret)', () => {
    expect(verify(standardHeaders())).toEqual(OK_STANDARD);
  });

  it('accepts the svix-* header aliases', () => {
    const std = standardHeaders();
    expect(verify({
      'svix-id': std['webhook-id'],
      'svix-timestamp': std['webhook-timestamp'],
      'svix-signature': std['webhook-signature'],
    })).toEqual(OK_STANDARD);
  });

  // Svix sends one v1 entry per currently-valid secret during a rotation.
  it('accepts when the matching v1 value is not the first of several space-separated values', () => {
    const timestamp = seconds();
    const signature = [
      'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      `v1,${svixSign(KEY_BYTES, MSG_ID, timestamp, BODY)}`,
    ].join(' ');
    expect(verify(standardHeaders({ timestamp, signature })))
      .toEqual(OK_STANDARD);
  });

  it('accepts when the matching v1 value comes first and a stale one follows', () => {
    const timestamp = seconds();
    const signature = [
      `v1,${svixSign(KEY_BYTES, MSG_ID, timestamp, BODY)}`,
      'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ].join(' ');
    expect(verify(standardHeaders({ timestamp, signature })))
      .toEqual(OK_STANDARD);
  });

  it('reports the trimmed webhook-id of a verified delivery', () => {
    const timestamp = seconds();
    const signature = `v1,${svixSign(KEY_BYTES, MSG_ID, timestamp, BODY)}`;
    expect(verify({ 'webhook-id': `  ${MSG_ID} `, 'webhook-timestamp': timestamp, 'webhook-signature': signature }))
      .toEqual(OK_STANDARD);
  });

  it('rejects a signature made with a different secret', () => {
    const result = verify(standardHeaders({ key: Buffer.from('some-other-thirty-two-byte-key!!') }));
    expect(result).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  it('rejects when the body differs from the signed body', () => {
    const result = verify(standardHeaders(), { body: `${BODY} ` });
    expect(result).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  it('rejects when the webhook-id differs (the id is part of the signed content)', () => {
    const std = standardHeaders();
    const result = verify({ ...std, 'webhook-id': 'msg_someOtherDelivery' });
    expect(result).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  it('keeps the existing 10-minute replay window (not Svix\'s 5-minute default)', () => {
    expect(HUNTRESS_WEBHOOK_REPLAY_WINDOW_SECONDS).toBe(600);
    // 9 minutes old: outside a 5-minute window, inside ours.
    expect(verify(standardHeaders({ timestamp: seconds(-9 * 60) })))
      .toEqual(OK_STANDARD);
  });

  it('accepts exactly at the 10-minute boundary, past and future', () => {
    expect(verify(standardHeaders({ timestamp: seconds(-600) })))
      .toEqual(OK_STANDARD);
    expect(verify(standardHeaders({ timestamp: seconds(600) })))
      .toEqual(OK_STANDARD);
  });

  it('rejects a timestamp older than the replay window', () => {
    const result = verify(standardHeaders({ timestamp: seconds(-(10 * 60 + 1)) }));
    expect(result).toEqual({
      ok: false,
      scheme: 'standard-webhooks',
      error: 'Webhook signature timestamp is outside the replay window',
    });
  });

  it('rejects a timestamp further in the future than the replay window', () => {
    const result = verify(standardHeaders({ timestamp: seconds(10 * 60 + 1) }));
    expect(result).toEqual({
      ok: false,
      scheme: 'standard-webhooks',
      error: 'Webhook signature timestamp is outside the replay window',
    });
  });

  it('rejects a non-numeric timestamp', () => {
    const std = standardHeaders();
    const result = verify({ ...std, 'webhook-timestamp': 'yesterday' });
    expect(result).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid webhook-timestamp header' });
  });

  it('uses the raw secret bytes as the HMAC key when the secret has no whsec_ prefix', () => {
    const rawSecret = 'a-plain-shared-secret-without-prefix';
    const signedWithRaw = standardHeaders({ key: Buffer.from(rawSecret, 'utf8') });
    expect(verify(signedWithRaw, { secret: rawSecret })).toEqual(OK_STANDARD);

    // ...and NOT the base64 decoding of it (that is only for whsec_ secrets).
    const signedWithDecoded = standardHeaders({ key: Buffer.from(rawSecret, 'base64') });
    expect(verify(signedWithDecoded, { secret: rawSecret }))
      .toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  it('base64-decodes a whsec_ secret rather than using its literal bytes', () => {
    const signedWithLiteral = standardHeaders({ key: Buffer.from(WHSEC_SECRET, 'utf8') });
    expect(verify(signedWithLiteral))
      .toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  it('rejects a whsec_ secret with no key material instead of verifying against an empty key', () => {
    const emptyKey = Buffer.alloc(0);
    const result = verify(standardHeaders({ key: emptyKey }), { secret: 'whsec_' });
    expect(result).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Webhook secret is not configured correctly' });
  });

  it('names the missing header when only part of the Standard Webhooks set arrives', () => {
    const std = standardHeaders();
    const result = verify({ 'webhook-id': std['webhook-id'], 'webhook-timestamp': std['webhook-timestamp'] });
    expect(result).toEqual({
      ok: false,
      scheme: 'standard-webhooks',
      error: 'Missing Standard Webhooks header(s): webhook-signature',
    });
  });

  it('treats a lone svix-* header as a Standard Webhooks delivery and names what is missing', () => {
    expect(verify({ 'svix-id': MSG_ID })).toEqual({
      ok: false,
      scheme: 'standard-webhooks',
      error: 'Missing Standard Webhooks header(s): webhook-timestamp, webhook-signature',
    });
  });

  // Each field resolves on its own (webhook-* first, then svix-*); all three
  // values are inside the HMAC, so mixing families grants nothing.
  it('accepts a mix of webhook-* and svix-* spellings across fields', () => {
    const std = standardHeaders();
    expect(verify({
      'webhook-id': std['webhook-id'],
      'svix-timestamp': std['webhook-timestamp'],
      'svix-signature': std['webhook-signature'],
    })).toEqual(OK_STANDARD);
  });

  it('prefers the webhook-* spelling when both families are present', () => {
    const good = standardHeaders();
    const bad = standardHeaders({ key: Buffer.from('some-other-thirty-two-byte-key!!') });
    expect(verify({
      ...good,
      'svix-id': 'msg_other',
      'svix-timestamp': seconds(-3600),
      'svix-signature': bad['webhook-signature'],
    })).toEqual(OK_STANDARD);
    expect(verify({
      ...bad,
      'svix-id': good['webhook-id'],
      'svix-timestamp': good['webhook-timestamp'],
      'svix-signature': good['webhook-signature'],
    })).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  // Standard Webhooks headers make that scheme authoritative: a delivery that
  // carries them is never re-tried against the legacy header pair.
  it('does not fall back to the legacy headers when Standard Webhooks headers are present but invalid', () => {
    const timestamp = seconds();
    const result = verify({
      ...standardHeaders({ key: Buffer.from('some-other-thirty-two-byte-key!!') }),
      'x-huntress-signature': buildHuntressWebhookSignature(WHSEC_SECRET, BODY, timestamp),
      'x-huntress-timestamp': timestamp,
    });
    expect(result).toEqual({ ok: false, scheme: 'standard-webhooks', error: 'Invalid Huntress webhook signature' });
  });

  it('never throws on garbage signature values', () => {
    for (const signature of ['', ' ', ',', 'v1,', 'v1', 'v2,abc', 'v1,!!!!', 'v1,a v1,b v1,c']) {
      expect(() => verify(standardHeaders({ signature }))).not.toThrow();
      expect(verify(standardHeaders({ signature })).ok).toBe(false);
    }
  });
});

describe('verifyHuntressWebhookRequest — legacy x-huntress-signature', () => {
  const LEGACY_SECRET = 'legacy-webhook-secret';

  function legacyHeaders(timestamp: string, names: { sig: string; ts: string } = {
    sig: 'x-huntress-signature',
    ts: 'x-huntress-timestamp',
  }, secret = LEGACY_SECRET): Record<string, string> {
    return { [names.sig]: buildHuntressWebhookSignature(secret, BODY, timestamp), [names.ts]: timestamp };
  }

  function nowSeconds(): string {
    // The legacy verifier reads the real clock and ignores the injected `now`.
    return String(Math.floor(Date.now() / 1000));
  }

  it('still accepts a sha256= signature on x-huntress-signature / x-huntress-timestamp', () => {
    expect(verify(legacyHeaders(nowSeconds()), { secret: LEGACY_SECRET })).toEqual({ ok: true, scheme: 'legacy' });
  });

  it('still accepts the x-signature / x-timestamp fallbacks', () => {
    const result = verify(legacyHeaders(nowSeconds(), { sig: 'x-signature', ts: 'x-timestamp' }), { secret: LEGACY_SECRET });
    expect(result).toEqual({ ok: true, scheme: 'legacy' });
  });

  it('still rejects a legacy signature made with another secret', () => {
    const result = verify(legacyHeaders(nowSeconds(), undefined, 'not-the-secret'), { secret: LEGACY_SECRET });
    expect(result).toEqual({ ok: false, scheme: 'legacy', error: 'Invalid Huntress webhook signature' });
  });

  it('still rejects a stale legacy timestamp', () => {
    const stale = String(Math.floor(Date.now() / 1000) - (10 * 60 + 5));
    const result = verify(legacyHeaders(stale), { secret: LEGACY_SECRET });
    expect(result).toEqual({
      ok: false,
      scheme: 'legacy',
      error: 'Webhook signature timestamp is outside the replay window',
    });
  });

  it('names both accepted signature headers when no signature header arrives at all', () => {
    expect(verify({}, { secret: LEGACY_SECRET })).toEqual({
      ok: false,
      scheme: 'legacy',
      error: 'Missing webhook signature header (expected webhook-signature or x-huntress-signature)',
    });
  });

  it('still reports a missing legacy timestamp when only x-huntress-signature arrives', () => {
    expect(verify({ 'x-huntress-signature': 'sha256=abc123' }, { secret: LEGACY_SECRET }))
      .toEqual({ ok: false, scheme: 'legacy', error: 'Missing Huntress timestamp header' });
  });
});
