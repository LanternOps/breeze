import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

// Round-trip test: prove signManifest's signing format and
// verifyEd25519ManifestSignature's verification format agree on the wire.
// The two halves use different code paths (sign() with PKCS8 vs createPublicKey
// with SPKI) and historically diverged at least twice in PR #635 review (raw
// vs base64 of the signature, raw 32-byte vs full SPKI public key). We can't
// drive signManifest() without spinning up the manifest_signing_keys table,
// so we mirror its internals here with crypto primitives and verify that the
// real verifier exposed by verifyEd25519ManifestSignature accepts the output.
//
// This is intentionally unmocked: no DB, no in-memory DB stubs. The test
// passes only if Node's Ed25519 + the verifier's SPKI assembly + the
// base64 decode all agree at the byte level. (#639)

// Mock manifestSigning so getActivePublicKeys returns our test pubkey list
// in raw base64 form (what getUpdateManifestPublicKeys decodes inside the
// verifier).
const mockedPubKeys: string[] = [];
vi.mock('./manifestSigning', () => ({
  getActivePublicKeys: vi.fn(async () => mockedPubKeys),
  getActiveTrustKeyset: vi.fn(async () => []),
  ensureActiveSigningKey: vi.fn(),
  signManifest: vi.fn(),
}));

// Mock db so the agentVersions module can import without a live connection.
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => vi.fn(async (_c: any, next: any) => next()),
  requirePermission: () => vi.fn(async (_c: any, next: any) => next()),
  requireMfa: () => vi.fn(async (_c: any, next: any) => next()),
}));

import { verifyEd25519ManifestSignature } from '../routes/agentVersions';

describe('signManifest <-> verifyEd25519ManifestSignature wire-format agreement (#639)', () => {
  beforeEach(() => {
    mockedPubKeys.length = 0;
    delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS;
  });

  it('signs a manifest with a fresh Ed25519 key and verifies via the real verifier', async () => {
    // Step 1: generate a real Ed25519 keypair (mirroring what
    // ensureActiveSigningKey does internally).
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    // Real ensureActiveSigningKey strips the SPKI prefix to get the raw
    // 32-byte pubkey and stores that base64-encoded — match its format.
    const rawPubKeyB64 = spki.subarray(spki.length - 32).toString('base64');
    mockedPubKeys.push(rawPubKeyB64);

    // Step 2: build a manifest and sign it. signManifest's internals: it
    // calls Node's sign() with algorithm=null (Ed25519 ignores the algo
    // argument) and base64-encodes the result.
    const manifest = JSON.stringify({
      version: '0.65.10',
      component: 'agent',
      platform: 'linux',
      arch: 'amd64',
      url: 'https://example.test/agent',
      checksum: 'a'.repeat(64),
      size: 1234,
    });
    const signatureB64 = sign(null, Buffer.from(manifest, 'utf8'), privateKey).toString(
      'base64',
    );

    // Step 3: verify using the production verifier (NOT mocked). If sign
    // and verify disagree on any of:
    //   - raw 32-byte vs SPKI-wrapped pubkey format
    //   - base64 vs raw bytes for the signature
    //   - PKCS8 vs SPKI key handle types
    // ...this returns false. A pass proves the two halves agree.
    const ok = await verifyEd25519ManifestSignature(manifest, signatureB64);
    expect(ok).toBe(true);
  });

  it('rejects a signature when the manifest body is tampered after signing', async () => {
    // Defense-in-depth: the wire format also has to fail closed when the
    // bytes don't actually validate. If sign+verify happened to be a
    // tautology (e.g. both no-op'd), this catches it.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const rawPubKeyB64 = spki.subarray(spki.length - 32).toString('base64');
    mockedPubKeys.push(rawPubKeyB64);

    const original = JSON.stringify({
      version: '0.65.10',
      component: 'agent',
      platform: 'linux',
      arch: 'amd64',
      url: 'https://example.test/agent',
      checksum: 'a'.repeat(64),
      size: 1234,
    });
    const signatureB64 = sign(null, Buffer.from(original, 'utf8'), privateKey).toString(
      'base64',
    );

    const tampered = original.replace('"size":1234', '"size":99999');
    const ok = await verifyEd25519ManifestSignature(tampered, signatureB64);
    expect(ok).toBe(false);
  });
});
