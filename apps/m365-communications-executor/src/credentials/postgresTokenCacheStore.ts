import postgres from 'postgres';
import type {
  CasWriteInput,
  CasWriteOutcome,
  PutConsentRowInput,
  TokenCacheRow,
  TokenCacheStore,
} from './tokenCacheStore';

/**
 * The executor-owned Postgres store (design §3.2). NOT Breeze Postgres: this
 * table lives in a dedicated database the executor owns, so it registers in
 * none of the Breeze tenancy contracts (RLS coverage, cascades, export
 * policy). `ensureSchema` runs idempotently at boot; there is no Breeze
 * migration file for it.
 */
export class PostgresTokenCacheStore implements TokenCacheStore {
  private readonly sql: postgres.Sql;

  constructor(dsn: string) {
    this.sql = postgres(dsn, { max: 3, prepare: false });
  }

  async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS comms_token_cache (
        connection_id      uuid PRIMARY KEY,
        cache_version      bigint NOT NULL,
        fence              bigint NOT NULL,
        consent_generation integer NOT NULL,
        consent_attempt_id uuid NOT NULL,
        state              text NOT NULL CHECK (state IN ('active', 'tombstoned')),
        ciphertext         bytea,
        kek_version        text,
        lease_holder       uuid,
        lease_fence        bigint,
        lease_expires_at   timestamptz,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CHECK ((state = 'tombstoned') = (ciphertext IS NULL))
      )`;
  }

  async read(connectionId: string): Promise<TokenCacheRow | null> {
    const rows = await this.sql`
      SELECT connection_id, cache_version, fence, consent_generation, consent_attempt_id,
             state, ciphertext, kek_version, lease_holder, lease_fence, lease_expires_at,
             updated_at
        FROM comms_token_cache
       WHERE connection_id = ${connectionId}`;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    // Number(...) on the bigints: cache versions and fences stay far below
    // 2^53 (they bump once per redemption/lease, not per request byte).
    return {
      connectionId: String(row.connection_id),
      cacheVersion: Number(row.cache_version),
      fence: Number(row.fence),
      consentGeneration: Number(row.consent_generation),
      consentAttemptId: String(row.consent_attempt_id),
      state: row.state as 'active' | 'tombstoned',
      ciphertext: row.ciphertext === null ? null : new Uint8Array(row.ciphertext as Buffer),
      kekVersion: row.kek_version === null ? null : String(row.kek_version),
      leaseHolder: row.lease_holder === null ? null : String(row.lease_holder),
      leaseFence: row.lease_fence === null ? null : Number(row.lease_fence),
      leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  async putConsentRow(input: PutConsentRowInput): Promise<{ cacheVersion: number }> {
    const rows = await this.sql`
      INSERT INTO comms_token_cache (
        connection_id, cache_version, fence, consent_generation, consent_attempt_id,
        state, ciphertext, kek_version, updated_at
      ) VALUES (
        ${input.connectionId}, 1, 1, ${input.consentGeneration}, ${input.consentAttemptId},
        'active', ${Buffer.from(input.ciphertext)}, ${input.kekVersion}, now()
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        cache_version = comms_token_cache.cache_version + 1,
        fence = comms_token_cache.fence + 1,
        consent_generation = EXCLUDED.consent_generation,
        consent_attempt_id = EXCLUDED.consent_attempt_id,
        state = 'active',
        ciphertext = EXCLUDED.ciphertext,
        kek_version = EXCLUDED.kek_version,
        lease_holder = NULL, lease_fence = NULL, lease_expires_at = NULL,
        updated_at = now()
      RETURNING cache_version`;
    return { cacheVersion: Number(rows[0]!.cache_version) };
  }

  async casWrite(input: CasWriteInput): Promise<CasWriteOutcome> {
    // The §3.2 predicate verbatim. Zero rows is then DISAMBIGUATED by
    // re-read; assuming "someone else redeemed" is the v2 bug this design
    // fixed. The re-read order matches the in-memory reference: absent and
    // tombstoned are terminal; a moved version is concurrent redemption
    // (retried silently); a newer fence means this holder was superseded.
    const updated = await this.sql`
      UPDATE comms_token_cache
         SET ciphertext = ${Buffer.from(input.ciphertext)},
             kek_version = ${input.kekVersion},
             cache_version = cache_version + 1,
             updated_at = now()
       WHERE connection_id = ${input.connectionId}
         AND cache_version = ${input.expectedCacheVersion}
         AND fence <= ${input.fence}
         AND state = 'active'`;
    if (updated.count === 1) return 'written';
    const row = await this.read(input.connectionId);
    if (!row) return 'absent';
    if (row.state === 'tombstoned') return 'tombstoned';
    if (row.cacheVersion !== input.expectedCacheVersion) return 'version-conflict';
    if (row.fence > input.fence) return 'fence-superseded';
    return 'version-conflict';
  }

  async acquireLease(
    connectionId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<{ fence: number } | null> {
    // Every SET expression reads the OLD row, so fence and lease_fence get the
    // same incremented value atomically. This monotonic fence is what excludes
    // a paused holder that resumes after expiry (§3.2): expiry alone is not
    // mutual exclusion.
    const rows = await this.sql`
      UPDATE comms_token_cache
         SET fence = fence + 1,
             lease_holder = ${holderId},
             lease_fence = fence + 1,
             lease_expires_at = now() + make_interval(secs => ${ttlMs / 1000}),
             updated_at = now()
       WHERE connection_id = ${connectionId}
         AND state = 'active'
         AND (lease_holder IS NULL OR lease_expires_at < now() OR lease_holder = ${holderId})
       RETURNING lease_fence`;
    return rows.length === 1 ? { fence: Number(rows[0]!.lease_fence) } : null;
  }

  async releaseLease(connectionId: string, holderId: string, fence: number): Promise<void> {
    await this.sql`
      UPDATE comms_token_cache
         SET lease_holder = NULL, lease_fence = NULL, lease_expires_at = NULL,
             updated_at = now()
       WHERE connection_id = ${connectionId}
         AND lease_holder = ${holderId}
         AND lease_fence = ${fence}`;
  }

  async tombstone(connectionId: string, onlyIfAttemptId: string | null): Promise<boolean> {
    // Terminal for this generation; also bumps version and fence so any
    // in-flight CAS write loses. onlyIfAttemptId scopes the consent-supersede
    // cleanup to its own attempt's row.
    const updated = await this.sql`
      UPDATE comms_token_cache
         SET state = 'tombstoned', ciphertext = NULL, kek_version = NULL,
             lease_holder = NULL, lease_fence = NULL, lease_expires_at = NULL,
             cache_version = cache_version + 1, fence = fence + 1, updated_at = now()
       WHERE connection_id = ${connectionId}
         AND state = 'active'
         AND (${onlyIfAttemptId}::uuid IS NULL OR consent_attempt_id = ${onlyIfAttemptId})`;
    return updated.count === 1;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
