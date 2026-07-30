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
  createPublicKey,
  sign,
  verify,
  randomBytes,
} from 'node:crypto';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  manifestSigningKeys,
  manifestSigningKeyDelegations,
} from '../db/schema/manifestSigningKeys';
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

// =====================================================================
// Signed manifest key delegation (security remediation Wave 6, Task 7)
//
// Wave 6 Task 6 froze trust-on-first-use in the agent: once an agent has
// pinned its one deployment signing key, ANY previously unseen key offered
// over enrollment/heartbeat is rejected. That deliberately removed the
// ability of a control plane with API/DB write access — but WITHOUT the
// signing private key — to introduce a key of its own and sign agent
// updates with it (SYSTEM/root remote code execution).
//
// A ManifestKeyDelegation is the ONLY thing that lifts that freeze, and it
// only does so for exactly one named new key. It is signed by the key that
// is ALREADY trusted, so database write access alone cannot forge one.
// =====================================================================

/**
 * Domain separator, and line 1 of the canonical signing payload.
 *
 * It exists so a signature over a delegation can never be replayed as a
 * signature over an update manifest (or any future signed structure) made
 * by the same key: the payloads cannot collide because manifests are JSON
 * objects starting with '{'.
 */
export const MANIFEST_DELEGATION_DOMAIN = 'breeze-manifest-key-delegation-v1';

/** Wire record delivered to agents by enrollment and heartbeat. */
export interface ManifestKeyDelegation {
  schemaVersion: 1;
  oldKeyId: string;
  newKeyId: string;
  newPublicKeyB64: string;
  epoch: number;
  notBefore: string;
  notAfter: string;
  signatureBase64: string;
}

/** The fields the signature actually covers. */
export interface ManifestDelegationSignedFields {
  oldKeyId: string;
  newKeyId: string;
  newPublicKeyB64: string;
  epoch: number;
  notBefore: string;
  notAfter: string;
}

/**
 * Builds the EXACT bytes that are signed and verified.
 *
 *   line 1  breeze-manifest-key-delegation-v1
 *   line 2  <old key ID>
 *   line 3  <new key ID>
 *   line 4  <new public key base64>
 *   line 5  <unsigned decimal epoch>
 *   line 6  <UTC RFC3339 not-before>
 *   line 7  <UTC RFC3339 not-after>
 *
 * UTF-8, LF-separated, and with NO trailing newline. This is a wire
 * contract with agent/internal/config/manifestdelegation.go's
 * ManifestDelegationCanonicalBytes — a one-byte difference (a trailing
 * newline included) makes every delegation unverifiable fleet-wide while
 * both sides look correct in isolation. Both sides pin the same SHA-256
 * over the same golden fixture in their tests.
 *
 * `notBefore`/`notAfter` are passed through VERBATIM rather than
 * re-formatted, because the agent rebuilds these bytes from the strings it
 * received on the wire. Normalisation must therefore happen once, at
 * write time (see delegationTimestamp), never here.
 */
export function manifestDelegationCanonicalBytes(
  fields: ManifestDelegationSignedFields,
): Buffer {
  const lines = [
    MANIFEST_DELEGATION_DOMAIN,
    fields.oldKeyId,
    fields.newKeyId,
    fields.newPublicKeyB64,
    formatDelegationEpoch(fields.epoch),
    fields.notBefore,
    fields.notAfter,
  ];

  // A field containing the line separator could shift the meaning of every
  // later line while producing bytes that still verify — e.g. a key id of
  // "x\n<other key>" would let one signature stand for two different
  // delegations. Reject rather than escape: no legitimate value contains a
  // newline (key ids are [A-Za-z0-9._-], the rest are base64 or RFC3339).
  for (const [index, line] of lines.entries()) {
    if (/[\r\n]/.test(line)) {
      throw new Error(
        `manifest delegation field #${index + 1} is malformed: contains a newline`,
      );
    }
  }

  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Renders the epoch as an unsigned decimal integer.
 *
 * Rejects anything that would not round-trip identically on the Go side's
 * strconv.ParseUint: negatives, fractions, and values beyond the safe
 * integer range (which would silently lose precision in JSON).
 */
function formatDelegationEpoch(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(
      'manifest delegation epoch must be a non-negative safe integer',
    );
  }
  return String(epoch);
}

/**
 * Canonical second-precision RFC3339 UTC rendering, e.g.
 * `2026-08-06T00:00:00Z`.
 *
 * Deliberately NOT `Date#toISOString()`, which emits `.000Z`. Milliseconds
 * are meaningless for a multi-day trust window, and — far more importantly
 * — the stored timestamp is re-serialised on every delivery, so the string
 * the agent receives must be reproducible from the stored value forever.
 * Any format the signer did not use makes the signature fail to verify.
 */
export function delegationTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

/**
 * Signs a delegation with an ALREADY-ACTIVE signing key.
 *
 * `seedB64` is the decrypted raw Ed25519 seed of the OLD key — the key the
 * fleet already trusts. Signing with anything else produces a record every
 * agent will reject, which is the property that makes DB write access
 * insufficient to forge one.
 */
export function signManifestKeyDelegation(
  fields: ManifestDelegationSignedFields,
  seedB64: string,
): string {
  const key = privateKeyFromRawSeed(seedB64);
  return sign(null, manifestDelegationCanonicalBytes(fields), key).toString(
    'base64',
  );
}

/**
 * Verifies a delegation signature against a raw base64 Ed25519 public key.
 *
 * Used by the rotation CLI to self-check what it just produced before
 * committing it — a delegation that does not verify on the server would
 * strand the rotation with an epoch already consumed.
 */
export function verifyManifestKeyDelegation(
  fields: ManifestDelegationSignedFields,
  signatureBase64: string,
  publicKeyB64: string,
): boolean {
  const raw = Buffer.from(publicKeyB64, 'base64');
  if (raw.length !== RAW_KEY_LEN) return false;
  // createPublicKey belongs INSIDE the try: 32 bytes of the right length can
  // still fail SPKI import (e.g. not a valid curve point), and this function
  // is documented to return a boolean, not to throw.
  try {
    const spki = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        raw,
      ]),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      manifestDelegationCanonicalBytes(fields),
      spki,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Returns the delegation records currently inside their validity window,
 * oldest epoch first, for delivery to agents via enrollment and heartbeat.
 *
 * ACTIVATED RECORDS ARE STILL RETURNED. Activation is a server-side event
 * (the new key starts signing); adoption is a per-agent event. An agent
 * that was offline when the window opened must still be able to adopt
 * after activation, otherwise it is permanently stranded on a key that no
 * longer signs anything.
 *
 * Ordering is ascending by epoch so that, in the (CLI-prevented) event of
 * more than one in-window record, an agent applies them as a chain rather
 * than out of order.
 *
 * This performs DATABASE WORK ONLY. It makes no network or queue call, so
 * enrollment may call it inside its system DB context (#1105) — the rule
 * that boundary enforces is "no external handoff while holding a pooled
 * connection", not "no queries".
 */
export async function getActiveManifestKeyDelegations(
  now: Date = new Date(),
): Promise<ManifestKeyDelegation[]> {
  const rows = await withSystemDbAccessContext(async () => {
    return db
      .select({
        epoch: manifestSigningKeyDelegations.epoch,
        oldKeyId: manifestSigningKeyDelegations.oldKeyId,
        newKeyId: manifestSigningKeyDelegations.newKeyId,
        newPublicKeyB64: manifestSigningKeyDelegations.newPublicKeyB64,
        notBefore: manifestSigningKeyDelegations.notBefore,
        notAfter: manifestSigningKeyDelegations.notAfter,
        signatureB64: manifestSigningKeyDelegations.signatureB64,
      })
      .from(manifestSigningKeyDelegations)
      .where(
        and(
          lte(manifestSigningKeyDelegations.notBefore, now),
          gt(manifestSigningKeyDelegations.notAfter, now),
        ),
      )
      .orderBy(asc(manifestSigningKeyDelegations.epoch));
  });

  return rows.map((row) => ({
    schemaVersion: 1 as const,
    oldKeyId: row.oldKeyId,
    newKeyId: row.newKeyId,
    newPublicKeyB64: row.newPublicKeyB64,
    epoch: Number(row.epoch),
    notBefore: delegationTimestamp(row.notBefore),
    notAfter: delegationTimestamp(row.notAfter),
    signatureBase64: row.signatureB64,
  }));
}
