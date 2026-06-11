/**
 * Per-deployment Ed25519 manifest signing for self-host BINARY_SOURCE=local agent updates.
 *
 * The private key is encrypted with APP_ENCRYPTION_KEY and stored in `manifest_signing_keys`.
 * syncBinaries (binarySync.ts) calls ensureActiveSigningKey() on startup to provision a key,
 * then signs each manifest. getActiveTrustKeyset() delivers the public keyset to agents via
 * REST heartbeat and enrollment so they can verify locally-signed update manifests.
 *
 * Trust posture: defends against DB-only compromise (SQL injection, Postgres takeover,
 * RLS bypass mutating downloadUrl). Does NOT defend against host compromise — the
 * encryption key, the DB, and the API process all run on the same host in the typical
 * self-host topology. See docs/deploy/agent-update-trust-bootstrap.md and issue #625.
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  sign,
  randomBytes,
} from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { manifestSigningKeys } from '../db/schema/manifestSigningKeys';
import { encryptSecret, decryptForColumn } from './secretCrypto';

export interface ActiveSigningKey {
  keyId: string;
  publicKeyB64: string;
}

export interface ManifestTrustKey {
  keyId: string;
  publicKeyB64: string;
  validFrom: string;
}

const RAW_KEY_LEN = 32;
// PKCS8 prefix for Ed25519: wraps a raw 32-byte seed back into a
// Node-importable DER form (type: 'pkcs8'). Used by privateKeyFromRawSeed().
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/**
 * Extracts the raw 32-byte public key from an Ed25519 SPKI DER buffer.
 * SPKI format: SEQUENCE(SEQUENCE(OID 1.3.101.112) BITSTRING(0 + 32 bytes)).
 * The last 32 bytes of the export are always the raw public key.
 */
function rawPubFromSpki(spki: Buffer): string {
  return spki.subarray(spki.length - RAW_KEY_LEN).toString('base64');
}

function rawPrivFromPkcs8(pkcs8: Buffer): string {
  return pkcs8.subarray(pkcs8.length - RAW_KEY_LEN).toString('base64');
}

function privateKeyFromRawSeed(seedB64: string) {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== RAW_KEY_LEN) {
    throw new Error('invalid Ed25519 seed length');
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

interface ActiveRow {
  keyId: string;
  publicKeyB64: string;
  privateKeyEnc: string;
  createdAt: Date;
}

async function loadActive(): Promise<ActiveRow | null> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({
        keyId: manifestSigningKeys.keyId,
        publicKeyB64: manifestSigningKeys.publicKeyB64,
        privateKeyEnc: manifestSigningKeys.privateKeyEnc,
        createdAt: manifestSigningKeys.createdAt,
      })
      .from(manifestSigningKeys)
      .where(eq(manifestSigningKeys.status, 'active'))
      .limit(1);
    return rows[0] ?? null;
  });
}

async function loadAllActive(): Promise<ActiveRow[]> {
  return withSystemDbAccessContext(async () => {
    return db
      .select({
        keyId: manifestSigningKeys.keyId,
        publicKeyB64: manifestSigningKeys.publicKeyB64,
        privateKeyEnc: manifestSigningKeys.privateKeyEnc,
        createdAt: manifestSigningKeys.createdAt,
      })
      .from(manifestSigningKeys)
      .where(eq(manifestSigningKeys.status, 'active'));
  });
}

export async function ensureActiveSigningKey(): Promise<ActiveSigningKey> {
  const existing = await loadActive();
  if (existing) {
    return { keyId: existing.keyId, publicKeyB64: existing.publicKeyB64 };
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicKeyB64 = rawPubFromSpki(spki);
  const privateKeyB64 = rawPrivFromPkcs8(pkcs8);

  const encryptedPriv = encryptSecret(privateKeyB64);
  if (!encryptedPriv) {
    throw new Error('encryptSecret returned null for Ed25519 seed');
  }

  // keyId is operator-readable (date helps in support tickets); uniqueness is
  // enforced by the UNIQUE constraint on key_id, the random suffix is just
  // collision-avoidance for same-day generation.
  const keyId = `deploy-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;

  // Race-safe insert: two concurrent callers (e.g. binarySync starting on
  // two API workers at the same time) can both see loadActive()=null and
  // both try to INSERT. The partial unique index uq_manifest_signing_keys_active
  // (on `status` WHERE status = 'active') makes the loser throw. Scope
  // onConflictDoNothing to exactly that partial index so an unrelated
  // constraint conflict (e.g. a future UNIQUE on key_id) still raises
  // instead of being silently swallowed. (#640)
  const inserted = await withSystemDbAccessContext(async () => {
    return db
      .insert(manifestSigningKeys)
      .values({
        keyId,
        publicKeyB64,
        privateKeyEnc: encryptedPriv,
        status: 'active',
      })
      .onConflictDoNothing({
        target: manifestSigningKeys.status,
        where: sql`status = 'active'`,
      })
      .returning({ keyId: manifestSigningKeys.keyId });
  });

  if (inserted.length === 0) {
    // Another concurrent caller inserted the active key first. Reload and
    // return whichever key won the race. Log both keyIds so ops can trace
    // two-worker startup races back to the losing worker.
    const winner = await loadActive();
    if (!winner) {
      throw new Error(
        'ensureActiveSigningKey: insert conflict but no active row found on reload',
      );
    }
    console.log(
      `[manifestSigning] Lost race for active signing key: generated ${keyId} locally, but ${winner.keyId} won — using winner`,
    );
    return { keyId: winner.keyId, publicKeyB64: winner.publicKeyB64 };
  }

  console.log(`[manifestSigning] Generated new deployment signing key ${keyId}`);
  return { keyId, publicKeyB64 };
}

export async function signManifest(manifestJson: string): Promise<string> {
  const active = await loadActive();
  if (!active) {
    throw new Error('no active manifest signing key — call ensureActiveSigningKey first');
  }
  const seedB64 = decryptForColumn('manifest_signing_keys', 'private_key_enc', active.privateKeyEnc);
  if (!seedB64) {
    throw new Error('decryptSecret returned null for active signing key');
  }
  const key = privateKeyFromRawSeed(seedB64);
  return sign(null, Buffer.from(manifestJson, 'utf8'), key).toString('base64');
}

export async function getActivePublicKeys(): Promise<string[]> {
  const rows = await loadAllActive();
  return rows.map((r) => r.publicKeyB64);
}

export async function getActiveTrustKeyset(): Promise<ManifestTrustKey[]> {
  const rows = await loadAllActive();
  return rows.map((r) => ({
    keyId: r.keyId,
    publicKeyB64: r.publicKeyB64,
    validFrom: r.createdAt.toISOString(),
  }));
}
