import { sql } from 'drizzle-orm';
import { users } from '../../db/schema';

// ============================================
// Authenticator-app (TOTP) factor predicate (#10650)
// ============================================
//
// Kept in its own dependency-light module (re-exported from ./helpers) so
// callers whose tests stub ./helpers still run the real truth table.

/** The `users` columns that decide whether an authenticator app is enrolled. */
export interface TotpFactorRow {
  mfaEnabled: boolean | null;
  /** The `mfa_method` enum ('totp' | 'sms' | 'passkey'), typed loosely so rows read through other projections fit. */
  mfaMethod: string | null;
  mfaSecret: string | null;
}

/**
 * True when the account has an ACTIVE authenticator app: MFA is on, a secret
 * is stored, and the primary method is one TOTP may sit beside. `mfa_method`
 * stays the PRIMARY factor, so this is how a TOTP secret is read:
 *   - `totp`    — TOTP is the primary.
 *   - `passkey` — TOTP is the BACKUP beside a primary passkey (#10650).
 *   - `null`    — a row enrolled before `mfa_method` was written on TOTP
 *                 enable; every login path already reads it as
 *                 `mfaMethod || 'totp'`, so it must count here too or those
 *                 accounts lose their only factor at sign-in.
 * A secret beside an `sms` primary, or on an account with MFA off, is stale and
 * never a factor. Every "does this account hold TOTP" check — login challenge,
 * step-up, L4 re-auth, the Office add-in bind, `/users/me`, passkey removal —
 * goes through this or its SQL twin {@link activeTotpFactorSql}, so they
 * cannot drift apart.
 */
export function hasActiveTotpFactor(row: TotpFactorRow): boolean {
  return row.mfaEnabled === true
    && row.mfaSecret != null
    && (row.mfaMethod === 'totp' || row.mfaMethod === 'passkey' || row.mfaMethod == null);
}

/**
 * True when an authenticator app may be ADDED as a backup: the account is
 * protected by a primary passkey and holds no TOTP secret. An account with no
 * factor is initial enrollment instead; TOTP- and SMS-primary accounts cannot
 * add a second TOTP.
 */
export function canAddBackupTotp(row: TotpFactorRow): boolean {
  return row.mfaEnabled === true && row.mfaMethod === 'passkey' && row.mfaSecret == null;
}

/**
 * SQL twin of {@link hasActiveTotpFactor}, same truth table, for reads that must
 * never select the secret column itself (`/users/me`) or that count factors
 * under a row lock (passkey removal).
 */
export function activeTotpFactorSql() {
  return sql<boolean>`(${users.mfaEnabled} AND ${users.mfaSecret} IS NOT NULL AND (${users.mfaMethod} IS NULL OR ${users.mfaMethod} IN ('totp', 'passkey')))`;
}
