/**
 * Signed OAuth `state` for the accounting connect/callback round trip (moved
 * out of routes/accounting/index.ts unchanged except for `provider`, Xero W01).
 * The state and its binding cookie are the callback's only authentication —
 * see the ACCOUNTING_STATE_COOKIE comment in index.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { AccountingProviderId } from '../../services/accounting/types';

export const STATE_TTL_MS = 10 * 60 * 1000;

export interface AccountingStatePayload {
  partnerId: string;
  userId: string | null;
  /** Absent on a state minted by the pre-W01 image (valid for STATE_TTL_MS across a deploy). */
  provider?: AccountingProviderId;
  nonce: string;
  exp: number;
}

function signingSecret(): string | null {
  return process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.SECRET_ENCRYPTION_KEY?.trim()
    || process.env.SESSION_SECRET?.trim()
    || process.env.JWT_SECRET?.trim()
    || (process.env.NODE_ENV === 'production' ? null : 'test-only-accounting-oauth-state-secret');
}

function hmac(label: string, value: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`${label}:${value}`).digest('base64url');
}

export function createState(partnerId: string, userId: string | null, provider: AccountingProviderId): string | null {
  const payload: AccountingStatePayload = {
    partnerId,
    userId,
    provider,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = hmac('accounting-oauth', encoded);
  return sig ? `${encoded}.${sig}` : null;
}

export function verifyState(state: string): AccountingStatePayload | null {
  const [encoded, sig] = state.split('.');
  if (!encoded || !sig) return null;
  const expected = hmac('accounting-oauth', encoded);
  if (!expected) return null;
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccountingStatePayload;
    if (!parsed.partnerId || !parsed.nonce || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function stateCookieValue(state: string): string | null {
  return hmac('accounting-oauth-cookie', state);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
