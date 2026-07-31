import type {
  CasWriteInput,
  CasWriteOutcome,
  PutConsentRowInput,
  TokenCacheRow,
  TokenCacheStore,
} from './tokenCacheStore';

/**
 * Reference implementation of the token-cache store semantics (design §3.2).
 * Every method mirrors the Postgres statements exactly — the shared contract
 * suite runs both implementations against the same cases to keep them honest.
 *
 * `read` returns a copy of the row object but the SAME ciphertext reference,
 * which the corrupt-ciphertext tests exploit to flip a stored byte; callers
 * must treat the bytes as immutable.
 */
export class InMemoryTokenCacheStore implements TokenCacheStore {
  private readonly rows = new Map<string, TokenCacheRow>();

  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async ensureSchema(): Promise<void> {}

  async read(connectionId: string): Promise<TokenCacheRow | null> {
    const row = this.rows.get(connectionId);
    return row ? { ...row } : null;
  }

  async putConsentRow(input: PutConsentRowInput): Promise<{ cacheVersion: number }> {
    const existing = this.rows.get(input.connectionId);
    const cacheVersion = existing ? existing.cacheVersion + 1 : 1;
    const fence = existing ? existing.fence + 1 : 1;
    this.rows.set(input.connectionId, {
      connectionId: input.connectionId,
      cacheVersion,
      fence,
      consentGeneration: input.consentGeneration,
      consentAttemptId: input.consentAttemptId,
      state: 'active',
      ciphertext: new Uint8Array(input.ciphertext),
      kekVersion: input.kekVersion,
      leaseHolder: null,
      leaseFence: null,
      leaseExpiresAt: null,
      updatedAt: this.now(),
    });
    return { cacheVersion };
  }

  async casWrite(input: CasWriteInput): Promise<CasWriteOutcome> {
    const row = this.rows.get(input.connectionId);
    // The disambiguation order matches the Postgres re-read: absent and
    // tombstoned are terminal states; a moved version means concurrent
    // redemption (the caller retries silently); a newer fence means THIS
    // holder was superseded.
    if (!row) return 'absent';
    if (row.state === 'tombstoned') return 'tombstoned';
    if (row.cacheVersion !== input.expectedCacheVersion) return 'version-conflict';
    if (row.fence > input.fence) return 'fence-superseded';
    row.ciphertext = new Uint8Array(input.ciphertext);
    row.kekVersion = input.kekVersion;
    row.cacheVersion += 1;
    row.updatedAt = this.now();
    return 'written';
  }

  async acquireLease(
    connectionId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<{ fence: number } | null> {
    const row = this.rows.get(connectionId);
    if (!row || row.state !== 'active') return null;
    const now = this.now();
    const held = row.leaseHolder !== null
      && row.leaseExpiresAt !== null
      && row.leaseExpiresAt.getTime() >= now.getTime()
      && row.leaseHolder !== holderId;
    if (held) return null;
    row.fence += 1;
    row.leaseHolder = holderId;
    row.leaseFence = row.fence;
    row.leaseExpiresAt = new Date(now.getTime() + ttlMs);
    row.updatedAt = now;
    return { fence: row.leaseFence };
  }

  async releaseLease(connectionId: string, holderId: string, fence: number): Promise<void> {
    const row = this.rows.get(connectionId);
    if (!row || row.leaseHolder !== holderId || row.leaseFence !== fence) return;
    row.leaseHolder = null;
    row.leaseFence = null;
    row.leaseExpiresAt = null;
    row.updatedAt = this.now();
  }

  async tombstone(connectionId: string, onlyIfAttemptId: string | null): Promise<boolean> {
    const row = this.rows.get(connectionId);
    if (!row || row.state !== 'active') return false;
    if (onlyIfAttemptId !== null && row.consentAttemptId !== onlyIfAttemptId) return false;
    row.state = 'tombstoned';
    row.ciphertext = null;
    row.kekVersion = null;
    row.leaseHolder = null;
    row.leaseFence = null;
    row.leaseExpiresAt = null;
    row.cacheVersion += 1;
    row.fence += 1;
    row.updatedAt = this.now();
    return true;
  }

  async close(): Promise<void> {}
}
