import crypto from 'node:crypto';
import {
  AttestationApplicationId,
  AttestationPackageInfo,
  AuthorizationList,
  id_ce_keyDescription,
  IntegerSet,
  KeyDescription,
  RootOfTrust,
  SecurityLevel,
  VerifiedBootState,
} from '@peculiar/asn1-android';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/x509';

/**
 * Synthetic Android Key Attestation chains for `androidKeyAttestation.test.ts`.
 *
 * WHY SYNTHETIC: a real KeyStore chain cannot be minted in CI (it needs a
 * physical TEE/StrongBox), and a captured one is a fixed blob — you cannot flip
 * `keyMintSecurityLevel` to `Software` in a real chain to prove the verifier
 * rejects it. So the fixture mints its OWN root and passes it in as the trust
 * anchor, which lets every check be exercised by mutating exactly one field.
 *
 * The cost is that these fixtures prove the verifier's LOGIC, not that the
 * pinned Google roots in `googleHardwareAttestationRoots.pem` parse and anchor.
 * A separate test covers that by loading the shipped PEM directly.
 */

x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);

/** Attestation `purpose` tag value (KeyMint `KeyPurpose`). 2 = SIGN. */
const KEY_PURPOSE_SIGN = 2;
/** Attestation `digest` tag value (KeyMint `Digest`). 4 = SHA-2-256. */
const DIGEST_SHA_2_256 = 4;
/** Attestation `origin` tag value (KeyMint `KeyOrigin`). 0 = GENERATED. */
const KEY_ORIGIN_GENERATED = 0;

const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const GEN_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface AndroidKeyAttestationFixture {
  /** Leaf first, root last — the shape `KeyStore.getCertificateChain()` returns. */
  certificateChainDerB64: string[];
  /** The synthetic root, to be passed as the verifier's trust anchor. */
  rootPem: string;
  /** SPKI DER of the attested (leaf) key. */
  attestedPublicKeyDer: Buffer;
  /** base64 SPKI of the attested key, for `publicKeySpkiB64` call sites. */
  attestedPublicKeyB64: string;
  /** The challenge actually embedded in the KeyDescription. */
  challenge: Buffer;
  /** Uppercase hex serial of the leaf, as `X509Certificate.serialNumber` reports it. */
  leafSerial: string;
}

export interface AndroidKeyAttestationFixtureOverrides {
  challenge?: Buffer;
  keyMintSecurityLevel?: SecurityLevel;
  attestationSecurityLevel?: SecurityLevel;
  verifiedBootState?: VerifiedBootState;
  deviceLocked?: boolean;
  packageName?: string;
  /** Leaf `notAfter`. Defaults to one year out. */
  notAfter?: Date;
  /** Move `purpose`/`digest`/`origin` out of teeEnforced into softwareEnforced. */
  putPurposeInSoftwareEnforced?: boolean;
  /**
   * Declare `purpose`/`digest` in BOTH lists. Distinct from the override above:
   * that one trips the "absent from teeEnforced" check, this one is the only
   * way to reach the "also present in softwareEnforced" check.
   */
  duplicatePurposeInSoftwareEnforced?: boolean;
  /** Extra KeyMint `purpose` values alongside SIGN (7 = ATTEST_KEY). */
  extraPurposes?: number[];
  /** Drop the RootOfTrust from teeEnforced entirely. */
  omitRootOfTrust?: boolean;
  /** Drop the AttestationApplicationId from both lists. */
  omitAttestationApplicationId?: boolean;
  /**
   * Put the AttestationApplicationId in softwareEnforced — which is where real
   * KeyMint implementations put it, since Keystore (not the TEE) is what knows
   * the calling package. The default here mirrors that reality; set this false
   * by passing `attestationApplicationIdInTeeEnforced` to test the other shape.
   */
  attestationApplicationIdInTeeEnforced?: boolean;
  /** Omit the KeyDescription extension from the leaf entirely. */
  omitKeyDescriptionExtension?: boolean;
  /** Sign the leaf with a key that is NOT the intermediate's — a broken chain. */
  breakChainSignature?: boolean;
  /** Set `allApplications` [600] on teeEnforced (key shared across apps). */
  allApplications?: boolean;
  /** KeyMint `KeyOrigin`. Defaults to 0 (GENERATED). */
  origin?: number;
  /** Set `noAuthRequired` [503] — a key usable without a biometric prompt. */
  noAuthRequired?: boolean;
  /**
   * Model the leaf-signs-leaf escalation: emit a FOUR-cert chain whose first
   * entry is a forged leaf signed by the genuine (CA:FALSE) attestation leaf.
   * Every signature verifies and the chain still ends at the fixture root; only
   * basicConstraints rejects it.
   */
  forgedLeafSignedByLeaf?: boolean;
  /**
   * Mark the genuine attestation leaf CA:TRUE + keyCertSign. Models the case
   * the CA check cannot rule out — a KeyMint implementation whose leaf is
   * CA-shaped — so the extension-count defence can be tested on its own.
   */
  leafIsCa?: boolean;
  /** Give the intermediate a keyUsage that does not include keyCertSign. */
  intermediateKeyUsageOmitsCertSign?: boolean;
  /** Emit the intermediate with neither basicConstraints nor keyUsage. */
  intermediateOmitsBasicConstraints?: boolean;
}

function attestationApplicationId(packageName: string): OctetString {
  const appId = new AttestationApplicationId({
    packageInfos: [
      new AttestationPackageInfo({
        packageName: new OctetString(Buffer.from(packageName, 'utf8')),
        version: 1,
      }),
    ],
    signatureDigests: [new OctetString(crypto.randomBytes(32))],
  });
  return new OctetString(AsnConvert.serialize(appId));
}

function buildKeyDescription(
  o: AndroidKeyAttestationFixtureOverrides,
  challenge: Buffer,
): KeyDescription {
  const packageName = o.packageName ?? 'com.breeze.rmm';
  const hardwareProps = {
    purpose: new IntegerSet([KEY_PURPOSE_SIGN, ...(o.extraPurposes ?? [])]),
    digest: new IntegerSet([DIGEST_SHA_2_256]),
    origin: o.origin ?? KEY_ORIGIN_GENERATED,
    // A real approver key is minted with setUserAuthenticationRequired(true),
    // which shows up as the ABSENCE of noAuthRequired [503] plus a userAuthType.
    ...(o.noAuthRequired ? { noAuthRequired: null } : { userAuthType: 2 }),
  };
  const appIdInTee = o.attestationApplicationIdInTeeEnforced === true;

  const teeEnforced = new AuthorizationList({
    ...(o.putPurposeInSoftwareEnforced && !o.duplicatePurposeInSoftwareEnforced
      ? {}
      : hardwareProps),
    ...(o.allApplications ? { allApplications: null } : {}),
    ...(o.omitRootOfTrust
      ? {}
      : {
          rootOfTrust: new RootOfTrust({
            verifiedBootKey: new OctetString(crypto.randomBytes(32)),
            deviceLocked: o.deviceLocked ?? true,
            verifiedBootState: o.verifiedBootState ?? VerifiedBootState.verified,
            verifiedBootHash: new OctetString(crypto.randomBytes(32)),
          }),
        }),
    ...(!o.omitAttestationApplicationId && appIdInTee
      ? { attestationApplicationId: attestationApplicationId(packageName) }
      : {}),
  });

  const softwareEnforced = new AuthorizationList({
    creationDateTime: 1_700_000_000_000,
    ...(o.putPurposeInSoftwareEnforced || o.duplicatePurposeInSoftwareEnforced
      ? hardwareProps
      : {}),
    ...(!o.omitAttestationApplicationId && !appIdInTee
      ? { attestationApplicationId: attestationApplicationId(packageName) }
      : {}),
  });

  return new KeyDescription({
    attestationVersion: 300,
    attestationSecurityLevel: o.attestationSecurityLevel ?? SecurityLevel.trustedEnvironment,
    keymasterVersion: 300,
    keymasterSecurityLevel: o.keyMintSecurityLevel ?? SecurityLevel.trustedEnvironment,
    attestationChallenge: new OctetString(challenge),
    uniqueId: new OctetString(Buffer.alloc(0)),
    softwareEnforced,
    teeEnforced,
  });
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.webcrypto.subtle.generateKey(GEN_ALG, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

const toB64 = (cert: x509.X509Certificate) => Buffer.from(cert.rawData).toString('base64');

/**
 * Mint a three-cert chain (leaf → intermediate → self-signed root) whose leaf
 * carries a KeyDescription extension built from `overrides`.
 *
 * Async because `@peculiar/x509` signs through WebCrypto. The plan sketched a
 * synchronous signature; there is no synchronous X.509 generator available and
 * every caller is an async test, so the signature is the deviation, not the
 * behaviour.
 */
export async function mintAndroidKeyAttestationFixture(
  overrides: AndroidKeyAttestationFixtureOverrides = {},
): Promise<AndroidKeyAttestationFixture> {
  const challenge = overrides.challenge ?? crypto.randomBytes(32);
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const farFuture = new Date(now.getTime() + 365 * 24 * 3600 * 1000);

  const rootKeys = await generateKeyPair();
  const intermediateKeys = await generateKeyPair();
  const leafKeys = await generateKeyPair();
  const strayKeys = await generateKeyPair();

  // Real CAs carry keyCertSign; real KeyStore attestation leaves carry
  // digitalSignature and CA:FALSE. Both are load-bearing for path validation,
  // so the fixture models them faithfully rather than omitting the extension.
  const caKeyUsage = () =>
    new x509.KeyUsagesExtension(
      x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
      true,
    );
  const leafKeyUsage = () =>
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true);

  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Fixture Android Attestation Root',
    notBefore,
    notAfter: farFuture,
    signingAlgorithm: SIGN_ALG,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true), caKeyUsage()],
  });

  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=Fixture Android Attestation Intermediate',
    issuer: root.subject,
    notBefore,
    notAfter: farFuture,
    signingAlgorithm: SIGN_ALG,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: overrides.intermediateOmitsBasicConstraints
      ? []
      : [
          new x509.BasicConstraintsExtension(true, 1, true),
          overrides.intermediateKeyUsageOmitsCertSign ? leafKeyUsage() : caKeyUsage(),
        ],
  });

  const keyDescription = buildKeyDescription(overrides, challenge);
  const keyDescriptionExtension = () =>
    new x509.Extension(id_ce_keyDescription, false, AsnConvert.serialize(keyDescription));
  const leafExtensions: x509.Extension[] = overrides.leafIsCa
    ? [new x509.BasicConstraintsExtension(true, 0, true), caKeyUsage()]
    : [new x509.BasicConstraintsExtension(false, undefined, true), leafKeyUsage()];
  if (!overrides.omitKeyDescriptionExtension) leafExtensions.push(keyDescriptionExtension());

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '0a1b2c3d',
    subject: 'CN=Android Keystore Key',
    issuer: intermediate.subject,
    notBefore,
    notAfter: overrides.notAfter ?? farFuture,
    signingAlgorithm: SIGN_ALG,
    publicKey: leafKeys.publicKey,
    signingKey: overrides.breakChainSignature ? strayKeys.privateKey : intermediateKeys.privateKey,
    extensions: leafExtensions,
  });

  const attestedKeys = overrides.forgedLeafSignedByLeaf ? strayKeys : leafKeys;
  const chain = [toB64(leaf), toB64(intermediate), toB64(root)];

  if (overrides.forgedLeafSignedByLeaf) {
    // The genuine leaf's TEE key signs this. `strayKeys` stands in for the
    // attacker's software key: it is what the forged certificate attests, and
    // what a caller would then bind as the registered key.
    const forged = await x509.X509CertificateGenerator.create({
      serialNumber: 'deadbeef',
      subject: 'CN=Forged Keystore Key',
      issuer: leaf.subject,
      notBefore,
      notAfter: overrides.notAfter ?? farFuture,
      signingAlgorithm: SIGN_ALG,
      publicKey: strayKeys.publicKey,
      signingKey: leafKeys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        leafKeyUsage(),
        keyDescriptionExtension(),
      ],
    });
    chain.unshift(toB64(forged));
  }

  const attestedPublicKeyDer = Buffer.from(
    await crypto.webcrypto.subtle.exportKey('spki', attestedKeys.publicKey),
  );
  const leafCertB64 = chain[0]!;

  return {
    certificateChainDerB64: chain,
    rootPem: root.toString('pem'),
    attestedPublicKeyDer,
    attestedPublicKeyB64: attestedPublicKeyDer.toString('base64'),
    challenge,
    leafSerial: new crypto.X509Certificate(Buffer.from(leafCertB64, 'base64')).serialNumber,
  };
}
