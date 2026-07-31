import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { InMemoryTokenCacheStore } from './inMemoryTokenCacheStore';
import { PostgresTokenCacheStore } from './postgresTokenCacheStore';
import type { TokenCacheStore } from './tokenCacheStore';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_1 = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_2 = '33333333-3333-4333-8333-333333333333';
const HOLDER_A = '44444444-4444-4444-8444-444444444444';
const HOLDER_B = '55555555-5555-4555-8555-555555555555';
const TTL_MS = 30_000;

const BLOB_1 = new TextEncoder().encode('cache-blob-one');
const BLOB_2 = new TextEncoder().encode('cache-blob-two');

interface StoreHarness {
  store: TokenCacheStore;
  /** Force the current lease to be expired (in-memory: advance the fake clock; Postgres: UPDATE lease_expires_at into the past). */
  expireLease(connectionId: string): Promise<void>;
  cleanup(): Promise<void>;
}

function consentInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION,
    consentAttemptId: ATTEMPT_1,
    consentGeneration: 1,
    ciphertext: BLOB_1,
    kekVersion: 'a'.repeat(32),
    ...overrides,
  };
}

function casInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION,
    expectedCacheVersion: 1,
    fence: 1,
    ciphertext: BLOB_2,
    kekVersion: 'a'.repeat(32),
    ...overrides,
  };
}

function runTokenCacheStoreContract(
  name: string,
  harnessFactory: () => Promise<StoreHarness>,
) {
  describe(`${name} contract`, () => {
    async function withHarness(run: (harness: StoreHarness) => Promise<void>) {
      const harness = await harnessFactory();
      try {
        await run(harness);
      } finally {
        await harness.cleanup();
      }
    }

    it('read of an absent connection returns null', () => withHarness(async ({ store }) => {
      expect(await store.read(CONNECTION)).toBeNull();
    }));

    it('putConsentRow creates an active row at cache_version 1, fence 1', () => withHarness(async ({ store }) => {
      expect(await store.putConsentRow(consentInput())).toEqual({ cacheVersion: 1 });
      const row = await store.read(CONNECTION);
      expect(row).toMatchObject({
        connectionId: CONNECTION,
        cacheVersion: 1,
        fence: 1,
        consentGeneration: 1,
        consentAttemptId: ATTEMPT_1,
        state: 'active',
        kekVersion: 'a'.repeat(32),
        leaseHolder: null,
        leaseFence: null,
        leaseExpiresAt: null,
      });
      expect(new Uint8Array(row!.ciphertext!)).toEqual(BLOB_1);
    }));

    it('putConsentRow for a new attempt wholly replaces the row and bumps version and fence', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      // Also proves a tombstoned row is revived — re-consent after revoke.
      expect(await store.tombstone(CONNECTION, null)).toBe(true);
      const replaced = await store.putConsentRow(consentInput({
        consentAttemptId: ATTEMPT_2,
        consentGeneration: 2,
        ciphertext: BLOB_2,
        kekVersion: 'b'.repeat(32),
      }));
      expect(replaced.cacheVersion).toBe(3);
      const row = await store.read(CONNECTION);
      expect(row).toMatchObject({
        cacheVersion: 3,
        fence: 3,
        consentGeneration: 2,
        consentAttemptId: ATTEMPT_2,
        state: 'active',
        kekVersion: 'b'.repeat(32),
        leaseHolder: null,
        leaseFence: null,
        leaseExpiresAt: null,
      });
      expect(new Uint8Array(row!.ciphertext!)).toEqual(BLOB_2);
    }));

    it('casWrite with the current version and fence writes and bumps cache_version', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      expect(await store.casWrite(casInput())).toBe('written');
      const row = await store.read(CONNECTION);
      expect(row!.cacheVersion).toBe(2);
      expect(new Uint8Array(row!.ciphertext!)).toEqual(BLOB_2);
    }));

    it('casWrite against a bumped version reports version-conflict', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      expect(await store.casWrite(casInput())).toBe('written');
      // Concurrent redemption — the caller retries silently (design §3.2).
      expect(await store.casWrite(casInput())).toBe('version-conflict');
      const row = await store.read(CONNECTION);
      expect(row!.cacheVersion).toBe(2);
    }));

    it('casWrite against a tombstoned row reports tombstoned', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      await store.tombstone(CONNECTION, null);
      // Revoke racing a refresh cannot be undone.
      expect(await store.casWrite(casInput({ expectedCacheVersion: 2, fence: 99 }))).toBe('tombstoned');
      const row = await store.read(CONNECTION);
      expect(row!.state).toBe('tombstoned');
      expect(row!.ciphertext).toBeNull();
    }));

    it('casWrite with a stale fence reports fence-superseded', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      const lease = await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS);
      expect(lease).toEqual({ fence: 2 });
      // The row now carries a newer fence than the writer's.
      expect(await store.casWrite(casInput({ expectedCacheVersion: 1, fence: 1 }))).toBe('fence-superseded');
    }));

    it('casWrite against an absent row reports absent and does NOT create it', () => withHarness(async ({ store }) => {
      // acquireTokenSilent must never initialize a row (design §3.2).
      expect(await store.casWrite(casInput())).toBe('absent');
      expect(await store.read(CONNECTION)).toBeNull();
    }));

    it('acquireLease returns a monotonically increasing fence and excludes a second holder', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      const first = await store.acquireLease(CONNECTION, HOLDER_A, TTL_MS);
      expect(first).toEqual({ fence: 2 });
      expect(await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS)).toBeNull();
      await store.releaseLease(CONNECTION, HOLDER_A, first!.fence);
      const second = await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS);
      expect(second).toEqual({ fence: 3 });
    }));

    it('acquireLease succeeds after the previous lease expires', () => withHarness(async ({ store, expireLease }) => {
      await store.putConsentRow(consentInput());
      expect(await store.acquireLease(CONNECTION, HOLDER_A, TTL_MS)).toEqual({ fence: 2 });
      await expireLease(CONNECTION);
      expect(await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS)).toEqual({ fence: 3 });
    }));

    it('releaseLease frees the lease only for the holding fence', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      const lease = await store.acquireLease(CONNECTION, HOLDER_A, TTL_MS);
      expect(lease).toEqual({ fence: 2 });
      // Wrong fence: no-op.
      await store.releaseLease(CONNECTION, HOLDER_A, 1);
      expect(await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS)).toBeNull();
      // Wrong holder: no-op.
      await store.releaseLease(CONNECTION, HOLDER_B, lease!.fence);
      expect(await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS)).toBeNull();
      // The holding fence: frees.
      await store.releaseLease(CONNECTION, HOLDER_A, lease!.fence);
      expect(await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS)).toEqual({ fence: 3 });
    }));

    it('tombstone conditioned on a stale attempt id is a no-op; unconditional tombstone nulls the ciphertext', () => withHarness(async ({ store }) => {
      await store.putConsentRow(consentInput());
      expect(await store.tombstone(CONNECTION, ATTEMPT_2)).toBe(false);
      expect((await store.read(CONNECTION))!.state).toBe('active');
      expect(await store.tombstone(CONNECTION, null)).toBe(true);
      const row = await store.read(CONNECTION);
      expect(row).toMatchObject({
        state: 'tombstoned',
        ciphertext: null,
        kekVersion: null,
        leaseHolder: null,
        leaseFence: null,
        leaseExpiresAt: null,
      });
      // Terminal: a second tombstone reports false, the matching-attempt form too.
      expect(await store.tombstone(CONNECTION, null)).toBe(false);
      expect(await store.tombstone(CONNECTION, ATTEMPT_1)).toBe(false);
    }));
  });
}

async function makeInMemoryHarness(): Promise<StoreHarness> {
  let nowMs = Date.parse('2026-07-29T00:00:00.000Z');
  const store = new InMemoryTokenCacheStore({ now: () => new Date(nowMs) });
  return {
    store,
    async expireLease() {
      nowMs += TTL_MS + 1;
    },
    async cleanup() {
      await store.close();
    },
  };
}

runTokenCacheStoreContract('InMemoryTokenCacheStore', makeInMemoryHarness);

const PG_DSN = process.env.M365_COMMS_TOKEN_CACHE_TEST_DSN;

async function makePostgresHarness(dsn: string): Promise<StoreHarness> {
  const store = new PostgresTokenCacheStore(dsn);
  await store.ensureSchema();
  const sql = postgres(dsn, { max: 1, prepare: false });
  await sql`TRUNCATE comms_token_cache`;
  return {
    store,
    async expireLease(connectionId) {
      await sql`
        UPDATE comms_token_cache
           SET lease_expires_at = now() - interval '1 second'
         WHERE connection_id = ${connectionId}`;
    },
    async cleanup() {
      await sql.end();
      await store.close();
    },
  };
}

describe.runIf(!!PG_DSN)('PostgresTokenCacheStore (live)', () => {
  runTokenCacheStoreContract('PostgresTokenCacheStore', () => makePostgresHarness(PG_DSN!));
});
