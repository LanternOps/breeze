import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BOOTSTRAP_SECRET_SETTINGS_KEY = 'mcp_bootstrap_secret_hash';

export function generateBootstrapSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hashBootstrapSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function isBootstrapSecretValid(
  settings: unknown,
  providedSecret: string,
): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const expected = (settings as Record<string, unknown>)[BOOTSTRAP_SECRET_SETTINGS_KEY];
  if (typeof expected !== 'string' || expected.length === 0) return false;

  const actual = hashBootstrapSecret(providedSecret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
