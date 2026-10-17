/**
 * Per-deployment ES256 keyset for Trust Center attestations (W3b, #8771).
 *
 * One signer per deployment: the Breeze installation attests to what its own
 * telemetry computed. Deliberately NOT the OAuth keyset (signs access tokens),
 * the manifest key (agents trust it for updates), the audit-anchor seed or the
 * HS256 JWT keyring (symmetric, cannot be published).
 *
 * Lifecycle (`trust_signing_keys.status`):
 *   pending     published in the JWKS so verifiers can pre-fetch it; does not sign
 *   active      the one signing key (partial unique index)
 *   verify_only published so archived attestations keep verifying; private key destroyed
 *   revoked     removed from the JWKS; private key destroyed
 *
 * Provisioning happens on first use, and ONLY when the table is empty (quorum
 * B1): rows that exist with none active mean an operator revoked or has not yet
 * activated a key, and attestation stays unavailable (503) until they act — a
 * revoke must never silently mint a replacement.
 *
 * Every DB access runs in `runOutsideDbContext(() => withSystemDbAccessContext(…))`
 * (forced RLS, single system-only policy). Private key material is never logged
 * and never cached: the in-process keyset cache holds public fields only.
 */
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { asc, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustSigningKeys } from '../../db/schema/trustSigningKeys';
import { decryptForColumn, encryptSecret } from '../secretCrypto';
import { HotPathTtlCache } from '../hotPathCache';
import { getClusterCacheBus, type PublishOutcome } from '../clusterCacheBus';

export type TrustKeyStatus = 'pending' | 'active' | 'verify_only' | 'revoked';

export interface TrustKeyRow {
  kid: string;
  publicJwk: JWK;
  privateKeyEnc: string | null;
  status: TrustKeyStatus;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  revokedAt: Date | null;
}

/** What the CLI prints and the cache holds: never private material. */
export type TrustKeyInfo = Omit<TrustKeyRow, 'privateKeyEnc' | 'publicJwk'>;

export interface ActiveTrustKey {
  kid: string;
  publicJwk: JWK;
}

export interface TrustKeyTx {
  list(): Promise<TrustKeyRow[]>;
  /** false when the row lost the one-active race (partial unique index); any other conflict throws. */
  insert(row: Pick<TrustKeyRow, 'kid' | 'publicJwk' | 'privateKeyEnc' | 'status'> & { activatedAt?: Date | null }): Promise<boolean>;
  update(kid: string, patch: Partial<Pick<TrustKeyRow, 'status' | 'privateKeyEnc' | 'activatedAt' | 'retiredAt' | 'revokedAt'>>): Promise<void>;
}

/** Transaction seam: one `run` is one transaction. Production is Postgres; unit tests use an in-memory store. */
export interface TrustKeyStore {
  run<T>(fn: (tx: TrustKeyTx) => Promise<T>): Promise<T>;
}

export class TrustAttestationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustAttestationUnavailable';
  }
}

/** An operator command that was refused (CLI exit 1). */
export class TrustSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustSigningKeyError';
  }
}

export const TRUST_SIGNING_ALG = 'ES256';
export const TRUST_KEY_AAD = 'trust_signing_keys.private_key_enc';
/** JWKS `Cache-Control: max-age`. `activate` waits this long after `prepare` so caching verifiers have the new key. */
export const TRUST_JWKS_MAX_AGE_SECONDS = 600;
export const TRUST_KEYSET_CACHE_TTL_MS = 60_000;
const JWKS_STATUSES: ReadonlySet<TrustKeyStatus> = new Set(['pending', 'active', 'verify_only']);

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

const pgTx: TrustKeyTx = {
  async list() {
    const rows = await db
      .select({
        kid: trustSigningKeys.kid,
        publicJwk: trustSigningKeys.publicJwk,
        privateKeyEnc: trustSigningKeys.privateKeyEnc,
        status: trustSigningKeys.status,
        createdAt: trustSigningKeys.createdAt,
        activatedAt: trustSigningKeys.activatedAt,
        retiredAt: trustSigningKeys.retiredAt,
        revokedAt: trustSigningKeys.revokedAt,
      })
      .from(trustSigningKeys)
      .orderBy(asc(trustSigningKeys.createdAt), asc(trustSigningKeys.kid));
    return rows.map((r) => ({ ...r, publicJwk: r.publicJwk as JWK }));
  },
  async insert(row) {
    // Scoped to exactly the one-active partial index (as manifestSigning #640):
    // a kid collision or any other constraint still raises.
    const inserted = await db
      .insert(trustSigningKeys)
      .values({
        kid: row.kid,
        publicJwk: row.publicJwk,
        privateKeyEnc: row.privateKeyEnc,
        status: row.status,
        activatedAt: row.activatedAt ?? null,
      })
      .onConflictDoNothing({ target: trustSigningKeys.status, where: sql`status = 'active'` })
      .returning({ kid: trustSigningKeys.kid });
    return inserted.length > 0;
  },
  async update(kid, patch) {
    await db.update(trustSigningKeys).set(patch).where(eq(trustSigningKeys.kid, kid));
  },
};

const pgStore: TrustKeyStore = {
  run: (fn) => runOutsideDbContext(() => withSystemDbAccessContext(() => fn(pgTx), 'trust-signing-keys')),
};

let store: TrustKeyStore = pgStore;

/** Test seam: swap the store (null restores Postgres). */
export function __setTrustKeyStoreForTests(next: TrustKeyStore | null): void {
  store = next ?? pgStore;
}

// ---------------------------------------------------------------------------
// Keyset cache (public fields only)
// ---------------------------------------------------------------------------

interface CachedKey extends TrustKeyInfo {
  publicJwk: JWK;
}

const keysetCache = new HotPathTtlCache<'keyset', CachedKey[]>({
  name: 'trust-attestation-keyset',
  ttlMs: TRUST_KEYSET_CACHE_TTL_MS,
  maxEntries: 1,
  cluster: true,
});

const toInfo = (r: TrustKeyRow): TrustKeyInfo => ({
  kid: r.kid,
  status: r.status,
  createdAt: r.createdAt,
  activatedAt: r.activatedAt,
  retiredAt: r.retiredAt,
  revokedAt: r.revokedAt,
});

function loadKeyset(): Promise<CachedKey[]> {
  return keysetCache.getOrLoad('keyset', () =>
    store.run(async (tx) => (await tx.list()).map((r) => ({ ...toInfo(r), publicJwk: publicOnly(r.publicJwk) }))),
  );
}

/** Drop the keyset here and announce it to every API instance (after the write committed). */
function keysetChanged(): void {
  keysetCache.invalidateAroundCommit();
}

/**
 * For the out-of-process rotation CLI: announce the change to every API
 * instance and wait for the publish. Never throws.
 */
export async function notifyTrustKeysetChanged(): Promise<PublishOutcome> {
  return getClusterCacheBus().publish(keysetCache.name, null);
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** The public EC members only, whatever the input carries. */
function publicOnly(jwk: JWK): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

async function generateTrustKey(): Promise<{ kid: string; publicJwk: JWK; privateKeyEnc: string }> {
  const { publicKey, privateKey } = await generateKeyPair(TRUST_SIGNING_ALG, { extractable: true });
  const publicJwk = publicOnly(await exportJWK(publicKey));
  // RFC 7638 thumbprint over {crv,kty,x,y}; 16 chars keeps the kid short and still collision-free in practice
  // (the column is UNIQUE regardless).
  const kid = `trust-${(await calculateJwkThumbprint(publicJwk, 'sha256')).slice(0, 16)}`;
  const privateKeyEnc = encryptSecret(JSON.stringify(await exportJWK(privateKey)), { aad: TRUST_KEY_AAD });
  if (!privateKeyEnc) throw new Error('encryptSecret returned null for the trust signing key');
  return { kid, publicJwk, privateKeyEnc };
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

/**
 * The active signing key's public half. Provisions one when the table has
 * never held a key; throws TrustAttestationUnavailable when keys exist but
 * none is active (revoked without --replace, or prepared but not activated).
 */
export async function ensureActiveTrustSigningKey(): Promise<ActiveTrustKey> {
  const keyset = await loadKeyset();
  const cached = keyset.find((k) => k.status === 'active');
  if (cached) return { kid: cached.kid, publicJwk: cached.publicJwk };
  if (keyset.length > 0) throw new TrustAttestationUnavailable('no active trust signing key (an operator must activate one)');

  const result = await store.run(async (tx): Promise<ActiveTrustKey | 'not_empty'> => {
    const rows = await tx.list();
    const active = rows.find((r) => r.status === 'active');
    if (active) return { kid: active.kid, publicJwk: publicOnly(active.publicJwk) };
    if (rows.length > 0) return 'not_empty';
    const generated = await generateTrustKey();
    const inserted = await tx.insert({ ...generated, status: 'active', activatedAt: new Date() });
    if (inserted) {
      console.log(`[trustAttestation] Generated deployment attestation key ${generated.kid}`);
      return { kid: generated.kid, publicJwk: generated.publicJwk };
    }
    // Another instance provisioned concurrently: its insert has committed (ON CONFLICT waited for it).
    const winner = (await tx.list()).find((r) => r.status === 'active');
    if (!winner) throw new Error('trust signing key insert conflicted but no active row was found');
    return { kid: winner.kid, publicJwk: publicOnly(winner.publicJwk) };
  });
  keysetChanged();
  if (result === 'not_empty') throw new TrustAttestationUnavailable('no active trust signing key (an operator must activate one)');
  return result;
}

/** Public JWKS: pending, active and verify_only keys. Never revoked keys, never private members. */
export async function loadTrustJwks(): Promise<{ keys: JWK[] }> {
  const keyset = await loadKeyset();
  return {
    keys: keyset
      .filter((k) => JWKS_STATUSES.has(k.status))
      .map((k) => ({ ...publicOnly(k.publicJwk), kid: k.kid, alg: TRUST_SIGNING_ALG, use: 'sig' })),
  };
}

/**
 * The private key for `kid`, read uncached and only while `kid` is still the
 * active key — a key rotated or revoked since the keyset was cached never signs.
 */
export async function loadTrustSigningKey(kid: string): Promise<CryptoKey> {
  const enc = await store.run(async (tx) => (await tx.list()).find((r) => r.kid === kid && r.status === 'active')?.privateKeyEnc ?? null);
  if (!enc) throw new TrustAttestationUnavailable(`trust signing key ${kid} is not active`);
  const json = decryptForColumn('trust_signing_keys', 'private_key_enc', enc);
  if (!json) throw new TrustAttestationUnavailable(`trust signing key ${kid} could not be decrypted`);
  const key = await importJWK(JSON.parse(json) as JWK, TRUST_SIGNING_ALG);
  if (key instanceof Uint8Array) throw new Error('trust signing key imported as a symmetric secret');
  return key;
}

export async function listTrustSigningKeys(): Promise<TrustKeyInfo[]> {
  return store.run(async (tx) => (await tx.list()).map(toInfo));
}

// ---------------------------------------------------------------------------
// Operator commands (scripts/trust-signing-key.ts)
// ---------------------------------------------------------------------------

/** Create a pending key: published in the JWKS, not yet signing. One pending key at a time. */
export async function prepareTrustSigningKey(): Promise<TrustKeyInfo> {
  const info = await store.run(async (tx) => {
    const rows = await tx.list();
    const pending = rows.find((r) => r.status === 'pending');
    if (pending) throw new TrustSigningKeyError(`key ${pending.kid} is already pending; activate or revoke it first`);
    const generated = await generateTrustKey();
    await tx.insert({ ...generated, status: 'pending' });
    const created = (await tx.list()).find((r) => r.kid === generated.kid);
    if (!created) throw new Error(`prepared key ${generated.kid} was not found after insert`);
    return toInfo(created);
  });
  keysetChanged();
  return info;
}

/**
 * Promote a pending key; the current active key becomes verify_only and its
 * private key is destroyed — one transaction. Refused until the pending key
 * has been in the JWKS for a full JWKS max-age (unless `force`), so verifiers
 * that cache the JWKS already hold it when the first token it signs arrives.
 */
export async function activateTrustSigningKey(kid: string, opts: { force?: boolean } = {}): Promise<TrustKeyInfo[]> {
  const result = await store.run(async (tx) => {
    const rows = await tx.list();
    const target = rows.find((r) => r.kid === kid);
    if (!target) throw new TrustSigningKeyError(`no trust signing key ${kid}`);
    if (target.status !== 'pending') throw new TrustSigningKeyError(`key ${kid} is ${target.status}; only a pending key can be activated`);
    const now = new Date();
    const ageSeconds = (now.getTime() - target.createdAt.getTime()) / 1000;
    if (!opts.force && ageSeconds < TRUST_JWKS_MAX_AGE_SECONDS) {
      throw new TrustSigningKeyError(
        `key ${kid} was prepared ${Math.floor(ageSeconds)} s ago; wait until it has been published for ${TRUST_JWKS_MAX_AGE_SECONDS} s (the JWKS max-age) or pass --force`,
      );
    }
    for (const current of rows.filter((r) => r.status === 'active')) {
      await tx.update(current.kid, { status: 'verify_only', privateKeyEnc: null, retiredAt: now });
    }
    await tx.update(kid, { status: 'active', activatedAt: now });
    return (await tx.list()).map(toInfo);
  });
  keysetChanged();
  return result;
}

/**
 * Remove a key from the JWKS and destroy its private key. Revoking the active
 * key leaves NO signer (attestation answers 503) unless `replace`, which mints
 * and activates a successor in the same transaction.
 */
export async function revokeTrustSigningKey(kid: string, opts: { replace?: boolean } = {}): Promise<TrustKeyInfo[]> {
  const result = await store.run(async (tx) => {
    const rows = await tx.list();
    const target = rows.find((r) => r.kid === kid);
    if (!target) throw new TrustSigningKeyError(`no trust signing key ${kid}`);
    if (target.status === 'revoked') throw new TrustSigningKeyError(`key ${kid} is already revoked`);
    if (opts.replace && target.status !== 'active') {
      throw new TrustSigningKeyError(`--replace applies only to the active key; ${kid} is ${target.status}`);
    }
    const now = new Date();
    await tx.update(kid, { status: 'revoked', privateKeyEnc: null, revokedAt: now });
    if (opts.replace) {
      const generated = await generateTrustKey();
      const inserted = await tx.insert({ ...generated, status: 'active', activatedAt: now });
      if (!inserted) throw new Error('replacement key could not be activated (another key became active concurrently)');
    }
    return (await tx.list()).map(toInfo);
  });
  keysetChanged();
  return result;
}
