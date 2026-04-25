import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';

export const BOOTSTRAP_SECRET_SETTINGS_KEY = 'mcp_bootstrap_secret_hash';

export function generateBootstrapSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hashBootstrapSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Constant-time check of a provided bootstrap secret against the hash stored
 * in `partners.settings.mcp_bootstrap_secret_hash`. Returns false (NOT throws)
 * when the hash field is missing or malformed — this is the path a tombstoned
 * (post-activation) partner takes, and we want it to behave like "wrong
 * secret" rather than crash.
 */
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

/**
 * Tombstone the bootstrap secret for an activated partner by deleting the
 * `mcp_bootstrap_secret_hash` key from `partners.settings`. After activation
 * the secret no longer needs to be honored — leaving it would let an attacker
 * with a leaked secret (e.g. exfiltrated from chat history) re-call the
 * bootstrap tools and replace the legitimate Stripe customer link.
 *
 * Idempotent: deleting a missing key is a no-op in jsonb's `-` operator. Errors
 * are swallowed and logged — failure to tombstone must never break activation.
 */
export async function tombstoneBootstrapSecret(partnerId: string): Promise<void> {
  try {
    await db
      .update(partners)
      .set({
        settings: sql`coalesce(${partners.settings}, '{}'::jsonb) - ${BOOTSTRAP_SECRET_SETTINGS_KEY}`,
      })
      .where(eq(partners.id, partnerId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      '[mcpBootstrap] tombstoneBootstrapSecret: best-effort delete failed',
      { partnerId, error: msg },
    );
  }
}
