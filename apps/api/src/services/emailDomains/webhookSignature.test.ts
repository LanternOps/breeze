import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SVIX_TIMESTAMP_TOLERANCE_SECONDS, verifySvixSignature } from './webhookSignature';

const SECRET = `whsec_${Buffer.from('a-thirty-two-byte-test-secret!!!').toString('base64')}`;
const ID = 'msg_2abcDEF';
const BODY = '{"type":"email.delivered","data":{"email_id":"e1"}}';
const NOW = new Date('2026-09-17T12:00:00.000Z');

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function ts(offsetSeconds = 0): string {
  return String(Math.floor(NOW.getTime() / 1000) + offsetSeconds);
}

describe('verifySvixSignature', () => {
  it('accepts a correctly signed payload', () => {
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW)).toEqual({ ok: true });
  });

  // Svix sends every currently-valid secret's signature, space-separated,
  // during a rotation. Only checking the first would break every rotation.
  it('accepts when the matching v1 entry is not the first of several', () => {
    const timestamp = ts();
    const signature = [
      'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      `v1,${sign(SECRET, ID, timestamp, BODY)}`,
    ].join(' ');
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW)).toEqual({ ok: true });
  });

  it('ignores entries whose version is not v1', () => {
    const timestamp = ts();
    const signature = `v2,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a payload signed with a different secret', () => {
    const timestamp = ts();
    const other = `whsec_${Buffer.from('a-different-thirty-two-byte-key!').toString('base64')}`;
    const signature = `v1,${sign(other, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  // The signature covers the EXACT bytes; a re-serialised body must not verify.
  it('rejects when the body differs by one byte', () => {
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, `${BODY} `, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects when the id differs (the id is inside the signed string)', () => {
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: 'msg_other', timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['id', { id: null, timestamp: ts(), signature: 'v1,x' }],
    ['timestamp', { id: ID, timestamp: null, signature: 'v1,x' }],
    ['signature', { id: ID, timestamp: ts(), signature: null }],
  ])('rejects a request missing the svix-%s header', (_label, headers) => {
    expect(verifySvixSignature(headers as never, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifySvixSignature({ id: ID, timestamp: 'yesterday', signature: 'v1,x' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects a timestamp older than the tolerance', () => {
    const timestamp = ts(-(SVIX_TIMESTAMP_TOLERANCE_SECONDS + 1));
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a timestamp further in the FUTURE than the tolerance', () => {
    const timestamp = ts(SVIX_TIMESTAMP_TOLERANCE_SECONDS + 1);
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts exactly AT the tolerance boundary', () => {
    const timestamp = ts(-SVIX_TIMESTAMP_TOLERANCE_SECONDS);
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, SECRET, NOW)).toEqual({ ok: true });
  });

  it('tolerates a secret written without the whsec_ prefix', () => {
    const bare = SECRET.replace(/^whsec_/, '');
    const timestamp = ts();
    const signature = `v1,${sign(SECRET, ID, timestamp, BODY)}`;
    expect(verifySvixSignature({ id: ID, timestamp, signature }, BODY, bare, NOW)).toEqual({ ok: true });
  });

  it('rejects an empty secret rather than verifying against an empty key', () => {
    expect(verifySvixSignature({ id: ID, timestamp: ts(), signature: 'v1,x' }, BODY, '   ', NOW))
      .toEqual({ ok: false, reason: 'bad_secret' });
  });

  // A malformed entry must not be able to throw out of the verifier: a thrown
  // error inside a public handler is a 500, which tells the provider to retry
  // a payload that will never verify.
  it('rejects garbage in the signature header without throwing', () => {
    const timestamp = ts();
    expect(verifySvixSignature({ id: ID, timestamp, signature: 'v1,!!!not-base64!!!' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySvixSignature({ id: ID, timestamp, signature: 'nonsense' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySvixSignature({ id: ID, timestamp, signature: '' }, BODY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'missing_headers' });
  });
});
