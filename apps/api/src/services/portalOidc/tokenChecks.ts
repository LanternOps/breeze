/**
 * id_token checks shared by the portal's Entra (./entraClient.ts) and Google
 * (./googleClient.ts) clients. One copy of each trust-boundary primitive, so
 * the two clients cannot drift apart.
 */
import { createHash, timingSafeEqual } from 'crypto';

/** The underlying error's name and code only: never its message, which can carry a URL, token or body. */
export function errorDiagnostics(error: unknown): { errorName: string; errorCode?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return { errorName: name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
}

/** The `nonce` claim equals the state's nonce, compared in constant time. Empty or non-string → false. */
export function nonceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length === 0 || expected.length === 0) return false;
  // Fixed-length digests: constant time regardless of either input's length.
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

/** An address-shaped claim (a string containing `@`), lowercased; otherwise null. */
export function addressClaim(value: unknown): string | null {
  return typeof value === 'string' && value.includes('@') ? value.toLowerCase() : null;
}
