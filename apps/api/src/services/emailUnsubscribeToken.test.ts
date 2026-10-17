import { createHmac, hkdfSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from './emailUnsubscribeToken';

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const TOPIC = 'connection_health_digest';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function swapPayload(token: string, payload: string): string {
  const sig = token.split('.')[1]!;
  return `${b64(payload)}.${sig}`;
}

describe('unsubscribe token', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', 'app-secret-for-tests-0123456789abcdef');
    vi.stubEnv('NODE_ENV', 'test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips user and topic', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC, issuedAt: new Date('2026-10-16T08:00:00Z') });
    expect(verifyUnsubscribeToken(t)).toEqual({ userId: USER, topic: TOPIC });
  });

  it('is opaque: two segments of base64url, payload not plain in the URL', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC });
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(t).not.toContain(USER);
  });

  it('rejects an altered user id', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC, issuedAt: new Date(1_000_000) });
    const forged = swapPayload(t, unb64(t.split('.')[0]!).replace(USER, OTHER));
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('rejects an altered topic', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC, issuedAt: new Date(1_000_000) });
    const forged = swapPayload(t, unb64(t.split('.')[0]!).replace(TOPIC, 'connection_health_digesx'));
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('rejects an altered signature', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC });
    const [p, s] = t.split('.') as [string, string];
    const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyUnsubscribeToken(`${p}.${flipped}`)).toBeNull();
  });

  it.each([
    '',
    'abc',
    'a.b.c',
    '..',
    '.sig',
    'payload.',
    'not base64!.%%%',
  ])('rejects malformed token %j', (bad) => {
    expect(verifyUnsubscribeToken(bad)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(verifyUnsubscribeToken(undefined as unknown as string)).toBeNull();
    expect(verifyUnsubscribeToken(42 as unknown as string)).toBeNull();
  });

  it('refuses to sign an unknown topic', () => {
    expect(() => signUnsubscribeToken({ userId: USER, topic: 'marketing' as never })).toThrow();
  });

  it('rejects a correctly signed token for an unknown topic', () => {
    const key = Buffer.from(hkdfSync('sha256', 'app-secret-for-tests-0123456789abcdef', 'breeze-email-unsubscribe', 'v1', 32));
    const payload = `v1.${USER}.marketing.1700000000`;
    const sig = createHmac('sha256', key).update(payload).digest('base64url');
    expect(verifyUnsubscribeToken(`${b64(payload)}.${sig}`)).toBeNull();
    // Control: the same construction with the real topic verifies, so the
    // rejection above is the topic check, not a construction mistake.
    const okPayload = `v1.${USER}.${TOPIC}.1700000000`;
    const okSig = createHmac('sha256', key).update(okPayload).digest('base64url');
    expect(verifyUnsubscribeToken(`${b64(okPayload)}.${okSig}`)).toEqual({ userId: USER, topic: TOPIC });
  });

  it('rejects a token signed with a key derived from another secret', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC });
    vi.stubEnv('APP_ENCRYPTION_KEY', 'a-completely-different-app-secret-000');
    expect(verifyUnsubscribeToken(t)).toBeNull();
  });

  it('never keys on JWT_SECRET or SESSION_SECRET', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC });
    vi.stubEnv('JWT_SECRET', 'jwt-changed');
    vi.stubEnv('SESSION_SECRET', 'session-changed');
    expect(verifyUnsubscribeToken(t)).toEqual({ userId: USER, topic: TOPIC });
    // A plain HMAC keyed by the JWT secret over the same payload is not accepted.
    const payload = t.split('.')[0]!;
    const jwtSig = createHmac('sha256', 'jwt-changed').update(unb64(payload)).digest('base64url');
    expect(verifyUnsubscribeToken(`${payload}.${jwtSig}`)).toBeNull();
  });

  it('a plain HMAC keyed directly by the app secret is not accepted (the key is derived)', () => {
    const t = signUnsubscribeToken({ userId: USER, topic: TOPIC });
    const payload = t.split('.')[0]!;
    const sig = createHmac('sha256', 'app-secret-for-tests-0123456789abcdef').update(unb64(payload)).digest('base64url');
    expect(verifyUnsubscribeToken(`${payload}.${sig}`)).toBeNull();
  });

  it('throws in production with no app secret', () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => signUnsubscribeToken({ userId: USER, topic: TOPIC })).toThrow(/APP_ENCRYPTION_KEY/);
    expect(verifyUnsubscribeToken('x.y')).toBeNull();
  });

  it('rejects a non-uuid user id when signing', () => {
    expect(() => signUnsubscribeToken({ userId: 'not-a-uuid', topic: TOPIC })).toThrow();
  });
});

describe('buildUnsubscribeUrl', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', 'app-secret-for-tests-0123456789abcdef');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses PUBLIC_API_URL when set', () => {
    vi.stubEnv('PUBLIC_API_URL', 'https://api.example.test/');
    const url = new URL(buildUnsubscribeUrl(USER, TOPIC));
    expect(url.origin).toBe('https://api.example.test');
    expect(url.pathname).toBe('/api/v1/email/unsubscribe');
    expect(verifyUnsubscribeToken(url.searchParams.get('t')!)).toEqual({ userId: USER, topic: TOPIC });
  });

  it('falls back to the dashboard origin', () => {
    vi.stubEnv('PUBLIC_API_URL', '');
    vi.stubEnv('DASHBOARD_URL', 'https://app.example.test');
    expect(buildUnsubscribeUrl(USER, TOPIC)).toMatch(/^https:\/\/app\.example\.test\/api\/v1\/email\/unsubscribe\?t=/);
  });
});
