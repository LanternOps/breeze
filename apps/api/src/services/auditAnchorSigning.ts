/**
 * Ed25519 signing seam for audit-chain anchors (issue #916).
 *
 * An anchor (see jobs/auditChainAnchor.ts) snapshots the audit_log_chain head
 * for an org. To make that snapshot trustworthy AFTER it leaves the database
 * — i.e. once it is shipped to immutable off-box storage (the deferred phase-2
 * step) — each anchor is signed with an Ed25519 key that is NOT the breeze_app
 * DB credential. A verifier with only the public key can then confirm that a
 * retained anchor was emitted by this deployment and was not forged by whoever
 * later controls the off-box store.
 *
 * KEY SOURCING (env-gated, no infra required to ship):
 *   - AUDIT_ANCHOR_SIGNING_KEY set → raw 32-byte Ed25519 seed, base64. The
 *     deployment signs anchors with it; getAnchorSigningPublicKey() exposes the
 *     matching SPKI public key (base64) for off-box verification + ops display.
 *   - unset → signing is DISABLED. Anchors are still written (the in-DB
 *     append-only guarantee stands on its own); signature/signing_key_id are
 *     left NULL. signAnchorPayload() returns null. This keeps the feature
 *     working on every existing deploy with zero new required config, matching
 *     the AUDIT_ADMIN_DATABASE_URL opt-in posture of issue #915.
 *
 * The signed message is the CANONICAL anchor payload (canonicalAnchorPayload):
 * a deterministic, key-sorted JSON of the fields that define the snapshot. The
 * same canonicalization is used by the off-box verifier, so any later mutation
 * of a retained anchor breaks signature verification.
 *
 * Trust posture (same caveat as manifestSigning, #625): a per-deployment key
 * defends against DB-only compromise (the attacker who can rewrite the chain in
 * Postgres still cannot forge a valid signature without the seed, which is held
 * in env, not the DB). It does NOT defend against full host compromise. True
 * external retention to a separate trust domain (S3 Object Lock / SIEM) is the
 * deferred phase-2 follow-up tracked on #916.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createHash } from 'node:crypto';

const RAW_KEY_LEN = 32;
// PKCS8 DER prefix for an Ed25519 private key: wraps a raw 32-byte seed into a
// Node-importable form. (Same constant as manifestSigning.ts.)
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface AnchorPayload {
  /** NULL for the system chain. */
  orgId: string | null;
  /** audit_log_chain.chain_seq of the head at snapshot time (0 = empty chain). */
  headChainSeq: number;
  /** Head chain_checksum; null when the chain is empty. */
  headChainChecksum: string | null;
  /** Number of audit_log_chain entries for this org at snapshot time. */
  entryCount: number;
  /** ISO timestamp the anchor is stamped with (app-supplied so it is signable). */
  anchoredAt: string;
}

/**
 * Deterministic, explicit-order serialization of an anchor payload. The signed
 * message and the basis for the off-box verifier — DO NOT change the field set
 * or ordering without bumping `v`, or previously-signed anchors stop verifying.
 *
 * The DB surrogate `anchor_seq` is deliberately NOT part of the signed payload:
 * it is a bigserial assigned by the INSERT (not knowable at sign time) and
 * carries no integrity meaning beyond ordering. The snapshot's integrity is
 * fully captured by (orgId, headChainSeq, headChainChecksum, entryCount,
 * anchoredAt).
 */
export function canonicalAnchorPayload(p: AnchorPayload): string {
  // Explicit field order (not JSON.stringify of an object literal) so the
  // canonical form is stable regardless of construction order.
  return JSON.stringify({
    v: 1,
    orgId: p.orgId,
    headChainSeq: p.headChainSeq,
    headChainChecksum: p.headChainChecksum,
    entryCount: p.entryCount,
    anchoredAt: p.anchoredAt,
  });
}

/** SHA-256 of the canonical payload — a compact anchor fingerprint for logs. */
export function anchorDigest(p: AnchorPayload): string {
  return createHash('sha256').update(canonicalAnchorPayload(p), 'utf8').digest('hex');
}

function loadSeedB64(): string | null {
  const raw = process.env.AUDIT_ANCHOR_SIGNING_KEY;
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

/** True when an anchor signing key is configured. */
export function isAnchorSigningEnabled(): boolean {
  return loadSeedB64() !== null;
}

function privateKeyFromSeed(seedB64: string) {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== RAW_KEY_LEN) {
    throw new Error('AUDIT_ANCHOR_SIGNING_KEY must be a base64 32-byte Ed25519 seed');
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * A short, stable identifier for the configured signing key (NOT the secret).
 * Derived as the first 16 hex of SHA-256 over the public SPKI, so it changes
 * iff the key changes and is safe to log / store in signing_key_id. Returns
 * null when signing is disabled.
 */
export function getAnchorSigningKeyId(): string | null {
  const seedB64 = loadSeedB64();
  if (!seedB64) return null;
  try {
    const priv = privateKeyFromSeed(seedB64);
    const pub = createPublicKey(priv);
    const spki = pub.export({ format: 'der', type: 'spki' }) as Buffer;
    return 'anchor-' + createHash('sha256').update(spki).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * The Ed25519 public key (base64 SPKI DER) matching the configured signing
 * key, for off-box verification and ops display. Null when signing disabled.
 */
export function getAnchorSigningPublicKey(): string | null {
  const seedB64 = loadSeedB64();
  if (!seedB64) return null;
  try {
    const priv = privateKeyFromSeed(seedB64);
    const pub = createPublicKey(priv);
    return (pub.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Sign an anchor payload. Returns the base64 Ed25519 signature, or null when
 * signing is disabled (anchors are still written unsigned — the in-DB
 * append-only guarantee does not depend on the signature). Throws only on a
 * malformed configured key, so a broken key is loud rather than silently
 * dropping signatures.
 */
export function signAnchorPayload(p: AnchorPayload): string | null {
  const seedB64 = loadSeedB64();
  if (!seedB64) return null;
  const key = privateKeyFromSeed(seedB64);
  const msg = Buffer.from(canonicalAnchorPayload(p), 'utf8');
  return sign(null, msg, key).toString('base64');
}
