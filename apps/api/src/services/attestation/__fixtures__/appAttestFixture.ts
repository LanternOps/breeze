import crypto from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';

/**
 * Mints a synthetic App Attest attestation object signed by a throwaway root,
 * so the verifier's checks are exercised end-to-end in CI. `rootCertificatesPem`
 * on the verifier input exists ONLY for this — production always uses the
 * pinned Apple root.
 *
 * This fixture is the CONTROL for every negative test in
 * `appleAppAttest.test.ts`: each one takes a VALID fixture and mutates exactly
 * one field, so a passing negative test proves the verifier rejected that
 * specific mutation and not something incidental. If you add an override here,
 * add the matching "everything else still valid" negative test with it.
 *
 * Shape mirrors a real Apple attestation: `x5c` is [credCert, intermediate]
 * with the root pinned out-of-band (Apple does NOT ship the root in the blob),
 * `authData` is the 87-byte App Attest layout, and the nonce lives in the
 * credCert extension OID 1.2.840.113635.100.8.2.
 *
 * Async because `@peculiar/x509` mints certificates through WebCrypto, which is
 * promise-based. (The plan sketched a sync signature; certificate generation
 * cannot be sync without hand-rolling ASN.1 signing.) The verifier under test
 * stays synchronous — only fixture construction awaits.
 */

// Apple's aaguid sentinels. Production is the 9 ASCII bytes of "appattest"
// followed by seven 0x00; development is the 16 ASCII bytes "appattestdevelop".
export const AAGUID_PRODUCTION = Buffer.concat([
  Buffer.from('appattest', 'ascii'),
  Buffer.alloc(7, 0),
]);
export const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop', 'ascii');

export const APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';

const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

let cryptoProviderReady = false;
function ensureCryptoProvider(): void {
  if (cryptoProviderReady) return;
  x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
  cryptoProviderReady = true;
}

async function generateEcKeyPair(): Promise<CryptoKeyPair> {
  ensureCryptoProvider();
  return (await crypto.webcrypto.subtle.generateKey(EC_ALG as never, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

/**
 * DER for the App Attest nonce extension body:
 *   SEQUENCE { [1] EXPLICIT { OCTET STRING nonce } }
 * Hand-built rather than pulled from an ASN.1 schema package so the fixture
 * commits to the exact bytes Apple emits, independent of how the verifier
 * chooses to parse them.
 */
function encodeNonceExtensionBody(nonce: Buffer): Buffer {
  if (nonce.length > 0x7f) throw new Error('fixture nonce too long for short-form DER');
  const octetString = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
  const explicitTag1 = Buffer.concat([Buffer.from([0xa1, octetString.length]), octetString]);
  return Buffer.concat([Buffer.from([0x30, explicitTag1.length]), explicitTag1]);
}

/** The X9.62 uncompressed point (0x04 || X || Y) that Apple hashes into keyId. */
export function uncompressedEcPoint(publicKeyDer: Buffer): Buffer {
  const jwk = crypto
    .createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
    .export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('fixture credCert key is not an EC key');
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

function buildAuthData(input: {
  appId: string;
  signCount: number;
  aaguid: Buffer;
  credentialId: Buffer;
}): Buffer {
  const rpIdHash = crypto.createHash('sha256').update(input.appId, 'utf8').digest();
  const flags = Buffer.from([0x40]); // AT (attested credential data present)
  const signCount = Buffer.alloc(4);
  signCount.writeUInt32BE(input.signCount >>> 0, 0);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(input.credentialId.length, 0);
  return Buffer.concat([
    rpIdHash,
    flags,
    signCount,
    input.aaguid,
    credentialIdLength,
    input.credentialId,
  ]);
}

export interface AppAttestFixtureOverrides {
  /** The transcript the attestation is bound to. Default: 32 random bytes. */
  clientDataHash?: Buffer;
  /** Hashed into authData.rpIdHash. Default: `D8W6N2JYMA.com.breeze.rmm`. */
  appId?: string;
  /** authData.signCount. Apple always emits 0. */
  signCount?: number;
  /** authData.aaguid. Default: production. */
  aaguid?: Buffer;
  /** Force the credCert nonce extension to a value OTHER than the real nonce. */
  nonceExtension?: Buffer;
  /** Overrides BOTH the returned keyId and (unless credentialId is set) authData.credentialId. */
  keyId?: Buffer;
  /** authData.credentialId only — for isolating the "credentialId === keyId" check. */
  credentialId?: Buffer;
  /** credCert notAfter. notBefore is pinned one hour earlier. */
  notAfter?: Date;
  /** CBOR `fmt`. Default `apple-appattest`. */
  fmt?: string;
  /** Omit the attStmt receipt entirely. */
  omitReceipt?: boolean;
}

export interface AppAttestFixture {
  attestationObjectB64: string;
  keyIdB64: string;
  /** PEM of the throwaway root — pass as `rootCertificatesPem` to the verifier. */
  rootPem: string;
  /** SPKI DER of the credCert key, i.e. what the verifier should return. */
  attestedPublicKeyDer: Buffer;
  /** The transcript actually bound in, so tests can assert against it. */
  clientDataHash: Buffer;
  receiptB64: string;
}

export async function mintAppAttestFixture(
  overrides: AppAttestFixtureOverrides = {},
): Promise<AppAttestFixture> {
  ensureCryptoProvider();

  const clientDataHash = overrides.clientDataHash ?? crypto.randomBytes(32);
  const appId = overrides.appId ?? 'D8W6N2JYMA.com.breeze.rmm';
  const signCount = overrides.signCount ?? 0;
  const aaguid = overrides.aaguid ?? AAGUID_PRODUCTION;
  const now = Date.now();

  const rootKeys = await generateEcKeyPair();
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Breeze Test App Attest Root CA, O=Breeze Test',
    notBefore: new Date(now - 86_400_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: EC_ALG as never,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });

  const intermediateKeys = await generateEcKeyPair();
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=Breeze Test App Attest CA 1, O=Breeze Test',
    issuer: root.subject,
    notBefore: new Date(now - 86_400_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: EC_ALG as never,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
  });

  const credKeys = await generateEcKeyPair();
  const attestedPublicKeyDer = Buffer.from(
    await crypto.webcrypto.subtle.exportKey('spki', credKeys.publicKey),
  );
  const keyId = overrides.keyId ?? crypto
    .createHash('sha256')
    .update(uncompressedEcPoint(attestedPublicKeyDer))
    .digest();
  const credentialId = overrides.credentialId ?? keyId;

  const authData = buildAuthData({ appId, signCount, aaguid, credentialId });
  const nonce =
    overrides.nonceExtension
    ?? crypto.createHash('sha256').update(Buffer.concat([authData, clientDataHash])).digest();

  const credNotAfter = overrides.notAfter ?? new Date(now + 3_600_000);
  const credCert = await x509.X509CertificateGenerator.create({
    serialNumber: '03',
    subject: 'CN=Breeze Test App Attest Credential',
    issuer: intermediate.subject,
    notBefore: new Date(credNotAfter.getTime() - 3_600_000),
    notAfter: credNotAfter,
    signingAlgorithm: EC_ALG as never,
    publicKey: credKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    extensions: [
      new x509.Extension(APP_ATTEST_NONCE_OID, false, new Uint8Array(encodeNonceExtensionBody(nonce))),
    ],
  });

  const receipt = crypto.randomBytes(64);
  const attStmt = new Map<string | number, CBORType>([
    ['x5c', [new Uint8Array(credCert.rawData), new Uint8Array(intermediate.rawData)]],
  ]);
  if (!overrides.omitReceipt) attStmt.set('receipt', new Uint8Array(receipt));

  const attestationObject = encodeCBOR(
    new Map<string | number, CBORType>([
      ['fmt', overrides.fmt ?? 'apple-appattest'],
      ['attStmt', attStmt],
      ['authData', new Uint8Array(authData)],
    ]),
  );

  return {
    attestationObjectB64: Buffer.from(attestationObject).toString('base64'),
    keyIdB64: keyId.toString('base64'),
    rootPem: root.toString('pem'),
    attestedPublicKeyDer,
    clientDataHash,
    receiptB64: receipt.toString('base64'),
  };
}
