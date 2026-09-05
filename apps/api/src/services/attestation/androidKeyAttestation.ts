import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AttestationApplicationId,
  AuthorizationList,
  id_ce_keyDescription,
  KeyDescription,
  NonStandardAuthorizationList,
  NonStandardKeyDescription,
  SecurityLevel,
  VerifiedBootState,
} from '@peculiar/asn1-android';
import { AsnParser } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';

/**
 * Android Key Attestation verifier (#1374, feature #4707 wave W04).
 *
 * WHAT THIS PROVES, and what it does not:
 *
 * A KeyStore-generated key can carry a certificate chain rooted in a Google
 * hardware attestation root. Exactly one certificate in it carries extension OID
 * `1.3.6.1.4.1.11129.2.1.17` (`KeyDescription`), which the secure hardware
 * itself populated, and which states the security level the private key lives
 * at plus the single-use challenge the key was created with. That — not Play
 * Integrity — is what lets the server say "this signing key is hardware-bound"
 * and set an `android_{tee,strongbox}_key_attestation` basis.
 *
 * `Software` is REJECTED. A software-backed KeyStore key is an ordinary key in
 * an app-readable store; treating it as platform-bound would re-open exactly
 * the critical-tier bypass this feature exists to close.
 *
 * Pure and synchronous: no database, no network, no clock beyond the injected
 * `now`. Every failure throws — there is no partial success, because a caller
 * that reads a field off a half-verified attestation is a caller that trusts an
 * unverified claim.
 *
 * NOT COVERED (stated so nobody assumes it is):
 *  - Certificate REVOCATION. Google publishes a status list at
 *    `https://android.googleapis.com/attestation/status`; consulting it is a
 *    network call and is deliberately out of this pure module. A revoked
 *    attestation key therefore still verifies here.
 *  - Whether the attested key is the one being registered. The verifier returns
 *    `attestedPublicKeyDer`; binding it to the registration is the CALLER's job
 *    (`verifyPlatformAttestation` does it against the presented SPKI).
 */

const KEY_DESCRIPTION_OID = id_ce_keyDescription;

/** KeyMint `KeyPurpose::SIGN`. */
const KEY_PURPOSE_SIGN = 2;
/** KeyMint `Digest::SHA_2_256`. */
const DIGEST_SHA_2_256 = 4;
/** KeyMint `KeyOrigin::GENERATED` — minted inside secure hardware, never imported. */
const KEY_ORIGIN_GENERATED = 0;
/**
 * The only `purpose` values an approver signing key may carry.
 *
 * SIGN is required; VERIFY rides along on almost every real device because
 * `KeyProperties.PURPOSE_SIGN | PURPOSE_VERIFY` is the idiomatic Android
 * generation call. Anything ELSE is refused, and `ATTEST_KEY` (7) is why this
 * check exists at all: a key permitted to sign attestation certificates can
 * mint its own chain, which is the same escalation the CA check below blocks
 * from the other direction.
 */
const ALLOWED_KEY_PURPOSES = new Set([KEY_PURPOSE_SIGN, /* VERIFY */ 3]);

export type AndroidSecurityLevel = 'Software' | 'TrustedEnvironment' | 'StrongBox';

export interface AndroidKeyAttestationResult {
  /**
   * Where the ATTESTED KEY lives. This is the field that decides the basis.
   *
   * Named `keyMintSecurityLevel` after KeyMint (attestation versions 300/400).
   * On older Keymaster versions (1–200) the same ASN.1 slot is called
   * `keymasterSecurityLevel`; the wire encoding is identical, so one parse
   * covers both and this name describes the semantic, not the vintage.
   */
  keyMintSecurityLevel: AndroidSecurityLevel;
  /** Where the ATTESTATION ITSELF was produced. A different field from the above. */
  attestationSecurityLevel: AndroidSecurityLevel;
  verifiedBootState: string;
  deviceLocked: boolean;
  /** SPKI DER of the attested certificate's public key — the attested key. */
  attestedPublicKeyDer: Buffer;
  packageName: string | null;
  /** Uppercase hex serial of the attested certificate, stored as `attestation_key_id`. */
  leafSerial: string;
}

export interface VerifyAndroidKeyAttestationInput {
  /** base64 DER certificates, leaf first, as `KeyStore.getCertificateChain()` returns. */
  certificateChainDerB64: string[];
  /** The registration transcript. Compared byte-exact against `attestationChallenge`. */
  expectedChallenge: Buffer;
  expectedPackageName: string;
  /** Defaults to the pinned Google hardware attestation roots. Tests inject their own. */
  rootCertificatesPem?: string[];
  now?: Date;
}

export class AndroidKeyAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AndroidKeyAttestationError';
  }
}

const fail = (message: string): never => {
  throw new AndroidKeyAttestationError(message);
};

/**
 * `@peculiar/asn1-schema` hands OCTET STRINGs back inconsistently: fields typed
 * `OctetString` on a SEQUENCE come back as `OctetString` (a wrapper with a
 * `.buffer`), while the same type nested inside `AttestationPackageInfo` comes
 * back as a bare `ArrayBuffer`. Normalizing here rather than at each call site
 * because the bare-ArrayBuffer case fails as an opaque `Buffer.from(undefined)`
 * TypeError several frames away from the field that caused it.
 */
function octetsToBuffer(value: { buffer: ArrayBuffer } | ArrayBuffer | undefined): Buffer | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value.buffer instanceof ArrayBuffer) return Buffer.from(value.buffer);
  return null;
}

// ---------------------------------------------------------------------------
// Pinned trust anchors
// ---------------------------------------------------------------------------

const ROOTS_PEM_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'googleHardwareAttestationRoots.pem',
);

let cachedRootSpkis: Set<string> | null = null;

function spkiFingerprint(key: crypto.KeyObject): string {
  return crypto
    .createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

function parsePemCertificates(pem: string): crypto.X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new crypto.X509Certificate(block));
}

/**
 * Anchor on the SubjectPublicKeyInfo, not on the certificate bytes.
 *
 * Google has re-issued the same RSA-4096 hardware attestation root several
 * times with successively later validity windows, and different devices ship
 * different re-issues. Pinning bytes would reject a device whose chain ends in
 * a re-issue we happen not to have copied; pinning the key accepts exactly the
 * set of chains Google's own key vouches for.
 *
 * Consequence, deliberate: the anchor's own validity window is NOT checked
 * (RFC 5280 §6.1 does not apply one to a trust anchor either). One of the
 * pinned certificates has already expired and MUST stay pinned — devices in the
 * field still terminate their chains in it.
 */
function trustedRootSpkis(rootCertificatesPem?: string[]): Set<string> {
  if (rootCertificatesPem) {
    return new Set(
      rootCertificatesPem.flatMap((pem) =>
        parsePemCertificates(pem).map((cert) => spkiFingerprint(cert.publicKey)),
      ),
    );
  }
  if (!cachedRootSpkis) {
    const certs = parsePemCertificates(readFileSync(ROOTS_PEM_PATH, 'utf8'));
    if (certs.length === 0) {
      // A build that shipped an empty/mangled PEM would otherwise trust nothing
      // and reject every real device with a confusing "not a pinned root".
      throw new AndroidKeyAttestationError(
        'no Google hardware attestation roots pinned — googleHardwareAttestationRoots.pem is empty or unparseable',
      );
    }
    cachedRootSpkis = new Set(certs.map((cert) => spkiFingerprint(cert.publicKey)));
  }
  return cachedRootSpkis;
}

/** Test seam: forget the parsed roots so a test can repoint the PEM. */
export function __resetPinnedRootsForTests(): void {
  cachedRootSpkis = null;
}

/**
 * Test seam: pin a synthetic root as the DEFAULT anchor set.
 *
 * Needed because `verifyPlatformAttestation` deliberately exposes no
 * root-injection parameter — production must never be able to choose its own
 * trust anchor — so an end-to-end test of the Android branch against a real
 * fixture chain has no other way in. Always pair with
 * `__resetPinnedRootsForTests()` in an `afterEach`.
 */
export function __setPinnedRootsForTests(rootCertificatesPem: string[]): void {
  cachedRootSpkis = trustedRootSpkis(rootCertificatesPem);
}

// ---------------------------------------------------------------------------
// Chain validation
// ---------------------------------------------------------------------------

function assertValidityWindow(cert: crypto.X509Certificate, now: Date, label: string): void {
  const from = new Date(cert.validFrom);
  const to = new Date(cert.validTo);
  if (now < from || now > to) {
    fail(`${label} certificate is outside its validity window (${cert.validFrom} .. ${cert.validTo})`);
  }
}

/**
 * Verify leaf → … → pinned root.
 *
 * Signature-checks every link and the validity window of every certificate the
 * DEVICE supplied. The terminal certificate is accepted as the anchor when its
 * public key is pinned — whether the device included the root itself (the usual
 * `getCertificateChain()` shape) or stopped at an intermediate Google signed.
 */
function verifyChain(chain: crypto.X509Certificate[], trusted: Set<string>, now: Date): void {
  if (chain.length < 2) {
    fail('attestation certificate chain must contain at least a leaf and one CA certificate');
  }

  for (let i = 0; i < chain.length; i += 1) {
    const cert = chain[i]!;
    const isAnchor = i === chain.length - 1 && trusted.has(spkiFingerprint(cert.publicKey));
    // The anchor's own expiry is not a path-validation input (see trustedRootSpkis).
    if (!isAnchor) assertValidityWindow(cert, now, i === 0 ? 'leaf' : `chain[${i}]`);
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    const subject = chain[i]!;
    const issuer = chain[i + 1]!;
    // EVERY issuer must be a CA. Without this, an attacker with a rooted phone
    // takes their own GENUINE attestation chain for a TEE key K1 — whose
    // attested purpose is SIGN with SHA-256, exactly what signing an X.509
    // TBSCertificate needs — and has KeyStore sign a certificate they authored
    // for a software key, carrying a forged KeyDescription that claims
    // StrongBox and a locked bootloader. Every signature in that chain
    // verifies and it terminates in a real pinned Google root.
    //
    // `checkIssued` below happens to catch the common shape (OpenSSL's
    // X509_check_issued folds in basicConstraints and keyCertSign), but it
    // returns TRUE for an issuer carrying NEITHER extension — a documented
    // compatibility allowance. `.ca` does not, so the explicit check is the
    // load-bearing one and must not be removed as redundant.
    if (!issuer.ca) {
      fail(`chain[${i + 1}] is not a CA certificate and may not issue chain[${i}]`);
    }
    if (!subject.checkIssued(issuer)) {
      fail(`certificate chain is not contiguous: chain[${i}] was not issued by chain[${i + 1}]`);
    }
    if (!subject.verify(issuer.publicKey)) {
      fail(`certificate chain signature check failed at chain[${i}]`);
    }
  }

  // The LAST certificate's key must itself be pinned. `KeyStore
  // .getCertificateChain()` returns the full chain up to the root, so a chain
  // that stops short of one is not something a real device produces — and
  // "trust it because a pinned root would have signed it, had it been sent"
  // is not a check, it is an assumption. Fail closed.
  const terminal = chain[chain.length - 1]!;
  if (!trusted.has(spkiFingerprint(terminal.publicKey))) {
    fail('attestation chain does not terminate in a pinned Google hardware attestation root');
  }
}

// ---------------------------------------------------------------------------
// KeyDescription parsing
// ---------------------------------------------------------------------------

/**
 * A normalized view over both AuthorizationList shapes.
 *
 * `@peculiar/asn1-android` ships a strict `AuthorizationList` (a SEQUENCE with
 * fixed field order) and a `NonStandardAuthorizationList` (SEQUENCE OF CHOICE)
 * for the real devices that emit fields out of order. Both appear in the wild,
 * so every read goes through here rather than touching `.purpose` directly and
 * silently reading `undefined` off the shape that needs `findProperty`.
 */
type AnyAuthorizationList = AuthorizationList | NonStandardAuthorizationList;

function authProp<K extends keyof AuthorizationList>(
  list: AnyAuthorizationList | undefined,
  key: K,
): AuthorizationList[K] | undefined {
  if (!list) return undefined;
  if (list instanceof NonStandardAuthorizationList) return list.findProperty(key);
  return list[key];
}

interface ParsedKeyDescription {
  attestationSecurityLevel: SecurityLevel;
  keyMintSecurityLevel: SecurityLevel;
  attestationChallenge: Buffer;
  softwareEnforced: AnyAuthorizationList;
  teeEnforced: AnyAuthorizationList;
}

/**
 * Locate the ONE certificate in the chain carrying the key description.
 *
 * Google's documentation is explicit that reading it off `chain[0]` is unsafe:
 *
 *   "Don't assume that the key attestation certificate extension is in the leaf
 *    certificate of the chain. Only the first occurrence of the extension in
 *    the chain can be trusted. Any further instances of the extension have not
 *    been issued by the secure hardware and might have been issued by an
 *    attacker extending the chain while attempting to create fake attestations
 *    for untrusted keys."
 *
 * The attack: anyone can generate an ordinary KeyStore key with purpose SIGN
 * and digest SHA-256 and receive a GENUINE Google-rooted chain for it. Signing
 * an X.509 TBSCertificate is just signing bytes with SHA-256, so they have the
 * secure hardware sign a certificate they authored for a software key of their
 * own, carrying a KeyDescription that asserts whatever they like, and prepend
 * it. Every signature verifies and the chain still ends at a pinned root.
 *
 * The CA check in `verifyChain` blocks this for a leaf that is CA:FALSE, which
 * a real KeyStore leaf is — but no test in this repo can prove that holds for
 * every KeyMint implementation in the field, so the count is the independent
 * defence and does not rest on that assumption.
 *
 * Rejecting a multi-occurrence chain outright, rather than silently preferring
 * the root-most one, keeps the failure legible: the only way to see two is an
 * extended chain, and that deserves an error naming what happened.
 */
function findKeyDescriptionCertificate(chainDer: Buffer[]): {
  cert: Certificate;
  index: number;
} {
  const carrying = chainDer
    .map((der, index) => ({ cert: AsnParser.parse(der, Certificate), index }))
    .filter(({ cert }) =>
      cert.tbsCertificate.extensions?.some((e) => e.extnID === KEY_DESCRIPTION_OID),
    );

  if (carrying.length === 0) {
    fail(
      `no certificate in the chain carries an Android key description extension (${KEY_DESCRIPTION_OID}) — the key was not produced by KeyStore attestation`,
    );
  }
  if (carrying.length > 1) {
    fail(
      `chain carries more than one key description extension (at positions ${carrying
        .map((c) => c.index)
        .join(', ')}) — only secure hardware issues one, so the chain has been extended`,
    );
  }
  return carrying[0]!;
}

function parseKeyDescription(cert: Certificate): ParsedKeyDescription {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === KEY_DESCRIPTION_OID);
  if (!ext) {
    fail(
      `certificate carries no Android key description extension (${KEY_DESCRIPTION_OID}) — the key was not produced by KeyStore attestation`,
    );
  }

  // Strict first; fall back to the permissive schema for devices that emit the
  // authorization lists out of order. Both are the same field semantics.
  let parsed: KeyDescription | NonStandardKeyDescription;
  try {
    parsed = AsnParser.parse(ext!.extnValue, KeyDescription);
  } catch (strictErr) {
    try {
      parsed = AsnParser.parse(ext!.extnValue, NonStandardKeyDescription);
    } catch (permissiveErr) {
      // Carry BOTH reasons. When a device fails the fallback too, the strict
      // error is usually the one that says what is actually malformed, and
      // discarding it leaves an operator diagnosing a real device with only
      // the less specific of the two messages.
      return fail(
        `key description extension could not be parsed as a KeyDescription ` +
          `(strict: ${(strictErr as Error).message}; permissive: ${(permissiveErr as Error).message})`,
      );
    }
  }

  return {
    attestationSecurityLevel: parsed.attestationSecurityLevel,
    // Keymaster and KeyMint name this slot differently; same encoding.
    keyMintSecurityLevel: parsed.keymasterSecurityLevel,
    attestationChallenge: octetsToBuffer(parsed.attestationChallenge) ?? Buffer.alloc(0),
    softwareEnforced: parsed.softwareEnforced,
    teeEnforced: parsed.teeEnforced,
  };
}

const SECURITY_LEVEL_NAMES: Record<SecurityLevel, AndroidSecurityLevel> = {
  [SecurityLevel.software]: 'Software',
  [SecurityLevel.trustedEnvironment]: 'TrustedEnvironment',
  [SecurityLevel.strongBox]: 'StrongBox',
};

const VERIFIED_BOOT_STATE_NAMES: Record<VerifiedBootState, string> = {
  [VerifiedBootState.verified]: 'Verified',
  [VerifiedBootState.selfSigned]: 'SelfSigned',
  [VerifiedBootState.unverified]: 'Unverified',
  [VerifiedBootState.failed]: 'Failed',
};

function securityLevelName(level: SecurityLevel, label: string): AndroidSecurityLevel {
  const name = SECURITY_LEVEL_NAMES[level];
  if (!name) fail(`${label} has an unrecognised security level (${level})`);
  return name!;
}

/** Only these two mean "the private key is in secure hardware". */
function assertHardwareSecurityLevel(name: AndroidSecurityLevel, label: string): void {
  if (name !== 'TrustedEnvironment' && name !== 'StrongBox') {
    fail(`${label} security level is ${name}, which is not hardware-backed`);
  }
}

/**
 * Read the attested package name.
 *
 * `attestationApplicationId` [709] is normally in **softwareEnforced**: the
 * calling package's identity is something Android Keystore knows and the secure
 * hardware does not, so Keystore is what asserts it. That is only worth
 * anything because the same attestation independently proves, in the
 * TEE-enforced RootOfTrust, that the bootloader is locked and verified boot
 * passed — i.e. that the Keystore making the claim is the stock, measured one.
 * Both lists are accepted (teeEnforced wins when present) because some
 * implementations do place it there.
 *
 * The plan specified `teeEnforced` only; that would reject essentially every
 * real device. Documented deviation.
 */
function attestedPackageName(
  teeEnforced: AnyAuthorizationList,
  softwareEnforced: AnyAuthorizationList,
): string | null {
  const raw = octetsToBuffer(
    authProp(teeEnforced, 'attestationApplicationId') ??
      authProp(softwareEnforced, 'attestationApplicationId'),
  );
  if (!raw) return null;
  let appId: AttestationApplicationId;
  try {
    appId = AsnParser.parse(raw, AttestationApplicationId);
  } catch (err) {
    // Distinguishable from "the device sent none": the caller's rejection
    // message otherwise reads `(absent)` for a field that WAS present and
    // merely unparseable, which sends an operator looking in the wrong place.
    return fail(`attestationApplicationId is unparseable: ${(err as Error).message}`);
  }
  const first = appId.packageInfos[0];
  if (!first) return null;
  return octetsToBuffer(first.packageName)?.toString('utf8') ?? null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function verifyAndroidKeyAttestation(
  input: VerifyAndroidKeyAttestationInput,
): AndroidKeyAttestationResult {
  const now = input.now ?? new Date();

  const chainDer = input.certificateChainDerB64.map((b64) => Buffer.from(b64, 'base64'));
  let chain: crypto.X509Certificate[];
  try {
    chain = chainDer.map((der) => new crypto.X509Certificate(der));
  } catch (err) {
    return fail(`attestation certificate chain is not parseable: ${(err as Error).message}`);
  }

  // 1. Chain: contiguous, signed, in-window, anchored in a pinned Google root.
  verifyChain(chain, trustedRootSpkis(input.rootCertificatesPem), now);

  // 2. Exactly ONE certificate in the chain carries a KeyDescription, and that
  //    certificate — not `chain[0]` by assumption — is the attested one.
  const carrier = findKeyDescriptionCertificate(chainDer);
  const attestedCert = chain[carrier.index]!;
  const desc = parseKeyDescription(carrier.cert);

  // 3. Challenge binding — byte-exact, constant-time.
  //    `timingSafeEqual` throws on a length mismatch, so length is checked first.
  const challengeMatches =
    desc.attestationChallenge.length === input.expectedChallenge.length &&
    crypto.timingSafeEqual(desc.attestationChallenge, input.expectedChallenge);
  if (!challengeMatches) {
    fail('attestation challenge does not equal the registration transcript');
  }

  // 4 + 5. Security levels. `Software` is refused on both axes.
  const keyMintSecurityLevel = securityLevelName(desc.keyMintSecurityLevel, 'attested key');
  const attestationSecurityLevel = securityLevelName(
    desc.attestationSecurityLevel,
    'attestation',
  );
  assertHardwareSecurityLevel(keyMintSecurityLevel, 'attested key');
  assertHardwareSecurityLevel(attestationSecurityLevel, 'attestation');

  // 6. Root of trust — TEE-enforced, never read from softwareEnforced.
  const rootOfTrust = authProp(desc.teeEnforced, 'rootOfTrust');
  if (!rootOfTrust) {
    fail('attestation carries no TEE-enforced root of trust');
  }
  if (rootOfTrust!.deviceLocked !== true) {
    fail('device bootloader is unlocked (rootOfTrust.deviceLocked is false)');
  }
  const verifiedBootState =
    VERIFIED_BOOT_STATE_NAMES[rootOfTrust!.verifiedBootState] ??
    `Unknown(${rootOfTrust!.verifiedBootState})`;
  if (verifiedBootState !== 'Verified') {
    fail(`verified boot state is ${verifiedBootState}, not Verified`);
  }

  // 7. Package binding.
  const packageName = attestedPackageName(desc.teeEnforced, desc.softwareEnforced);
  if (packageName !== input.expectedPackageName) {
    fail(
      `attested package name ${packageName ?? '(absent)'} does not match ${input.expectedPackageName}`,
    );
  }

  // 8. The key's usage constraints must be HARDWARE-enforced. A `purpose` or
  //    `digest` present only in softwareEnforced describes limits nothing in
  //    secure hardware is holding, so the key could be used for anything.
  const teePurpose = authProp(desc.teeEnforced, 'purpose');
  const teeDigest = authProp(desc.teeEnforced, 'digest');
  if (!teePurpose || !teeDigest) {
    fail('key purpose/digest are not hardware-enforced (absent from teeEnforced)');
  }
  if (authProp(desc.softwareEnforced, 'purpose') || authProp(desc.softwareEnforced, 'digest')) {
    fail('key purpose/digest appear in softwareEnforced, where they are attacker-controlled');
  }
  if (!teePurpose!.includes(KEY_PURPOSE_SIGN)) {
    fail('attested key is not hardware-constrained to SIGN');
  }
  const extraPurposes = [...teePurpose!].filter((p) => !ALLOWED_KEY_PURPOSES.has(p));
  if (extraPurposes.length > 0) {
    fail(`attested key carries disallowed key purposes [${extraPurposes.join(', ')}]`);
  }
  if (!teeDigest!.includes(DIGEST_SHA_2_256)) {
    fail('attested key is not hardware-constrained to SHA-256 digests');
  }
  // A key usable by every application is not bound to this app at all.
  if (
    authProp(desc.teeEnforced, 'allApplications') !== undefined ||
    authProp(desc.softwareEnforced, 'allApplications') !== undefined
  ) {
    fail('attested key is marked usable by all applications');
  }
  // An IMPORTED key's private half existed outside secure hardware before it was
  // loaded in, so the chain proves where the key LIVES but not that it was never
  // anywhere else. Only a hardware-GENERATED key earns a platform-bound basis.
  const origin = authProp(desc.teeEnforced, 'origin');
  if (origin !== KEY_ORIGIN_GENERATED) {
    fail(
      `attested key origin is ${origin ?? '(absent)'}, not GENERATED — an imported key is not hardware-bound`,
    );
  }
  // The approver key must be gated on a biometric/PIN prompt by the hardware
  // itself. `noAuthRequired` [503] present means it is not — the key would sign
  // an approval with no human present. W06's Kotlin MUST call
  // `setUserAuthenticationRequired(true)` when generating the key.
  if (authProp(desc.teeEnforced, 'noAuthRequired') !== undefined) {
    fail('attested key does not require user authentication (noAuthRequired is set)');
  }

  // 9. Hand the attested key back; binding it to the registration is the caller's.
  const attestedPublicKeyDer = Buffer.from(
    attestedCert.publicKey.export({ format: 'der', type: 'spki' }),
  );

  return {
    keyMintSecurityLevel,
    attestationSecurityLevel,
    verifiedBootState,
    // Read back from the attestation, not asserted as a literal — a hardcoded
    // `true` would keep reporting `true` if the gate above were ever removed,
    // and any test asserting it would echo the constant instead of the check.
    deviceLocked: rootOfTrust!.deviceLocked,
    attestedPublicKeyDer,
    packageName,
    leafSerial: attestedCert.serialNumber,
  };
}
