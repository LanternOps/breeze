/**
 * The executor-owned token-cache store (design §3.2).
 *
 * This is NOT Breeze Postgres. It is a dedicated store the executor owns, so
 * its single table registers in none of the Breeze tenancy contracts (RLS
 * coverage, cascade lists, export policy) — those govern the tenant database.
 *
 * Semantics the interface carries (implementations MUST honor all of them,
 * and the shared contract suite proves they do):
 *
 * - **Only the consent path creates rows.** `casWrite` against an absent row
 *   reports `'absent'` and never initializes — an absent row outside consent
 *   means revoked or superseded, and acquireTokenSilent must fail closed.
 * - **A zero-row CAS UPDATE is not self-evidently concurrent redemption.** The
 *   predicate can miss because the version moved (retry silently), the fence
 *   was superseded (this holder lost its lease), the row was tombstoned
 *   (revoke won), or the row is gone. Implementations disambiguate by re-read
 *   and report the distinct `CasWriteOutcome` — assuming "someone else
 *   redeemed" is the v2 bug this design fixed.
 * - **Tombstone is terminal for a generation.** Nothing un-tombstones a row;
 *   only a NEW consent attempt (`putConsentRow`) may replace it, stamped with
 *   its own attempt id and generation.
 * - **The lease fence is monotonic** and shared with `fence`: every acquire
 *   bumps it, and a paused holder that resumes after expiry loses to the CAS
 *   `fence <= input.fence` predicate. Expiry alone is not mutual exclusion.
 */

export interface TokenCacheRow {
  connectionId: string;
  cacheVersion: number;
  fence: number;
  consentGeneration: number;
  consentAttemptId: string;
  state: 'active' | 'tombstoned';
  ciphertext: Uint8Array | null;
  kekVersion: string | null;
  leaseHolder: string | null;
  leaseFence: number | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

export type CasWriteOutcome =
  | 'written'
  | 'version-conflict'
  | 'fence-superseded'
  | 'tombstoned'
  | 'absent';

export interface PutConsentRowInput {
  connectionId: string;
  consentAttemptId: string;
  consentGeneration: number;
  ciphertext: Uint8Array;
  kekVersion: string;
}

export interface CasWriteInput {
  connectionId: string;
  expectedCacheVersion: number;
  fence: number;
  ciphertext: Uint8Array;
  kekVersion: string;
}

export interface TokenCacheStore {
  /** Idempotent; run at boot. Creates the executor-owned table if missing. */
  ensureSchema(): Promise<void>;
  read(connectionId: string): Promise<TokenCacheRow | null>;
  /**
   * Consent-path write: creates the row, or wholly replaces an existing one
   * (bumping version and fence) — including reviving a tombstoned row for a
   * re-consent after revoke. The ONLY method that may create a row.
   */
  putConsentRow(input: PutConsentRowInput): Promise<{ cacheVersion: number }>;
  casWrite(input: CasWriteInput): Promise<CasWriteOutcome>;
  /**
   * Returns the new monotonic fence, or null when another holder holds an
   * unexpired lease (or the row is absent/tombstoned).
   */
  acquireLease(
    connectionId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<{ fence: number } | null>;
  /** Frees the lease only when this holder still holds it at this fence. */
  releaseLease(connectionId: string, holderId: string, fence: number): Promise<void>;
  /**
   * Terminal for the current generation: nulls the ciphertext, bumps version
   * and fence so any in-flight CAS write loses. When `onlyIfAttemptId` is set,
   * a row stamped with a different attempt is left untouched (the
   * consent-supersede cleanup scopes itself to its own attempt's row).
   * Returns whether a row was tombstoned.
   */
  tombstone(connectionId: string, onlyIfAttemptId: string | null): Promise<boolean>;
  close(): Promise<void>;
}
