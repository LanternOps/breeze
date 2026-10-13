/**
 * Link-tier challenge material (#6354 W03).
 *
 * W01 `start` mints a 32-byte base64url token and stores only its SHA-256 hex
 * in `challenge_token_hash`. The SMS/email `prepare` port seals that same
 * token into `sealed_link_token` (row-bound AAD, registered for key rotation
 * like `billing_link_tokens.token_ct`) so the post-commit publisher can
 * deliver — and re-deliver after a crash — the exact link without ever
 * persisting it in clear. The token, the sealed blob and the URL are never
 * logged or audited.
 *
 * `storedChoices` fixes the three candidate numbers' on-screen order once, at
 * preparation. The order is derived from the verification id and the value
 * only, so it cannot reveal which candidate is the match.
 */
import { createHash, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../secretCrypto';
import { columnAad, encryptedColumnRegistry } from '../encryptedColumnRegistry';

export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const spec = encryptedColumnRegistry.find((s) => s.table === 'caller_verifications' && s.column === 'sealed_link_token');
if (!spec) throw new Error('caller_verifications.sealed_link_token is not registered');

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sealLinkToken(verificationId: string, token: string): string {
  if (!LINK_TOKEN_RE.test(token)) throw new Error('link_token_invalid');
  // The id is embedded as well as bound through AAD: a deployment without a
  // key id falls back to v1 ciphertext, which carries no AAD.
  const sealed = encryptSecret(JSON.stringify({ verificationId, token }), { aad: columnAad(spec!, verificationId) });
  if (!sealed) throw new Error('link_token_encryption_failed');
  return sealed;
}

/** Test/fixture helper: a fresh token with its digest and sealed form. */
export function newLinkChallenge(verificationId: string): { challengeTokenHash: string; sealedToken: string } {
  const token = randomBytes(32).toString('base64url');
  return { challengeTokenHash: hashLinkToken(token), sealedToken: sealLinkToken(verificationId, token) };
}

export function openLinkToken(verificationId: string, sealed: string): string {
  if (!isEncryptedSecret(sealed)) throw new Error('link_token_invalid');
  let value: unknown;
  try {
    value = JSON.parse(decryptSecret(sealed, { aad: columnAad(spec!, verificationId) }) ?? 'null');
  } catch {
    throw new Error('link_token_invalid');
  }
  const parsed = value as { verificationId?: unknown; token?: unknown } | null;
  if (!parsed || parsed.verificationId !== verificationId || typeof parsed.token !== 'string' || !LINK_TOKEN_RE.test(parsed.token)) {
    throw new Error('link_token_invalid');
  }
  return parsed.token;
}

export function storedChoices(verificationId: string, matchValue: string, decoyValues: string[]): [string, string, string] {
  const values = [matchValue, ...decoyValues];
  if (values.length !== 3 || new Set(values).size !== 3 || values.some((v) => !/^\d{2}$/.test(v))) {
    throw new Error('challenge_choices_invalid');
  }
  // Every value is ranked identically regardless of its role.
  const rank = (v: string) => hashLinkToken(`${verificationId}:${v}`);
  values.sort((a, b) => rank(a).localeCompare(rank(b)) || a.localeCompare(b));
  return values as [string, string, string];
}

/**
 * Absolute recipient URL on the deployment's configured web origin. Never
 * derived from a Host header or a partner-supplied value.
 */
export function linkUrl(token: string): string {
  if (!LINK_TOKEN_RE.test(token)) throw new Error('link_token_invalid');
  let base: URL;
  try {
    base = new URL(process.env.PUBLIC_WEB_URL || process.env.PUBLIC_APP_URL || '');
  } catch {
    throw new Error('app_url_invalid');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('app_url_invalid');
  }
  return new URL(`/verify/${token}`, base).href;
}
