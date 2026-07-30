import {
  CorruptCacheCiphertextError,
  decryptCacheBlob,
  encryptCacheBlob,
  type KekKeyring,
} from './tokenCacheCrypto';
import type { TokenCacheStore } from './tokenCacheStore';

const DEFAULT_LEASE_TTL_MS = 30_000; // §3.2 "short, ~30s"
const DEFAULT_LEASE_ATTEMPTS = 10;
const LEASE_RETRY_SLEEP_MS = 250;

export class TokenCacheUnavailableError extends Error {
  constructor(
    readonly code: 'delegated_reauth_required' | 'binding_stale' | 'credential_rotation_failed' | 'consent_superseded',
    readonly detail?: string, // enum-ish words only; never credential or message material
  ) {
    super(`token cache unavailable: ${code}`);
    this.name = 'TokenCacheUnavailableError';
  }
}

export interface LoadedCache {
  plaintext: string;
  cacheVersion: number;
  fence: number;
  consentGeneration: number;
  consentAttemptId: string;
}

/**
 * Composes store + crypto into the behaviors MSAL and operations consume —
 * every §3.2 "defined semantics" lives here:
 *
 * - An absent row outside the consent path means revoked or superseded — it is
 *   NEVER initialized.
 * - Corrupt ciphertext fails closed and PRESERVES the row for forensics;
 *   undecryptable is never treated as empty.
 * - Revoke tombstones; an in-flight refresh cannot undo it.
 * - Lease contention is transient — bounded retry, then a retryable failure.
 */
export class DelegatedTokenCache {
  constructor(private readonly deps: {
    store: TokenCacheStore;
    keyring: KekKeyring;
    holderId: string;                 // this replica's uuid
    leaseTtlMs?: number;
    leaseAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {}

  async withLease<T>(connectionId: string, fn: (loaded: LoadedCache) => Promise<T>): Promise<T> {
    const attempts = this.deps.leaseAttempts ?? DEFAULT_LEASE_ATTEMPTS;
    const ttlMs = this.deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const sleep = this.deps.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let lease: { fence: number } | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      lease = await this.deps.store.acquireLease(connectionId, this.deps.holderId, ttlMs);
      if (lease) break;
      // acquireLease also returns null for absent/tombstoned rows — those are
      // terminal, not contention, so disambiguate before sleeping.
      const current = await this.deps.store.read(connectionId);
      if (!current || current.state === 'tombstoned') {
        throw new TokenCacheUnavailableError('delegated_reauth_required');
      }
      if (attempt < attempts - 1) await sleep(LEASE_RETRY_SLEEP_MS);
    }
    if (!lease) {
      // Contention exhausted the bounded retry — transient; the caller maps
      // this to a retryable failure.
      throw new TokenCacheUnavailableError('credential_rotation_failed');
    }

    try {
      const row = await this.deps.store.read(connectionId);
      if (!row || row.state === 'tombstoned') {
        // NEVER initialize (§3.2): absent means revoked or superseded.
        throw new TokenCacheUnavailableError('delegated_reauth_required');
      }
      let plaintext: string;
      try {
        if (row.ciphertext === null) throw new CorruptCacheCiphertextError('malformed');
        plaintext = decryptCacheBlob(this.deps.keyring, connectionId, row.ciphertext, row.kekVersion);
      } catch (error) {
        if (error instanceof CorruptCacheCiphertextError) {
          // Fail closed, row PRESERVED for forensics — never treat
          // undecryptable as empty.
          throw new TokenCacheUnavailableError('delegated_reauth_required');
        }
        throw error;
      }
      return await fn({
        plaintext,
        cacheVersion: row.cacheVersion,
        fence: lease.fence,
        consentGeneration: row.consentGeneration,
        consentAttemptId: row.consentAttemptId,
      });
    } finally {
      await this.deps.store.releaseLease(connectionId, this.deps.holderId, lease.fence);
    }
  }

  async commitRotation(
    connectionId: string, loaded: LoadedCache, newPlaintext: string,
  ): Promise<'written' | 'concurrent'> {
    const { ciphertext, kekVersion } = encryptCacheBlob(this.deps.keyring, connectionId, newPlaintext);
    const outcome = await this.deps.store.casWrite({
      connectionId, expectedCacheVersion: loaded.cacheVersion, fence: loaded.fence, ciphertext, kekVersion,
    });
    switch (outcome) {
      case 'written': return 'written';
      case 'version-conflict': return 'concurrent';           // retry silent (§3.2)
      case 'fence-superseded':                                 // our lease was superseded; the
        throw new TokenCacheUnavailableError('credential_rotation_failed');  // RT MSAL holds may be lost
      case 'tombstoned':                                       // revoke won the race; never undo it
      case 'absent':
        throw new TokenCacheUnavailableError('delegated_reauth_required');
    }
  }

  async writeConsentRow(input: {
    connectionId: string; consentAttemptId: string; consentGeneration: number; plaintext: string;
  }): Promise<{ cacheGeneration: number }> {
    const { ciphertext, kekVersion } = encryptCacheBlob(this.deps.keyring, input.connectionId, input.plaintext);
    const { cacheVersion } = await this.deps.store.putConsentRow({
      connectionId: input.connectionId,
      consentAttemptId: input.consentAttemptId,
      consentGeneration: input.consentGeneration,
      ciphertext,
      kekVersion,
    });
    return { cacheGeneration: cacheVersion };
  }

  async peekGeneration(
    connectionId: string,
  ): Promise<{ state: 'active' | 'tombstoned'; consentGeneration: number } | null> {
    const row = await this.deps.store.read(connectionId);
    return row ? { state: row.state, consentGeneration: row.consentGeneration } : null;
  }

  tombstone(connectionId: string, onlyIfAttemptId: string | null): Promise<boolean> {
    return this.deps.store.tombstone(connectionId, onlyIfAttemptId);
  }
}
