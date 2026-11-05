import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { verifyBreezeHmacSignature } from './webhookSignature';

/**
 * Tool Catalog W05 (#5220) Task A6 — the Breeze inbound-webhook HMAC scheme,
 * extracted from routes/automations.ts so flows and automations verify the
 * same way: `sha256=` + HMAC-SHA256(secret, `<timestamp>.<raw body>`), the
 * timestamp in seconds or milliseconds within a window.
 */

const SECRET = 'secret-123';
const NOW = 1_800_000_000_000; // ms
const WINDOW = 300_000;
const body = '{"event":"ping"}';
const sign = (ts: string, payload = body, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
const verify = (over: Partial<Parameters<typeof verifyBreezeHmacSignature>[0]> = {}) =>
  verifyBreezeHmacSignature({ secret: SECRET, timestamp: String(NOW / 1000), signature: sign(String(NOW / 1000)), payload: body, now: NOW, windowMs: WINDOW, ...over });

describe('verifyBreezeHmacSignature', () => {
  it('accepts the automations vector (seconds timestamp)', () => {
    const ts = String(NOW / 1000);
    const r = verify({ timestamp: ts, signature: sign(ts) });
    expect(r).toEqual({ ok: true, signatureDigest: createHash('sha256').update(sign(ts)).digest('hex') });
  });

  it('ms timestamps accepted', () => {
    const ts = String(NOW - 1000);
    expect(verify({ timestamp: ts, signature: sign(ts) }).ok).toBe(true);
  });

  it('301 s old is stale_timestamp', () => {
    const ts = String(Math.floor((NOW - 301_000) / 1000));
    expect(verify({ timestamp: ts, signature: sign(ts) })).toEqual({ ok: false, reason: 'stale_timestamp' });
    const future = String(Math.floor((NOW + 301_000) / 1000));
    expect(verify({ timestamp: future, signature: sign(future) })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('bare hex without sha256= is accepted (automations behaviour), and digests the normalised header', () => {
    const ts = String(NOW / 1000);
    const bare = sign(ts).slice('sha256='.length);
    const r = verify({ timestamp: ts, signature: bare });
    expect(r).toEqual({ ok: true, signatureDigest: createHash('sha256').update(sign(ts)).digest('hex') });
  });

  it('different length signature is bad_signature without throwing', () => {
    expect(verify({ signature: 'sha256=abc' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ signature: 'sha256=' + 'é'.repeat(64) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a wrong secret or a changed body is bad_signature', () => {
    const ts = String(NOW / 1000);
    expect(verify({ signature: sign(ts, body, 'other') })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ payload: '{"event":"pong"}' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('missing or malformed headers', () => {
    expect(verify({ signature: null })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verify({ signature: '  ' })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verify({ timestamp: null })).toEqual({ ok: false, reason: 'missing_timestamp' });
    expect(verify({ timestamp: 'soon' })).toEqual({ ok: false, reason: 'invalid_timestamp' });
    expect(verify({ timestamp: '-5' })).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });
});
