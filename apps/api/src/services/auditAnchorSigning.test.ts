/**
 * Unit tests for the audit-anchor Ed25519 signing seam (issue #916).
 *
 * Pure crypto + env behavior — no DB. Verifies:
 *   - canonical payload is deterministic and order-independent
 *   - signing is disabled (returns null) when no key is configured
 *   - a configured key produces a signature that verifies under the matching
 *     public key, and FAILS verification under a tampered payload
 *   - a malformed key throws loudly rather than silently dropping the signature
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateKeyPairSync,
  createPublicKey,
  verify,
} from 'node:crypto';
import {
  type AnchorPayload,
  canonicalAnchorPayload,
  anchorDigest,
  signAnchorPayload,
  isAnchorSigningEnabled,
  getAnchorSigningKeyId,
  getAnchorSigningPublicKey,
} from './auditAnchorSigning';

const RAW_KEY_LEN = 32;

function freshSeedB64(): { seedB64: string; spkiB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    seedB64: pkcs8.subarray(pkcs8.length - RAW_KEY_LEN).toString('base64'),
    spkiB64: spki.toString('base64'),
  };
}

const samplePayload: AnchorPayload = {
  orgId: '11111111-1111-1111-1111-111111111111',
  headChainSeq: 42,
  headChainChecksum: 'abc123',
  entryCount: 42,
  anchoredAt: '2026-06-13T04:45:00.000Z',
};

const ORIGINAL_KEY = process.env.AUDIT_ANCHOR_SIGNING_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
  } else {
    process.env.AUDIT_ANCHOR_SIGNING_KEY = ORIGINAL_KEY;
  }
});

describe('canonicalAnchorPayload', () => {
  it('is deterministic regardless of object construction order', () => {
    const a: AnchorPayload = {
      anchoredAt: '2026-06-13T04:45:00.000Z',
      entryCount: 42,
      headChainChecksum: 'abc123',
      headChainSeq: 42,
      orgId: '11111111-1111-1111-1111-111111111111',
    };
    expect(canonicalAnchorPayload(a)).toBe(canonicalAnchorPayload(samplePayload));
  });

  it('changes when any field changes', () => {
    const base = canonicalAnchorPayload(samplePayload);
    expect(canonicalAnchorPayload({ ...samplePayload, headChainSeq: 43 })).not.toBe(base);
    expect(canonicalAnchorPayload({ ...samplePayload, entryCount: 41 })).not.toBe(base);
    expect(canonicalAnchorPayload({ ...samplePayload, headChainChecksum: 'def456' })).not.toBe(base);
    expect(canonicalAnchorPayload({ ...samplePayload, orgId: null })).not.toBe(base);
  });

  it('embeds a version tag for forward compatibility', () => {
    expect(canonicalAnchorPayload(samplePayload)).toContain('"v":1');
  });

  it('anchorDigest is a stable sha256 hex of the canonical payload', () => {
    const d1 = anchorDigest(samplePayload);
    const d2 = anchorDigest({ ...samplePayload });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signing disabled (no key)', () => {
  it('isAnchorSigningEnabled is false and signing returns null', () => {
    delete process.env.AUDIT_ANCHOR_SIGNING_KEY;
    expect(isAnchorSigningEnabled()).toBe(false);
    expect(signAnchorPayload(samplePayload)).toBeNull();
    expect(getAnchorSigningKeyId()).toBeNull();
    expect(getAnchorSigningPublicKey()).toBeNull();
  });

  it('treats empty/whitespace key as disabled', () => {
    process.env.AUDIT_ANCHOR_SIGNING_KEY = '   ';
    expect(isAnchorSigningEnabled()).toBe(false);
    expect(signAnchorPayload(samplePayload)).toBeNull();
  });
});

describe('signing enabled', () => {
  it('produces a signature that verifies under the matching public key', () => {
    const { seedB64, spkiB64 } = freshSeedB64();
    process.env.AUDIT_ANCHOR_SIGNING_KEY = seedB64;

    expect(isAnchorSigningEnabled()).toBe(true);
    const sig = signAnchorPayload(samplePayload);
    expect(sig).toBeTruthy();

    // getAnchorSigningPublicKey must equal the real public key for off-box verify.
    expect(getAnchorSigningPublicKey()).toBe(spkiB64);

    const pubKey = createPublicKey({
      key: Buffer.from(spkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = verify(
      null,
      Buffer.from(canonicalAnchorPayload(samplePayload), 'utf8'),
      pubKey,
      Buffer.from(sig as string, 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('signature FAILS verification against a tampered payload', () => {
    const { seedB64, spkiB64 } = freshSeedB64();
    process.env.AUDIT_ANCHOR_SIGNING_KEY = seedB64;
    const sig = signAnchorPayload(samplePayload) as string;

    const pubKey = createPublicKey({
      key: Buffer.from(spkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    // Forge a shrunk chain: fewer entries, lower head.
    const tampered = canonicalAnchorPayload({
      ...samplePayload,
      headChainSeq: 10,
      entryCount: 10,
    });
    const ok = verify(null, Buffer.from(tampered, 'utf8'), pubKey, Buffer.from(sig, 'base64'));
    expect(ok).toBe(false);
  });

  it('key id is stable and derived from the public key, not the secret', () => {
    const { seedB64 } = freshSeedB64();
    process.env.AUDIT_ANCHOR_SIGNING_KEY = seedB64;
    const id1 = getAnchorSigningKeyId();
    const id2 = getAnchorSigningKeyId();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^anchor-[0-9a-f]{16}$/);

    // A different key yields a different id.
    const { seedB64: otherSeed } = freshSeedB64();
    process.env.AUDIT_ANCHOR_SIGNING_KEY = otherSeed;
    expect(getAnchorSigningKeyId()).not.toBe(id1);
  });

  it('throws on a malformed key seed rather than silently dropping the signature', () => {
    process.env.AUDIT_ANCHOR_SIGNING_KEY = Buffer.from('too-short').toString('base64');
    expect(() => signAnchorPayload(samplePayload)).toThrow(/Ed25519 seed/);
  });
});
