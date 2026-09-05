import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecurityLevel, VerifiedBootState } from '@peculiar/asn1-android';
import { describe, expect, it } from 'vitest';
import { verifyAndroidKeyAttestation } from './androidKeyAttestation';
import {
  mintAndroidKeyAttestationFixture,
  type AndroidKeyAttestationFixture,
  type AndroidKeyAttestationFixtureOverrides,
} from './__fixtures__/androidKeyAttestationFixture';

const PACKAGE = 'com.breeze.rmm';
/** KeyMint `KeyOrigin::IMPORTED`. */
const KEY_ORIGIN_IMPORTED = 2;

function verifyArgs(fixture: AndroidKeyAttestationFixture) {
  return {
    certificateChainDerB64: fixture.certificateChainDerB64,
    expectedChallenge: fixture.challenge,
    expectedPackageName: PACKAGE,
    rootCertificatesPem: [fixture.rootPem],
  };
}

/** Mint a fixture and immediately return the verifier arguments for it. */
async function mint(overrides: AndroidKeyAttestationFixtureOverrides = {}) {
  const fixture = await mintAndroidKeyAttestationFixture(overrides);
  return { fixture, args: verifyArgs(fixture) };
}

describe('verifyAndroidKeyAttestation (#1374 W04)', () => {
  it('accepts a well-formed TEE-backed chain and reports what it proved', async () => {
    const { fixture, args } = await mint();
    const result = verifyAndroidKeyAttestation(args);

    expect(result.keyMintSecurityLevel).toBe('TrustedEnvironment');
    expect(result.attestationSecurityLevel).toBe('TrustedEnvironment');
    expect(result.verifiedBootState).toBe('Verified');
    expect(result.deviceLocked).toBe(true);
    expect(result.packageName).toBe(PACKAGE);
    expect(result.leafSerial).toBe(fixture.leafSerial);
    // Check 9: the caller binds this against the SPKI actually being registered.
    expect(result.attestedPublicKeyDer.equals(fixture.attestedPublicKeyDer)).toBe(true);
  });

  it('reports StrongBox distinctly from TrustedEnvironment', async () => {
    const { args } = await mint({
      keyMintSecurityLevel: SecurityLevel.strongBox,
      attestationSecurityLevel: SecurityLevel.strongBox,
    });
    expect(verifyAndroidKeyAttestation(args).keyMintSecurityLevel).toBe('StrongBox');
  });

  // Check 1 — chain
  it('rejects a chain that does not terminate in a pinned root', async () => {
    const { args } = await mint();
    const foreign = await mintAndroidKeyAttestationFixture();
    expect(() =>
      verifyAndroidKeyAttestation({ ...args, rootCertificatesPem: [foreign.rootPem] }),
    ).toThrow(/root/i);
  });

  it('rejects a chain whose leaf signature does not verify against its issuer', async () => {
    const { args } = await mint({ breakChainSignature: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/signature/i);
  });

  it('rejects an expired leaf certificate', async () => {
    const { args } = await mint();
    const wayLater = new Date(Date.now() + 400 * 24 * 3600 * 1000);
    expect(() => verifyAndroidKeyAttestation({ ...args, now: wayLater })).toThrow(/valid/i);
  });

  it('rejects a chain with fewer than two certificates', async () => {
    const { args } = await mint();
    expect(() =>
      verifyAndroidKeyAttestation({
        ...args,
        certificateChainDerB64: [args.certificateChainDerB64[0]!],
      }),
    ).toThrow(/chain/i);
  });

  // Check 2 — the KeyDescription extension
  it('rejects a leaf with no KeyDescription extension', async () => {
    const { args } = await mint({ omitKeyDescriptionExtension: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/key ?description|1\.3\.6\.1\.4\.1/i);
  });

  // Check 3 — challenge binding
  it('rejects a challenge that is not the transcript (replay of another attestation)', async () => {
    const { args } = await mint();
    expect(() =>
      verifyAndroidKeyAttestation({ ...args, expectedChallenge: crypto.randomBytes(32) }),
    ).toThrow(/challenge/i);
  });

  it('rejects a challenge that is a prefix of the attested one', async () => {
    const challenge = crypto.randomBytes(32);
    const { args } = await mint({ challenge });
    expect(() =>
      verifyAndroidKeyAttestation({ ...args, expectedChallenge: challenge.subarray(0, 16) }),
    ).toThrow(/challenge/i);
  });

  // Check 4 — THE point of the wave
  it('rejects keyMintSecurityLevel Software — this is the whole point of the wave', async () => {
    const { args } = await mint({ keyMintSecurityLevel: SecurityLevel.software });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/security level/i);
  });

  // Check 5
  it('rejects attestationSecurityLevel Software even when the key itself claims TEE', async () => {
    const { args } = await mint({
      keyMintSecurityLevel: SecurityLevel.trustedEnvironment,
      attestationSecurityLevel: SecurityLevel.software,
    });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/security level/i);
  });

  // Check 6 — root of trust
  it('rejects an unlocked bootloader', async () => {
    const { args } = await mint({ deviceLocked: false });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/bootloader|deviceLocked|locked/i);
  });

  it('rejects verifiedBootState other than Verified', async () => {
    const { args } = await mint({ verifiedBootState: VerifiedBootState.unverified });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/boot/i);
  });

  it('rejects a teeEnforced list with no rootOfTrust at all', async () => {
    const { args } = await mint({ omitRootOfTrust: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/root of trust/i);
  });

  // Check 7 — package binding
  it('rejects a foreign package name', async () => {
    const { args } = await mint({ packageName: 'com.evil.app' });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/package/i);
  });

  it('rejects an attestation carrying no attestationApplicationId', async () => {
    const { args } = await mint({ omitAttestationApplicationId: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/package|application id/i);
  });

  it('accepts an attestationApplicationId asserted in teeEnforced', async () => {
    const { args } = await mint({ attestationApplicationIdInTeeEnforced: true });
    expect(verifyAndroidKeyAttestation(args).packageName).toBe(PACKAGE);
  });

  // Check 8 — hardware-enforced properties
  it('rejects properties asserted only in softwareEnforced', async () => {
    const { args } = await mint({ putPurposeInSoftwareEnforced: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/hardware-enforced|softwareEnforced/i);
  });

  it('rejects a key marked usable by all applications', async () => {
    const { args } = await mint({ allApplications: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/all ?applications/i);
  });

  it('rejects an IMPORTED key — the private key existed outside secure hardware', async () => {
    const { args } = await mint({ origin: KEY_ORIGIN_IMPORTED });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/generated|imported|origin/i);
  });

  it('rejects a key that does not require user authentication', async () => {
    const { args } = await mint({ noAuthRequired: true });
    expect(() => verifyAndroidKeyAttestation(args)).toThrow(/user authentication/i);
  });

  // The shipped trust anchors must actually load and must actually be used.
  it('pins self-signed Google hardware attestation roots', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pem = readFileSync(path.join(here, 'googleHardwareAttestationRoots.pem'), 'utf8');
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    expect(certs.length).toBeGreaterThanOrEqual(4);
    for (const c of certs) {
      const parsed = new crypto.X509Certificate(c);
      // Every pinned anchor must be self-signed: an anchor that is not its own
      // issuer would silently need a parent we do not have.
      expect(parsed.verify(parsed.publicKey)).toBe(true);
    }
  });

  it('defaults to the pinned Google roots, so a self-minted chain is refused', async () => {
    const { args } = await mint();
    const { rootCertificatesPem: _dropped, ...withoutOverride } = args;
    expect(() => verifyAndroidKeyAttestation(withoutOverride)).toThrow(/root/i);
  });
});
