import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeCBOR, encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import { verifyAppAttestAttestation } from './appleAppAttest';
import { APPLE_APP_ATTEST_ROOT_CA_PEM } from './appleAppAttestRootCA';
import {
  AAGUID_DEVELOPMENT,
  AAGUID_PRODUCTION,
  mintAppAttestFixture,
  uncompressedEcPoint,
} from './__fixtures__/appAttestFixture';

/**
 * Every negative test here mutates EXACTLY ONE field of an otherwise-valid
 * fixture. That is what makes a green negative test evidence that the verifier
 * rejected *that* mutation, rather than tripping over something incidental —
 * a verifier that skips one of Apple's nine checks still passes the other eight
 * tests, so each check gets its own single-field control.
 */

const APP_ID = 'D8W6N2JYMA.com.breeze.rmm';

describe('verifyAppAttestAttestation', () => {
  it('accepts a valid production attestation and returns the attested public key', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    const r = verifyAppAttestAttestation({
      attestationObjectB64: f.attestationObjectB64,
      keyIdB64: f.keyIdB64,
      clientDataHash: f.clientDataHash,
      appId: APP_ID,
      environment: 'production',
      rootCertificatesPem: [f.rootPem],
    });
    expect(r.attestedPublicKeyDer.equals(f.attestedPublicKeyDer)).toBe(true);
    expect(r.receiptB64).toBe(f.receiptB64);
  });

  it('accepts a development attestation when environment is development', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, aaguid: AAGUID_DEVELOPMENT });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'development',
        rootCertificatesPem: [f.rootPem],
      }),
    ).not.toThrow();
  });

  // Check 2 — chain must terminate at a PINNED root.
  it('rejects a chain that does not terminate at a trusted root', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        // The REAL Apple root — a synthetic chain must not validate against it.
        rootCertificatesPem: [APPLE_APP_ATTEST_ROOT_CA_PEM],
      }),
    ).toThrow(/attestation/i);
  });

  it('defaults to the pinned Apple root when no roots are supplied', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
      }),
    ).toThrow(/attestation/i);
  });

  // Check 3 — the nonce commits to the caller-supplied transcript.
  it('rejects when clientDataHash differs from the one in the nonce (transcript substitution)', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: crypto.randomBytes(32),
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Check 4 — the nonce extension itself.
  it('rejects a tampered nonce extension', async () => {
    const f = await mintAppAttestFixture({
      appId: APP_ID,
      nonceExtension: crypto.randomBytes(32),
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Check 5 — keyId is SHA256 of the credCert public key.
  it('rejects when keyId does not match SHA256 of the credCert public key', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, keyId: crypto.randomBytes(32) });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects a keyId the caller supplied that differs from the attested one', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: crypto.randomBytes(32).toString('base64'),
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Check 6 — rpIdHash binds the app.
  it('rejects a mismatched appId (rpIdHash)', async () => {
    const f = await mintAppAttestFixture({ appId: 'OTHER00000.com.evil.app' });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Check 7 — a fresh attestation always has signCount 0.
  it('rejects signCount != 0 (a re-attested key)', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, signCount: 1 });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Check 8 — aaguid must match the configured environment.
  it('rejects a development aaguid when environment is production', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, aaguid: AAGUID_DEVELOPMENT });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects a production aaguid when environment is development', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, aaguid: AAGUID_PRODUCTION });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'development',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects an unrecognized aaguid entirely', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, aaguid: crypto.randomBytes(16) });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Check 9 — authData.credentialId must be the keyId.
  it('rejects when authData.credentialId is not the keyId', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, credentialId: crypto.randomBytes(32) });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // Chain validity windows.
  it('rejects an expired credCert', async () => {
    const f = await mintAppAttestFixture({
      appId: APP_ID,
      notAfter: new Date(Date.now() - 60_000),
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
        now: new Date(),
      }),
    ).toThrow(/attestation/i);
  });

  it('accepts a credCert that is expired NOW but valid at the supplied `now`', async () => {
    const notAfter = new Date(Date.now() - 60_000);
    const f = await mintAppAttestFixture({ appId: APP_ID, notAfter });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
        now: new Date(notAfter.getTime() - 60_000),
      }),
    ).not.toThrow();
  });

  // Check 1 — the attestation format itself.
  it('rejects a non-apple-appattest fmt', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, fmt: 'packed' });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects an attStmt with no receipt', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID, omitReceipt: true });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  // The `rootCertificatesPem` array is the seam a future multi-root rotation
  // would use, so its failure modes are worth pinning now rather than after
  // someone points it at config.
  it('rejects an unparseable trust anchor rather than falling through to "untrusted"', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: ['-----BEGIN CERTIFICATE-----\nnot-a-cert\n-----END CERTIFICATE-----'],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects an empty trust-anchor list rather than trusting everything', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [],
      }),
    ).toThrow(/attestation/i);
  });

  it('accepts the correct root when several anchors are configured', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: f.attestationObjectB64,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        // Rotation shape: one stale anchor alongside the live one.
        rootCertificatesPem: [APPLE_APP_ATTEST_ROOT_CA_PEM, f.rootPem],
      }),
    ).not.toThrow();
  });

  it('rejects an x5c longer than a real Apple chain', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    const chain = (
      decodeAttestation(f.attestationObjectB64).get('attStmt') as Map<string, unknown>
    ).get('x5c') as Uint8Array[];
    const tampered = tamperAttestation(f.attestationObjectB64, (obj) => {
      const attStmt = obj.get('attStmt') as Map<string, unknown>;
      attStmt.set('x5c', [chain[0], chain[1], chain[1], chain[1], chain[1]]);
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: tampered,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects malformed CBOR without throwing an unhandled error type', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: 'bm90LWNib3I=',
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects an empty x5c chain', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    // Re-encode the fixture with x5c emptied — every other field untouched.
    const tampered = tamperAttestation(f.attestationObjectB64, (obj) => {
      const attStmt = obj.get('attStmt') as Map<string, unknown>;
      attStmt.set('x5c', []);
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: tampered,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects a truncated authData', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    const tampered = tamperAttestation(f.attestationObjectB64, (obj) => {
      const authData = obj.get('authData') as Uint8Array;
      obj.set('authData', authData.slice(0, 40));
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: tampered,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects an x5c whose only element IS the pinned root (self-anchoring)', () => {
    // A one-element chain [pinnedRoot] satisfies the anchoring loop by
    // construction — the root is self-signed, so it "verifies against itself"
    // and its subject matches its own issuer. Nothing downstream may treat that
    // as an attestation. Hand-built rather than fixture-derived precisely
    // because the fixture cannot express it.
    const rootDer = new crypto.X509Certificate(APPLE_APP_ATTEST_ROOT_CA_PEM).raw;
    const authData = Buffer.concat([
      crypto.createHash('sha256').update(APP_ID, 'utf8').digest(),
      Buffer.from([0x40]),
      Buffer.alloc(4),
      Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7, 0)]),
      Buffer.from([0x00, 0x20]),
      Buffer.alloc(32, 7),
    ]);
    const attestationObject = encodeCBOR(
      new Map<string | number, CBORType>([
        ['fmt', 'apple-appattest'],
        [
          'attStmt',
          new Map<string | number, CBORType>([
            ['x5c', [new Uint8Array(rootDer)]],
            ['receipt', new Uint8Array(8)],
          ]),
        ],
        ['authData', new Uint8Array(authData)],
      ]),
    );
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: Buffer.from(attestationObject).toString('base64'),
        keyIdB64: Buffer.alloc(32, 7).toString('base64'),
        clientDataHash: Buffer.alloc(32),
        appId: APP_ID,
        environment: 'production',
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects an x5c that repeats the credCert as its own issuer', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    const tampered = tamperAttestation(f.attestationObjectB64, (obj) => {
      const attStmt = obj.get('attStmt') as Map<string, unknown>;
      const chain = attStmt.get('x5c') as Uint8Array[];
      attStmt.set('x5c', [chain[0], chain[0]]);
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: tampered,
        keyIdB64: f.keyIdB64,
        clientDataHash: f.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [f.rootPem],
      }),
    ).toThrow(/attestation/i);
  });

  it('rejects a credCert re-signed by an untrusted intermediate spliced into the chain', async () => {
    // Two independent fixtures: take fixture A's credCert but fixture B's
    // intermediate. The chain no longer links, and it must not validate.
    const a = await mintAppAttestFixture({ appId: APP_ID });
    const b = await mintAppAttestFixture({ appId: APP_ID });
    const bChain = decodeAttestation(b.attestationObjectB64).get('attStmt') as Map<string, unknown>;
    const bIntermediate = (bChain.get('x5c') as Uint8Array[])[1];
    const tampered = tamperAttestation(a.attestationObjectB64, (obj) => {
      const attStmt = obj.get('attStmt') as Map<string, unknown>;
      const chain = attStmt.get('x5c') as Uint8Array[];
      attStmt.set('x5c', [chain[0], bIntermediate]);
    });
    expect(() =>
      verifyAppAttestAttestation({
        attestationObjectB64: tampered,
        keyIdB64: a.keyIdB64,
        clientDataHash: a.clientDataHash,
        appId: APP_ID,
        environment: 'production',
        rootCertificatesPem: [a.rootPem],
      }),
    ).toThrow(/attestation/i);
  });
});

describe('the pinned Apple App Attestation Root CA', () => {
  it('is byte-identical to the committed .pem', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const onDisk = readFileSync(path.join(here, 'appleAppAttestRootCA.pem'), 'utf8');
    // The .ts constant is what ships (tsup bundles to dist/index.cjs and the
    // Dockerfiles copy no .pem), the .pem is the auditable provenance artifact.
    // They must never drift.
    expect(APPLE_APP_ATTEST_ROOT_CA_PEM.trim()).toBe(onDisk.trim());
  });

  it('is the certificate Apple publishes (SHA-256 fingerprint pinned)', () => {
    const cert = new crypto.X509Certificate(APPLE_APP_ATTEST_ROOT_CA_PEM);
    expect(cert.subject.replace(/\n/g, ', ')).toBe(
      'CN=Apple App Attestation Root CA, O=Apple Inc., ST=California',
    );
    expect(cert.fingerprint256.replace(/:/g, '').toLowerCase()).toBe(
      '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932',
    );
    expect(cert.ca).toBe(true);
  });
});

describe('fixture self-check', () => {
  it('derives keyId as SHA256 of the uncompressed credCert point', async () => {
    const f = await mintAppAttestFixture({ appId: APP_ID });
    const expected = crypto
      .createHash('sha256')
      .update(uncompressedEcPoint(f.attestedPublicKeyDer))
      .digest('base64');
    expect(f.keyIdB64).toBe(expected);
  });
});

// --- test-local CBOR helpers (kept here, not in the fixture, because they
// exist to BREAK a fixture rather than to build one) ---

function decodeAttestation(b64: string): Map<string, unknown> {
  return decodeCBOR(new Uint8Array(Buffer.from(b64, 'base64'))) as Map<string, unknown>;
}

function tamperAttestation(b64: string, mutate: (obj: Map<string, unknown>) => void): string {
  const obj = decodeAttestation(b64);
  mutate(obj);
  return Buffer.from(encodeCBOR(obj as unknown as CBORType)).toString('base64');
}
