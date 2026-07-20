/**
 * Seal/reveal handling for secrets inside action_intents.result.
 *
 * Registry of secret-bearing action results (today: only the M365 reset
 * password). The temporary password is encrypted at rest (AES-256-GCM via
 * secretCrypto, AAD-bound to action_intents.result), revealed AT MOST ONCE via
 * POST /action-intents/:id/reveal-secret, and burned out of the jsonb by a CAS
 * update the moment it is revealed — or redacted by the expiry reaper after
 * REVEAL_WINDOW_DAYS. The plaintext must never reach logs, audit details, or
 * metrics.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { decryptSecret, encryptSecret } from '../secretCrypto';

export const ACTION_INTENT_RESULT_AAD = 'action_intents.result';
export const TEMP_PASSWORD_ENC_KEY = 'temporaryPasswordEnc';
export const TEMP_PASSWORD_LEGACY_KEY = 'temporaryPassword';
export const TEMP_PASSWORD_REVEALED_KEY = 'temporaryPasswordRevealed';
export const TEMP_PASSWORD_EXPIRED_KEY = 'temporaryPasswordExpired';
export const REVEAL_WINDOW_DAYS = 7;

const SECRET_BEARING_ACTION = 'm365.user.reset_password';

/** Encrypt secret fields in an executor result before it is stored. */
export function sealActionResultSecrets(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.action !== SECRET_BEARING_ACTION) return result;
  const pw = result[TEMP_PASSWORD_LEGACY_KEY];
  if (typeof pw !== 'string' || pw.length === 0) return result;
  const sealed = encryptSecret(pw, { aad: ACTION_INTENT_RESULT_AAD });
  if (!sealed) return result;
  const { [TEMP_PASSWORD_LEGACY_KEY]: _plain, ...rest } = result;
  return { ...rest, [TEMP_PASSWORD_ENC_KEY]: sealed };
}

export function hasSealedTemporaryPassword(result: Record<string, unknown>): boolean {
  return (
    typeof result[TEMP_PASSWORD_ENC_KEY] === 'string' ||
    typeof result[TEMP_PASSWORD_LEGACY_KEY] === 'string'
  );
}

/**
 * Decrypt the sealed password (or return a legacy plaintext one). Throws on
 * tampered/AAD-mismatched ciphertext — callers must treat that as a 500 and
 * must NOT burn.
 */
export function unsealTemporaryPassword(result: Record<string, unknown>): string | null {
  const sealed = result[TEMP_PASSWORD_ENC_KEY];
  if (typeof sealed === 'string') {
    return decryptSecret(sealed, { aad: ACTION_INTENT_RESULT_AAD, strict: true });
  }
  const legacy = result[TEMP_PASSWORD_LEGACY_KEY];
  return typeof legacy === 'string' ? legacy : null;
}

/**
 * Atomically remove the secret from result, leaving a marker. The WHERE clause
 * requires the secret to still be present, so under concurrent reveals exactly
 * one caller gets `true` — only that caller may return the plaintext.
 * Runs in the ambient db context (request RLS context from routes; system
 * context from the reaper).
 */
export async function burnTemporaryPassword(
  intentId: string,
  marker: { revealedByUserId: string } | { expired: true },
): Promise<boolean> {
  const markerSql =
    'expired' in marker
      ? sql`jsonb_build_object(${TEMP_PASSWORD_EXPIRED_KEY}::text, true)`
      : sql`jsonb_build_object(${TEMP_PASSWORD_REVEALED_KEY}::text, jsonb_build_object('revealedAt', to_jsonb(now()), 'revealedByUserId', ${marker.revealedByUserId}::text))`;
  const rows = await db
    .update(actionIntents)
    .set({
      result: sql`(coalesce(${actionIntents.result}, '{}'::jsonb) - ${TEMP_PASSWORD_ENC_KEY}::text - ${TEMP_PASSWORD_LEGACY_KEY}::text) || ${markerSql}`,
    })
    .where(
      and(
        eq(actionIntents.id, intentId),
        sql`${actionIntents.result} ?| array[${TEMP_PASSWORD_ENC_KEY}::text, ${TEMP_PASSWORD_LEGACY_KEY}::text]`,
      ),
    )
    .returning({ id: actionIntents.id });
  return rows.length > 0;
}
