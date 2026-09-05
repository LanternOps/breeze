import crypto from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { decodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import { APPLE_APP_ATTEST_ROOT_CA_PEM } from './appleAppAttestRootCA';

/**
 * Apple App Attest attestation verifier (#1374, feature #4707 wave W03).
 *
 * PURE: no database, no Redis, no env reads, no clock of its own (`now` is an
 * input). Everything it decides, it decides from its arguments — which is what
 * lets the whole of Apple's nine-step procedure be exercised in CI against a
 * synthetic CA (`__fixtures__/appAttestFixture.ts`) with no Apple round-trip.
 *
 * WHAT A PASS DOES AND DOES NOT MEAN. A pass proves: a genuine, unmodified
 * instance of THIS app (`appId`), on genuine Apple hardware, in the configured
 * App Attest environment, generated an App Attest key and vouched for
 * `clientDataHash` — the server-chosen registration transcript — during THIS
 * attempt. It does NOT prove anything about where the APPROVAL key lives: the
 * App Attest key and the approval key are two different keys, and iOS exposes
 * no server-verifiable proof that a given approval key is Secure-Enclave
 * resident. That gap is why the caller splits the basis by key algorithm
 * (ES256 -> `ios_se_p256_app_attest`, L4-trusted; RS256 -> the deliberately
 * NOT-L4-trusted `ios_keychain_rsa_app_attest`, since the Secure Enclave holds
 * only P-256 keys and an RSA key therefore cannot be in it).
 *
 * EVERY failure is an `AppAttestVerificationError`. The caller treats any throw
 * as "unattested" — the device still registers and works at L2/L3, it simply
 * cannot reach L4. There is no partial success and no "probably fine" path.
 *
 * Reference: Apple, "Validating Apps That Connect to Your Server"
 * (https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server).
 * The nine numbered checks below are that document's steps, in its order.
 */

/**
 * Apple's aaguid sentinels. Production is the 9 ASCII bytes of "appattest"
 * followed by seven 0x00; development is the 16 ASCII bytes "appattestdevelop".
 * These are the ONLY two accepted values — an unrecognized aaguid is a
 * rejection, never a shrug.
 */
const AAGUID_BY_ENVIRONMENT: Record<'production' | 'development', Buffer> = {
  production: Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7, 0)]),
  development: Buffer.from('appattestdevelop', 'ascii'),
};

/** The credCert extension Apple puts the attestation nonce in. */
const APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';

export interface AppAttestInput {
  attestationObjectB64: string;
  keyIdB64: string;
  clientDataHash: Buffer;
  appId: string;
  environment: 'production' | 'development';
  rootCertificatesPem?: string[];
  now?: Date;
}

export interface AppAttestResult {
  attestedPublicKeyDer: Buffer;
  receiptB64: string;
}

export class AppAttestVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`App Attest attestation rejected: ${reason}`);
    this.name = 'AppAttestVerificationError';
  }
}

function reject(reason: string): never {
  throw new AppAttestVerificationError(reason);
}

/** Length-safe constant-time compare — `timingSafeEqual` THROWS on a length
 *  mismatch, which would surface as a 500 instead of a rejection. */
function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A cert is usable only if `now` falls inside its validity window. */
function assertWithinValidity(cert: crypto.X509Certificate, now: Date, label: string): void {
  const from = cert.validFromDate;
  const to = cert.validToDate;
  if (!from || !to) reject(`${label} has an unreadable validity window`);
  if (now < from || now > to) reject(`${label} is not valid at ${now.toISOString()}`);
}

/** Signature check only. Never let a key-type mismatch escape as a raw throw. */
function signedBy(cert: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  try {
    return cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/**
 * CHECK 2 — walk credCert -> ... -> a PINNED root.
 *
 * Deliberately hand-walked rather than handed to a generic path builder: the
 * trust anchor set here is exactly one certificate, the chain is at most three
 * long, and the property that matters (every link is a real signature by the
 * next cert, and the top link is signed by a cert WE shipped) is easier to read
 * — and to test — as an explicit loop than as a policy object.
 *
 * The system trust store is never consulted: an attestation signed by any
 * public CA must fail exactly as hard as one signed by nobody.
 */
function verifyChainToPinnedRoot(
  chain: crypto.X509Certificate[],
  rootsPem: string[],
  now: Date,
): void {
  if (chain.length === 0) reject('x5c missing or empty');
  if (chain.length > 4) reject('x5c chain is implausibly long');

  chain.forEach((cert, i) => assertWithinValidity(cert, now, i === 0 ? 'credCert' : `x5c[${i}]`));

  for (let i = 0; i < chain.length - 1; i += 1) {
    const subject = chain[i];
    const issuer = chain[i + 1];
    if (!subject || !issuer) reject('x5c chain is malformed');
    if (!issuer.ca) reject(`x5c[${i + 1}] is not a CA certificate`);
    if (subject.issuer !== issuer.subject) reject(`x5c[${i}] issuer does not match x5c[${i + 1}]`);
    if (!signedBy(subject, issuer)) reject(`x5c[${i}] is not signed by x5c[${i + 1}]`);
  }

  const top = chain[chain.length - 1];
  if (!top) reject('x5c missing or empty');
  const roots: crypto.X509Certificate[] = [];
  for (const pem of rootsPem) {
    try {
      roots.push(new crypto.X509Certificate(pem));
    } catch {
      reject('a configured trust anchor is not a parseable certificate');
    }
  }
  if (roots.length === 0) reject('no trust anchor configured');

  const anchored = roots.some(
    (root) =>
      root.ca
      && root.subject === top.issuer
      && (() => {
        try {
          assertWithinValidity(root, now, 'trust anchor');
          return true;
        } catch {
          return false;
        }
      })()
      && signedBy(top, root),
  );
  if (!anchored) reject('certificate chain does not terminate at the pinned Apple root');
}

/**
 * CHECK 4 (part 1) — pull the nonce out of the credCert extension.
 *
 * The extension body is `SEQUENCE { [1] EXPLICIT { OCTET STRING nonce } }`.
 * Parsed strictly (short-form lengths only, no trailing bytes, exact nesting)
 * rather than with a permissive walker: this is the one field an attacker
 * controls the encoding of, and "we found 32 bytes somewhere in there" is not
 * the same claim as "the nonce is these bytes".
 */
function readAttestationNonce(credCert: crypto.X509Certificate): Buffer {
  let parsed: x509.X509Certificate;
  try {
    parsed = new x509.X509Certificate(credCert.raw);
  } catch {
    reject('credCert extensions are not parseable');
  }
  const ext = parsed.getExtension(APP_ATTEST_NONCE_OID);
  if (!ext) reject('credCert is missing the App Attest nonce extension');

  const body = Buffer.from(ext.value);
  let i = 0;
  const readHeader = (tag: number, what: string): number => {
    if (body[i] !== tag) reject(`nonce extension: expected ${what}`);
    i += 1;
    const len = body[i];
    if (len === undefined || (len & 0x80) !== 0) {
      reject('nonce extension uses a non-short-form DER length');
    }
    i += 1;
    return len;
  };
  const seqLen = readHeader(0x30, 'SEQUENCE');
  if (i + seqLen !== body.length) reject('nonce extension has trailing bytes');
  const ctxLen = readHeader(0xa1, 'context tag [1]');
  if (i + ctxLen !== body.length) reject('nonce extension [1] length mismatch');
  const octetLen = readHeader(0x04, 'OCTET STRING');
  if (i + octetLen !== body.length) reject('nonce extension OCTET STRING length mismatch');
  return body.subarray(i, i + octetLen);
}

/**
 * The X9.62 uncompressed point (0x04 || X || Y) that Apple hashes into keyId.
 * Not the SPKI DER: hashing the DER wrapper instead would never match a real
 * keyId, so getting this wrong fails closed — but loudly, in the fixture.
 */
function uncompressedEcPoint(publicKeyDer: Buffer): Buffer {
  let jwk: { kty?: string; crv?: string; x?: string; y?: string };
  try {
    jwk = crypto
      .createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
      .export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
  } catch {
    reject('credCert public key is not readable');
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    reject('credCert public key is not a P-256 EC key');
  }
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

interface AuthenticatorData {
  rpIdHash: Buffer;
  signCount: number;
  aaguid: Buffer;
  credentialId: Buffer;
}

/**
 * App Attest authenticator data:
 *   rpIdHash(32) | flags(1) | signCount(4 BE) | aaguid(16) | credIdLen(2 BE) | credentialId
 *
 * Trailing bytes are tolerated (Apple documents no COSE key here, but the
 * WebAuthn layout this borrows permits more after the credential id, and the
 * nonce commits to the WHOLE buffer either way, so extra bytes cannot be
 * substituted undetected).
 */
function parseAuthData(authData: Buffer): AuthenticatorData {
  if (authData.length < 55) reject('authData is truncated');
  const credentialIdLength = authData.readUInt16BE(53);
  if (authData.length < 55 + credentialIdLength) reject('authData credentialId is truncated');
  return {
    rpIdHash: authData.subarray(0, 32),
    signCount: authData.readUInt32BE(33),
    aaguid: authData.subarray(37, 53),
    credentialId: authData.subarray(55, 55 + credentialIdLength),
  };
}

export function verifyAppAttestAttestation(input: AppAttestInput): AppAttestResult {
  let decoded: CBORType;
  try {
    decoded = decodeCBOR(new Uint8Array(Buffer.from(input.attestationObjectB64, 'base64')));
  } catch {
    reject('attestation object is not valid CBOR');
  }
  if (!(decoded instanceof Map)) reject('attestation object is not a CBOR map');

  // CHECK 1 — the attestation format.
  if (decoded.get('fmt') !== 'apple-appattest') reject('fmt is not apple-appattest');

  const attStmt = decoded.get('attStmt');
  if (!(attStmt instanceof Map)) reject('attStmt missing');
  const x5c = attStmt.get('x5c');
  if (!Array.isArray(x5c) || x5c.length === 0) reject('x5c missing or empty');
  const receipt = attStmt.get('receipt');
  if (!(receipt instanceof Uint8Array)) reject('attStmt receipt missing');

  const chain = x5c.map((der, i) => {
    if (!(der instanceof Uint8Array)) reject(`x5c[${i}] is not a certificate`);
    try {
      return new crypto.X509Certificate(Buffer.from(der));
    } catch {
      return reject(`x5c[${i}] is not a parseable certificate`);
    }
  });
  const credCert = chain[0];
  if (!credCert) reject('x5c missing or empty');

  verifyChainToPinnedRoot(
    chain,
    input.rootCertificatesPem ?? [APPLE_APP_ATTEST_ROOT_CA_PEM],
    input.now ?? new Date(),
  );

  const rawAuthData = decoded.get('authData');
  if (!(rawAuthData instanceof Uint8Array)) reject('authData missing');
  const authDataBuf = Buffer.from(rawAuthData);
  const authData = parseAuthData(authDataBuf);

  // CHECKS 3 + 4 — the nonce is SHA256(authData || clientDataHash), and the
  // credCert commits to it. This is the single binding that makes the whole
  // attestation about THIS registration attempt: clientDataHash is the
  // server-derived registration transcript, so a blob captured from any other
  // attempt carries a nonce that cannot be recomputed here.
  const expectedNonce = crypto
    .createHash('sha256')
    .update(Buffer.concat([authDataBuf, input.clientDataHash]))
    .digest();
  if (!bytesEqual(expectedNonce, readAttestationNonce(credCert))) {
    reject('attestation nonce does not bind this registration transcript');
  }

  // CHECK 5 — keyId is SHA256 of the credCert public key in uncompressed
  // X9.62 form. This is what ties the caller-supplied key identifier to the
  // certificate the chain just vouched for.
  const attestedPublicKeyDer = credCert.publicKey.export({ type: 'spki', format: 'der' });
  const keyId = Buffer.from(input.keyIdB64, 'base64');
  const derivedKeyId = crypto
    .createHash('sha256')
    .update(uncompressedEcPoint(attestedPublicKeyDer))
    .digest();
  if (!bytesEqual(derivedKeyId, keyId)) {
    reject('keyId is not SHA256 of the credCert public key');
  }

  // CHECK 6 — rpIdHash binds the attestation to OUR app, not merely to a
  // genuine Apple device running something.
  const expectedRpIdHash = crypto.createHash('sha256').update(input.appId, 'utf8').digest();
  if (!bytesEqual(expectedRpIdHash, authData.rpIdHash)) {
    reject('rpIdHash does not match the configured appId');
  }

  // CHECK 7 — a freshly attested key has never signed anything. A non-zero
  // counter means this is not a first attestation of a new key.
  if (authData.signCount !== 0) reject('signCount is not 0');

  // CHECK 8 — the aaguid must match the CONFIGURED environment. Accepting the
  // development sentinel in production would accept attestations from any
  // developer-signed build of the app, which is the whole attack this wave
  // exists to close; `appleAppAttestEnvironment()` therefore defaults to
  // production so a missing env var cannot open it.
  if (!bytesEqual(AAGUID_BY_ENVIRONMENT[input.environment], authData.aaguid)) {
    reject(`aaguid does not match the ${input.environment} App Attest environment`);
  }

  // CHECK 9 — authData's credentialId is the same keyId. Without this, the
  // authData half of the blob (which the nonce covers) could describe a
  // different key than the certificate half (which check 5 covers).
  if (!bytesEqual(keyId, authData.credentialId)) {
    reject('authData credentialId does not match keyId');
  }

  return {
    attestedPublicKeyDer,
    receiptB64: Buffer.from(receipt).toString('base64'),
  };
}
