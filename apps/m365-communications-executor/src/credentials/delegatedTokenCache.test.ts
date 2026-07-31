import { describe, expect, it } from 'vitest';
import { DelegatedTokenCache, TokenCacheUnavailableError, type LoadedCache } from './delegatedTokenCache';
import { InMemoryTokenCacheStore } from './inMemoryTokenCacheStore';
import type { KekKeyring } from './tokenCacheCrypto';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_1 = '22222222-2222-4222-8222-222222222222';
const HOLDER_A = '44444444-4444-4444-8444-444444444444';
const HOLDER_B = '55555555-5555-4555-8555-555555555555';
const KEK_V1 = 'a'.repeat(32);
const TTL_MS = 30_000;

function fixture() {
  let nowMs = Date.parse('2026-07-29T00:00:00.000Z');
  const clock = {
    now: () => new Date(nowMs),
    advance: (ms: number) => { nowMs += ms; },
  };
  const store = new InMemoryTokenCacheStore({ now: clock.now });
  const keyring: KekKeyring = {
    writerVersion: KEK_V1,
    keys: new Map([[KEK_V1, new Uint8Array(Buffer.alloc(32, 7))]]),
  };
  const sleep = async () => {};
  const cacheA = new DelegatedTokenCache({
    store, keyring, holderId: HOLDER_A, leaseTtlMs: TTL_MS, leaseAttempts: 3, sleep,
  });
  const cacheB = new DelegatedTokenCache({
    store, keyring, holderId: HOLDER_B, leaseTtlMs: TTL_MS, leaseAttempts: 3, sleep,
  });
  return { clock, store, keyring, cacheA, cacheB };
}

async function seed(cache: DelegatedTokenCache, plaintext = 'serialized-cache-v1') {
  return cache.writeConsentRow({
    connectionId: CONNECTION,
    consentAttemptId: ATTEMPT_1,
    consentGeneration: 1,
    plaintext,
  });
}

async function load(cache: DelegatedTokenCache): Promise<LoadedCache> {
  return cache.withLease(CONNECTION, async (loaded) => loaded);
}

describe('DelegatedTokenCache §3.2 semantics', () => {
  it('a paused lease holder resuming after expiry is rejected by fence', async () => {
    const { clock, cacheA, cacheB } = fixture();
    await seed(cacheA);

    let loadedB: LoadedCache | null = null;
    await expect(cacheA.withLease(CONNECTION, async (loadedA) => {
      // A pauses; its lease expires; B acquires a newer fence.
      clock.advance(TTL_MS + 1);
      loadedB = await load(cacheB);
      // A resumes: its fence is stale even though nothing was written yet.
      await cacheA.commitRotation(CONNECTION, loadedA, 'A-rotated');
    })).rejects.toMatchObject({ code: 'credential_rotation_failed' });

    // B, holding the newest fence, commits fine — its write lands intact.
    expect(await cacheB.commitRotation(CONNECTION, loadedB!, 'B-rotated')).toBe('written');
    expect((await load(cacheB)).plaintext).toBe('B-rotated');
  });

  it('a revoke racing a refresh cannot be undone', async () => {
    const { cacheA } = fixture();
    await seed(cacheA);
    const loaded = await load(cacheA);

    expect(await cacheA.tombstone(CONNECTION, null)).toBe(true);

    await expect(cacheA.commitRotation(CONNECTION, loaded, 'refreshed'))
      .rejects.toMatchObject({ code: 'delegated_reauth_required' });
    expect(await cacheA.peekGeneration(CONNECTION))
      .toEqual({ state: 'tombstoned', consentGeneration: 1 });
  });

  it('corrupt ciphertext fails closed and preserves the row', async () => {
    const { store, cacheA } = fixture();
    await seed(cacheA);
    // Flip one stored ciphertext byte (read shares the stored byte buffer).
    const stored = await store.read(CONNECTION);
    stored!.ciphertext![0]! ^= 0x01;

    await expect(load(cacheA)).rejects.toMatchObject({ code: 'delegated_reauth_required' });

    // The row is PRESERVED for forensics — never treated as empty or deleted.
    const after = await store.read(CONNECTION);
    expect(after).not.toBeNull();
    expect(after!.state).toBe('active');
    expect(after!.ciphertext).not.toBeNull();
  });

  it('concurrent redemption yields one winner and no lost write', async () => {
    const { cacheA, cacheB } = fixture();
    await seed(cacheA);

    // Both load version 1 — B first, then A, so A holds the newest fence.
    const loadedB = await load(cacheB);
    const loadedA = await load(cacheA);
    expect(loadedA.cacheVersion).toBe(1);
    expect(loadedB.cacheVersion).toBe(1);

    expect(await cacheA.commitRotation(CONNECTION, loadedA, 'A-rotated')).toBe('written');
    // The loser retries silently (§3.2) — reported as 'concurrent', never thrown.
    expect(await cacheB.commitRotation(CONNECTION, loadedB, 'B-rotated')).toBe('concurrent');

    const reloaded = await load(cacheA);
    expect(reloaded.plaintext).toBe('A-rotated');
    expect(reloaded.cacheVersion).toBe(2);
  });

  it('an absent row is never initialized', async () => {
    const { store, cacheA } = fixture();
    await expect(load(cacheA)).rejects.toMatchObject({ code: 'delegated_reauth_required' });
    expect(await store.read(CONNECTION)).toBeNull();
  });

  it('withLease releases the lease on success and on throw', async () => {
    const { cacheA, cacheB } = fixture();
    await seed(cacheA);

    expect(await cacheA.withLease(CONNECTION, async () => 'ok')).toBe('ok');
    // Released: B can acquire immediately.
    expect((await load(cacheB)).cacheVersion).toBe(1);

    await expect(cacheA.withLease(CONNECTION, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await load(cacheB)).cacheVersion).toBe(1);
  });

  it('writeConsentRow returns the bumped cacheGeneration on reconsent', async () => {
    const { cacheA } = fixture();
    expect(await seed(cacheA, 'first-consent')).toEqual({ cacheGeneration: 1 });
    expect(await seed(cacheA, 'reconsent')).toEqual({ cacheGeneration: 2 });
    expect((await load(cacheA)).plaintext).toBe('reconsent');
  });

  it('exhausted lease contention maps to a retryable failure', async () => {
    const { store, cacheA } = fixture();
    await seed(cacheA);
    // Another holder holds an unexpired lease for the whole bounded retry.
    expect(await store.acquireLease(CONNECTION, HOLDER_B, TTL_MS)).toEqual({ fence: 2 });

    await expect(load(cacheA)).rejects.toMatchObject({ code: 'credential_rotation_failed' });
  });

  it('carries only enum words in its message', () => {
    const error = new TokenCacheUnavailableError('binding_stale');
    expect(error.message).toBe('token cache unavailable: binding_stale');
  });
});
