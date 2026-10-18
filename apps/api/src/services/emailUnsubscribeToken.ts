import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { isEmailOptoutTopic, type EmailOptoutTopic } from './emailOptouts';

// One-click unsubscribe token (spec 2026-10-15 §5, RFC 8058).
//
// Format: base64url("v1.<userId>.<topic>.<issuedAtSeconds>") + "." + base64url(HMAC-SHA256).
// Opaque to the reader, never expires (an old email's link must keep working),
// and bound to one user and one topic by the signature.
//
// The key is DERIVED (HKDF-SHA256) from the app secret with its own salt and
// info, so it is never the raw app secret and never the session/JWT key:
// JWT_SECRET and SESSION_SECRET are not read here at all. Rotating
// APP_ENCRYPTION_KEY invalidates outstanding links; the user can still opt out
// from My Account, and the next digest carries a fresh link.

const VERSION = 'v1';
const HKDF_SALT = 'breeze-email-unsubscribe';
const HKDF_INFO = 'v1';
const TEST_ONLY_SECRET = 'breeze-test-only-email-unsubscribe-secret';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function appSecret(): string {
  const secret = process.env.APP_ENCRYPTION_KEY?.trim() || process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is required to sign email unsubscribe links');
  }
  return TEST_ONLY_SECRET;
}

/** False when no signing secret is available (production without APP_ENCRYPTION_KEY): nothing can be signed or verified. */
export function unsubscribeSigningConfigured(): boolean {
  try {
    appSecret();
    return true;
  } catch {
    return false;
  }
}

function signingKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret(), HKDF_SALT, HKDF_INFO, 32));
}

function mac(payload: string): Buffer {
  return createHmac('sha256', signingKey()).update(payload).digest();
}

export function signUnsubscribeToken(input: {
  userId: string;
  topic: EmailOptoutTopic;
  issuedAt?: Date;
}): string {
  if (!UUID_RE.test(input.userId)) throw new Error('unsubscribe token: userId must be a uuid');
  if (!isEmailOptoutTopic(input.topic)) throw new Error(`unsubscribe token: unknown topic ${String(input.topic)}`);
  const iat = Math.floor((input.issuedAt ?? new Date()).getTime() / 1000);
  const payload = `${VERSION}.${input.userId.toLowerCase()}.${input.topic}.${iat}`;
  return `${Buffer.from(payload).toString('base64url')}.${mac(payload).toString('base64url')}`;
}

/** Returns the bound user and topic, or null for anything forged, altered, malformed or for an unknown topic. */
export function verifyUnsubscribeToken(token: unknown): { userId: string; topic: EmailOptoutTopic } | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts as [string, string];
  if (!B64URL_RE.test(encodedPayload) || !B64URL_RE.test(encodedSig)) return null;

  const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  const fields = payload.split('.');
  if (fields.length !== 4) return null;
  const [version, userId, topic, iat] = fields as [string, string, string, string];
  if (version !== VERSION || !UUID_RE.test(userId) || !/^\d{1,12}$/.test(iat)) return null;
  if (!isEmailOptoutTopic(topic)) return null;

  let expected: Buffer;
  try {
    expected = mac(payload);
  } catch {
    // No secret in production: nothing can be verified.
    return null;
  }
  const given = Buffer.from(encodedSig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { userId: userId.toLowerCase(), topic };
}

/**
 * Origin that serves /api/v1 publicly. PUBLIC_API_URL when set; otherwise the
 * dashboard origin, which proxies /api in the standard deployment. Never a
 * literal host.
 */
export function publicApiOrigin(): string {
  return (
    process.env.PUBLIC_API_URL?.trim() ||
    process.env.DASHBOARD_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    'http://localhost:3001'
  ).replace(/\/+$/, '');
}

export const UNSUBSCRIBE_PATH = '/api/v1/email/unsubscribe';

export function buildUnsubscribeUrl(userId: string, topic: EmailOptoutTopic): string {
  return `${publicApiOrigin()}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(signUnsubscribeToken({ userId, topic }))}`;
}
