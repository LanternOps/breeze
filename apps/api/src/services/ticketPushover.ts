/**
 * Per-user Pushover user key for ticket-assignment pushes, sealed at rest in
 * ticket_push_preferences.pushover_user_key_encrypted. Like every row-bound
 * column in encryptedColumnRegistry, the AAD binds the ciphertext to the user
 * id once an encryption key id is configured (secretCrypto v3); without one the
 * value is still encrypted, but not row-bound.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { ticketPushPreferences } from '../db/schema';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secretCrypto';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from './encryptedColumnRegistry';

/** Looked up from the registry, not re-declared, so this module and the
 *  rotation walker cannot drift apart; a missing entry fails at import. */
export const PUSHOVER_USER_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find((s) => s.table === 'ticket_push_preferences' && s.column === 'pushover_user_key_encrypted');
  if (!spec) throw new Error('ticket_push_preferences.pushover_user_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

/** Pushover user and group keys are 30 characters, letters and digits. */
export const PUSHOVER_USER_KEY_PATTERN = /^[A-Za-z0-9]{30}$/;

export function sealPushoverUserKey(userId: string, key: string): string {
  if (isEncryptedSecret(key)) throw new Error('Pushover user key must be plaintext');
  return encryptSecret(key, { aad: columnAad(PUSHOVER_USER_KEY_SPEC, userId) }) ?? key;
}

/** The plaintext key, or null when unset. Throws when a sealed value cannot be opened. */
export function openPushoverUserKey(userId: string, stored: string | null | undefined): string | null {
  if (!stored) return null;
  return decryptSecret(stored, { aad: columnAad(PUSHOVER_USER_KEY_SPEC, userId) }) ?? null;
}

/** The given user's own Pushover key (opened), or null. Runs in the caller's DB context. */
export async function loadUserPushoverKey(userId: string): Promise<string | null> {
  const rows = await db.select({ sealed: ticketPushPreferences.pushoverUserKeyEncrypted })
    .from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, userId)).limit(1);
  return openPushoverUserKey(userId, rows?.[0]?.sealed);
}
