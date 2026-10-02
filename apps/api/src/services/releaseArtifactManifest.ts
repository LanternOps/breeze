import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  EDITION_SELF_HOST,
  assertDistributableReleaseAsset,
  isUnsignedSelfHostAsset,
} from './releaseAssetTrust';
import { safeFetchFollowingRedirects } from './urlSafety';

// Warn once per asset name per process. This fires on the normal, intended path
// for a stock public release (#3504) — every self-hoster on BINARY_SOURCE=github
// sees it — so it must be visible without being a per-request flood. The point
// is that "the download worked" should not read as "the binary is signed":
// Windows will show a SmartScreen warning, and the BYO-signing flow
// (docs: Sign Your Own Agent Packages) is what makes it go away.
const unsignedSelfHostWarned = new Set<string>();

function warnIfUnsignedSelfHostAsset(
  assetName: string,
  platformTrust: string | null,
  edition: string | null,
): void {
  if (!isUnsignedSelfHostAsset({ assetName, platformTrust, edition })) return;
  if (unsignedSelfHostWarned.has(assetName)) return;
  unsignedSelfHostWarned.add(assetName);
  console.warn(
    `[releaseAssetTrust] Serving UNSIGNED self-host asset ${assetName} (edition=self-host, platformTrust=none). ` +
      'The public release pipeline does not Authenticode-sign Windows agent binaries. ' +
      'Windows will show a SmartScreen warning on install. ' +
      'To serve signed binaries, re-sign the release with the breeze-selfhost-signing template.',
  );
}

// Typed failures for verifyReleaseArtifactManifestAsset (D3, issue #3836).
// Before this, EVERY throw from the combined verify-then-select call
// collapsed into a single "invalid signature" reason at the caller
// (agentVersions.ts validateReleaseManifest), which was both wrong (an
// asset-not-found or a distributability refusal is not a signature failure)
// and unhelpful for operators debugging a 409. Subclassing preserves every
// existing `.message` (nothing here changes wording, only exposes an
// `instanceof`-checkable failure category) and, critically, preserves
// ordering: verifyReleaseArtifactManifestAsset always calls
// verifyManifestSignature() FIRST, before parseManifest/selectManifestAsset
// can throw — so a caller distinguishing by class still only learns "asset
// lookup failed" or "not distributable" AFTER the signature has actually
// verified. That ordering is what #641 requires: metadata-probing reasons
// must never be reachable with a forged signature.
export class ReleaseManifestSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseManifestSignatureError";
  }
}

// The manifest's signature verified, but the requested asset couldn't be
// resolved from it: not present in `assets`, or present with a malformed
// sha256/size, or (defense in depth) a repository/release identity mismatch.
export class ReleaseManifestAssetLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseManifestAssetLookupError";
  }
}

// The one ReleaseManifestAssetLookupError variant that means the asset name
// simply isn't in the manifest's `assets` array at all — as opposed to being
// present with malformed metadata (invalid sha256/size) or a repository/
// release identity mismatch, both of which are still ReleaseManifestAssetLookupError
// but must NOT be treated as "absent" by a caller like binarySync.ts's
// registerFromOfficialManifest, which uses "absent" to decide whether a
// local/BYO fallback is legitimate (D4, #3836). A caller distinguishing
// "absent" from "present but wrong" needs a typed discriminant here rather
// than matching on `.message` text, which is not a contract and could
// coincidentally collide with wording used by an unrelated lookup failure —
// silently flipping a fail-closed decision to fail-open (review finding,
// fix round 1). Thrown ONLY at the single "not found in assets" site in
// selectManifestAsset below; every other ReleaseManifestAssetLookupError
// throw in this file stays the base class.
export class ReleaseManifestAssetAbsentError extends ReleaseManifestAssetLookupError {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseManifestAssetAbsentError";
  }
}

// The manifest's signature verified and the asset entry was found, but
// policy refuses to serve it: assertDistributableReleaseAsset's intendedUse/
// signing-input/platformTrust/edition checks, or the caller's own
// expectedPlatformTrust mismatch.
export class ReleaseAssetNotDistributableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseAssetNotDistributableError";
  }
}

// The manifest is genuine but was published before the release pipeline began
// recording a field this server now requires to serve the asset (#7830). Not a
// forgery and not a mislabel: the operator's fix is to raise the pinned
// release (BINARY_VERSION) to `minimumRelease` or later, and the message says
// so. Subclasses ReleaseAssetNotDistributableError so every existing
// `instanceof` category check keeps classifying it as a policy refusal.
export class ReleaseManifestTooOldError extends ReleaseAssetNotDistributableError {
  readonly release: string;
  readonly minimumRelease: string;

  constructor(args: { message: string; release: string; minimumRelease: string }) {
    super(args.message);
    this.name = "ReleaseManifestTooOldError";
    this.release = args.release;
    this.minimumRelease = args.minimumRelease;
  }
}

// The first official releases whose manifest generator (release.yml) writes
// each field. Verified against the published manifests: v0.104.0 has neither,
// v0.105.0 has `edition`, v0.112.0 is the first with signingIdentity/TeamId.
export const FIRST_RELEASE_WITH_EDITION = "v0.105.0";
export const FIRST_RELEASE_WITH_MACOS_PUBLISHER = "v0.112.0";

function parseReleaseTag(tag: string): [number, number, number] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True only when `release` is a parseable release tag strictly older than
 * `threshold` (a prerelease of the threshold version itself does not count —
 * it may already carry the field). An unparseable tag is never "older": the
 * legacy allowances below must not extend to tags they cannot order.
 */
export function releasePredates(release: string, threshold: string): boolean {
  const actual = parseReleaseTag(release);
  const limit = parseReleaseTag(threshold);
  if (!actual || !limit) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i]! !== limit[i]!) return actual[i]! < limit[i]!;
  }
  return false;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/**
 * Ceiling for the manifest and its signature. Exported because binarySync.ts
 * fetches the SAME two artifacts by a second path (#4262) and must not drift
 * from this value — an unexported copy there was a comment-enforced promise.
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
const PUBLIC_KEY_ENV_NAMES = [
  "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS",
  "BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS",
];

type ReleaseArtifactManifestAsset = {
  name?: unknown;
  sha256?: unknown;
  size?: unknown;
  platformTrust?: unknown;
  // BYO signing (Deliverable 1): "signing-input" marks published unsigned
  // build outputs. Tolerated here; positive rejection at registration/serve
  // time is Deliverable 3c.
  intendedUse?: unknown;
  // Release edition ("self-host" | "hosted"). Optional — absent on manifests
  // predating this field, which is tolerated everywhere it's read (treated
  // as "no edition claim", never as "self-host" by default). The one place
  // an absence may SATISFY an expected "self-host" is a release older than
  // FIRST_RELEASE_WITH_EDITION — see assertEditionAbsenceIsLegacySelfHost.
  edition?: unknown;
  signingIdentity?: unknown;
  signingTeamId?: unknown;
};

type ReleaseArtifactManifest = {
  schemaVersion?: unknown;
  repository?: unknown;
  release?: unknown;
  // BYO signing (Deliverable 1): the release's peeled source commit SHA,
  // recorded so downstream signing workflows can pin their checkout.
  sourceCommit?: unknown;
  // Server-only hotfix releases (additive, top-level; absent ⇒ "full"). A
  // server-only release rebuilds only the server images and carries a previous
  // full release's agent binaries forward: binariesRelease names that release,
  // binariesSourceCommit its source commit, carriedImages the carried image
  // digests. Read only through verifyReleaseArtifactManifestIdentity, after the
  // signature has verified.
  releaseKind?: unknown;
  binariesRelease?: unknown;
  binariesSourceCommit?: unknown;
  carriedImages?: unknown;
  assets?: unknown;
};

export type ReleaseKind = "full" | "server-only";

export type VerifiedManifestIdentity = {
  release: string;
  repository: string;
  /** The manifest's source commit; null on manifests predating the field. */
  sourceCommit: string | null;
  /** "full" when the manifest carries no releaseKind. */
  releaseKind: ReleaseKind;
  /** Server-only only: the full release whose agent binaries this release carries. */
  binariesRelease?: string;
  /** Server-only only: that full release's source commit (40-hex). */
  binariesSourceCommit?: string;
};

const STABLE_RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

type SelectedReleaseArtifactManifestAsset = ReleaseArtifactManifestAsset & {
  sha256: string;
  size: number;
};

export type VerifiedReleaseArtifact = {
  assetName: string;
  sha256: string;
  size: number;
  release: string;
  repository: string;
  platformTrust: string | null;
  intendedUse: string | null;
  edition: string | null;
  signingIdentity: string | null;
  signingTeamId: string | null;
};

function readMacosPublisher(
  entry: ReleaseArtifactManifestAsset,
  assetName: string,
  required: boolean,
  release: string,
): { signingIdentity: string | null; signingTeamId: string | null } {
  const identity = entry.signingIdentity;
  const teamId = entry.signingTeamId;
  if (identity === undefined && teamId === undefined) {
    if (!required) return { signingIdentity: null, signingTeamId: null };
    // A genuine manifest from before the pipeline recorded the publisher
    // (#7830). The pin is a security control — install.sh checks the pkg's
    // signature against exactly this identity before a privileged install —
    // so there is nothing to fall back to; tell the operator which release
    // carries it instead of reporting the manifest as invalid.
    if (releasePredates(release, FIRST_RELEASE_WITH_MACOS_PUBLISHER)) {
      throw new ReleaseManifestTooOldError({
        message:
          `The signed release manifest for ${release} predates the macOS publisher identity for ${assetName} ` +
          `(first recorded in ${FIRST_RELEASE_WITH_MACOS_PUBLISHER}), so the package cannot be served. ` +
          `Set BINARY_VERSION to ${FIRST_RELEASE_WITH_MACOS_PUBLISHER} or later.`,
        release,
        minimumRelease: FIRST_RELEASE_WITH_MACOS_PUBLISHER,
      });
    }
    // Otherwise (a release that should carry the identity, or a tag that
    // cannot be ordered): fall through to the generic invalid-identity refusal.
  }
  if (
    typeof identity !== "string" ||
    identity.length < 1 ||
    identity.length > 256 ||
    /[\r\n]/.test(identity) ||
    typeof teamId !== "string" ||
    !/^[A-Z0-9]{10}$/.test(teamId) ||
    !identity.startsWith("Developer ID Installer: ") ||
    !identity.endsWith(` (${teamId})`)
  ) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest has invalid macOS signing identity for ${assetName}`,
    );
  }
  return { signingIdentity: identity, signingTeamId: teamId };
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function getConfiguredPublicKeyStrings(): string[] {
  return PUBLIC_KEY_ENV_NAMES.map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function publicKeyFromRawEd25519(rawKey: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
}

function parsePublicKey(value: string): KeyObject | null {
  try {
    if (value.includes("BEGIN PUBLIC KEY")) {
      return createPublicKey(value);
    }

    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) {
      return publicKeyFromRawEd25519(decoded);
    }

    return createPublicKey({ key: decoded, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function getConfiguredPublicKeys(): KeyObject[] {
  const configured = getConfiguredPublicKeyStrings();
  const parsed = configured.map(parsePublicKey);
  if (configured.length > 0 && parsed.some((key) => key === null)) {
    throw new Error(
      "Release artifact manifest public key configuration is invalid",
    );
  }
  return parsed.filter((key): key is KeyObject => key !== null);
}

export function isReleaseArtifactManifestVerificationConfigured(): boolean {
  return getConfiguredPublicKeyStrings().length > 0;
}

// Task 2 (#3836): agentVersions.ts's legacy (non schema-v1) manifest
// verification used to check a row's signature against the UNION of env
// keys AND every DB-provisioned per-deployment key (manifest_signing_keys),
// regardless of what the row's signingKeyId actually claimed. That let a row
// stamped with the official key ID ("release-artifact-manifest-ed25519")
// pass the server by virtue of an otherwise-trusted deployment key's
// signature — even though a real agent's exact-ID lookup (agent/internal/
// updater/updater.go verifyManifestSignature) binds that ID to ONLY its
// embedded official key and would reject it (P1-UPD-001-style confusion,
// just moved from "any trusted key" to "any trusted key regardless of the
// claimed ID"). This function is what closes that gap for the legacy
// manifest shape: it answers "does this verify against an official key",
// using exactly the same trust root (getConfiguredPublicKeys) the schema-v1
// path (verifyManifestSignature above) already uses, with no DB access.
//
// Returns false (never throws) on any failure — no configured official
// keys, malformed signature, or a signature that doesn't verify against any
// of them. Deliberately no soft-pass-when-empty (unlike agentVersions.ts's
// verifyEd25519ManifestSignature default): an explicit claim of official
// provenance must be provable, not assumed — this is narrower than the
// default because it is only reached once a row has ALREADY claimed to be
// officially signed.
export function verifyManifestSignatureAgainstOfficialKeysOnly(
  manifest: string,
  signature: string,
): boolean {
  let publicKeys: KeyObject[];
  try {
    // getConfiguredPublicKeys throws if a configured key string is
    // malformed. Unlike the schema-v1 path (verifyManifestSignature above),
    // this function's caller (agentVersions.ts's legacy-shape dispatch) has
    // no surrounding try/catch of its own — fail closed here rather than let
    // a misconfigured env var surface as an uncaught exception on the
    // download route.
    publicKeys = getConfiguredPublicKeys();
  } catch {
    return false;
  }
  if (publicKeys.length === 0) return false;

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;

  const manifestBytes = Buffer.from(manifest, "utf8");
  return publicKeys.some((publicKey) => {
    try {
      return verifySignature(null, manifestBytes, publicKey, signatureBytes);
    } catch {
      return false;
    }
  });
}

function releaseArtifactManifestVerificationRequired(): boolean {
  const mode =
    process.env.RELEASE_ARTIFACT_MANIFEST_VERIFICATION?.trim().toLowerCase();
  if (mode === "required" || mode === "true" || mode === "1") {
    return true;
  }
  return process.env.NODE_ENV === "production";
}

function parseSignature(signatureBytes: Buffer): Buffer {
  const trimmed = signatureBytes.toString("utf8").trim();
  const signature = Buffer.from(trimmed, "base64");
  if (signature.length !== 64) {
    throw new ReleaseManifestSignatureError(
      "Release artifact manifest signature must be a base64 Ed25519 signature",
    );
  }
  return signature;
}

function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
): void {
  const publicKeys = getConfiguredPublicKeys();
  if (publicKeys.length === 0) {
    throw new ReleaseManifestSignatureError(
      "Release artifact manifest public key is not configured",
    );
  }

  const signature = parseSignature(signatureBytes);
  const trusted = publicKeys.some((publicKey) => {
    try {
      return verifySignature(null, manifestBytes, publicKey, signature);
    } catch {
      return false;
    }
  });

  if (!trusted) {
    throw new ReleaseManifestSignatureError(
      "Release artifact manifest signature verification failed",
    );
  }
}

// Runs AFTER verifyManifestSignature in every caller (verifyReleaseArtifactBuffer,
// verifyReleaseArtifactManifestAsset), so a malformed manifest here can only be
// reached with an already-verified signature — these are lookup-shape failures
// (the referenced asset can't be resolved from an unparseable/mis-shaped
// manifest), not signature failures.
function parseManifest(manifestBytes: Buffer): ReleaseArtifactManifest {
  let parsed: ReleaseArtifactManifest;
  try {
    parsed = JSON.parse(
      manifestBytes.toString("utf8"),
    ) as ReleaseArtifactManifest;
  } catch {
    throw new ReleaseManifestAssetLookupError(
      "Release artifact manifest is not valid JSON",
    );
  }

  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.repository !== "string" ||
    typeof parsed.release !== "string" ||
    !Array.isArray(parsed.assets)
  ) {
    throw new ReleaseManifestAssetLookupError(
      "Release artifact manifest has an invalid schema",
    );
  }

  return parsed;
}

function assertStringEqual(
  actual: unknown,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest ${label} mismatch: expected ${expected}, got ${String(actual)}`,
    );
  }
}

function assertSha256Equal(
  actual: string,
  expected: string,
  assetName: string,
): void {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    actualBuffer.length !== 32 ||
    expectedBuffer.length !== 32 ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error(
      `Release artifact digest mismatch for ${assetName}: expected ${expected}, got ${actual}`,
    );
  }
}

export async function verifyReleaseArtifactBuffer(args: {
  assetName: string;
  assetBuffer: Buffer;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
  expectedEdition?: string;
  requireMacosPublisher?: boolean;
}): Promise<VerifiedReleaseArtifact> {
  verifyManifestSignature(args.manifestBytes, args.signatureBytes);
  const manifest = parseManifest(args.manifestBytes);
  const entry = selectManifestAsset({
    manifest,
    assetName: args.assetName,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition: args.expectedEdition,
  });

  if (entry.size !== args.assetBuffer.length) {
    throw new Error(
      `Release artifact size mismatch for ${args.assetName}: expected ${entry.size}, got ${args.assetBuffer.length}`,
    );
  }

  const actualSha256 = sha256Hex(args.assetBuffer);
  assertSha256Equal(actualSha256, entry.sha256, args.assetName);
  const publisher = readMacosPublisher(
    entry,
    args.assetName,
    args.requireMacosPublisher === true,
    manifest.release as string,
  );

  return {
    assetName: args.assetName,
    sha256: actualSha256,
    size: args.assetBuffer.length,
    release: manifest.release as string,
    repository: manifest.repository as string,
    platformTrust:
      typeof entry.platformTrust === "string" ? entry.platformTrust : null,
    intendedUse: readIntendedUse(entry, args.assetName),
    edition: typeof entry.edition === 'string' ? entry.edition : null,
    ...publisher,
  };
}

// `intendedUse` is the field that marks Phase 1's unsigned signing inputs, and
// assertDistributableReleaseAsset treats ANY non-null value as non-distributable
// precisely so unknown future values cannot slip through. Coercing a
// present-but-non-string value to null would defeat that: `intendedUse: 1` or
// `intendedUse: ["signing-input"]` would read as "no intendedUse" and become
// registrable and servable. Reject the shape instead of silently discarding it.
function readIntendedUse(entry: { intendedUse?: unknown }, assetName: string): string | null {
  if (entry.intendedUse === undefined || entry.intendedUse === null) return null;
  if (typeof entry.intendedUse !== 'string') {
    throw new Error(
      `Release artifact manifest has non-string intendedUse for ${assetName} (got ${typeof entry.intendedUse}) — refusing to treat it as absent`,
    );
  }
  return entry.intendedUse;
}

/**
 * Called only when the entry's edition differs from the caller's expectation.
 * Returns (accepts) in exactly one case: the entry has NO edition, the caller
 * expects "self-host", the manifest's release predates the edition field, AND
 * the caller pinned exactly that release (#7830). The pin requirement keeps
 * the old incidental downgrade guard for everyone else: an unpinned ("latest")
 * or local-volume fetch never pins a release, so a replayed — genuinely signed
 * — pre-v0.105.0 manifest is still refused there rather than silently rolling
 * the fleet back to an old build. Every official release before v0.105.0 was
 * the public self-host
 * build — the hosted edition did not exist until the field did — so for those
 * manifests the absence carries no information and refusing it made every
 * installer unreachable for a self-hoster pinning BINARY_VERSION below
 * v0.105.0. The verified result still reports `edition: null`: nothing
 * downstream (e.g. assertDistributableReleaseAsset's unsigned-MSI relaxation)
 * may read a claim into a manifest that made none. A missing edition is never
 * read as "hosted", and on a release that should carry the field it is refused.
 */
function assertEditionAbsenceIsLegacySelfHost(args: {
  assetName: string;
  release: string;
  edition: unknown;
  expectedEdition: string;
  pinnedRelease: string | null;
}): void {
  const mismatch = `Release artifact manifest edition mismatch for ${args.assetName}: expected ${args.expectedEdition}, got ${String(args.edition)}`;
  if (args.edition !== undefined) {
    throw new ReleaseAssetNotDistributableError(mismatch);
  }
  if (args.expectedEdition === EDITION_SELF_HOST) {
    if (releasePredates(args.release, FIRST_RELEASE_WITH_EDITION)) {
      if (args.pinnedRelease === args.release) return;
      throw new ReleaseAssetNotDistributableError(
        `${mismatch} — the signed manifest for ${args.release} predates the edition field (first recorded in ${FIRST_RELEASE_WITH_EDITION}). ` +
          `A release that old is served only when BINARY_VERSION pins it explicitly; otherwise use ${FIRST_RELEASE_WITH_EDITION} or later.`,
      );
    }
    throw new ReleaseAssetNotDistributableError(
      `${mismatch} — the signed manifest for ${args.release} records no edition, but every official release since ${FIRST_RELEASE_WITH_EDITION} does, ` +
        `so its absence here is refused rather than assumed`,
    );
  }
  throw new ReleaseAssetNotDistributableError(
    `${mismatch} — the signed manifest for ${args.release} records no edition, and a missing edition is never treated as ${args.expectedEdition}`,
  );
}

function selectManifestAsset(args: {
  manifest: ReleaseArtifactManifest;
  assetName: string;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
  expectedEdition?: string;
}): SelectedReleaseArtifactManifestAsset {
  const { manifest } = args;
  if (args.expectedRepository) {
    // GitHub repository names are case-insensitive for routing; the manifest
    // case reflects whatever GITHUB_REPOSITORY was set to at release time
    // (canonical org case, e.g. "LanternOps/breeze") while callers may pass a
    // lowercased default. Lock identity but tolerate case to avoid the
    // self-hoster footgun in fetchRegularMsi/fetchMacosPkg pre-flight.
    if (
      typeof manifest.repository !== "string" ||
      manifest.repository.toLowerCase() !== args.expectedRepository.toLowerCase()
    ) {
      throw new ReleaseManifestAssetLookupError(
        `Release artifact manifest repository mismatch: expected ${args.expectedRepository}, got ${String(manifest.repository)}`,
      );
    }
  }
  if (args.expectedRelease) {
    assertStringEqual(manifest.release, args.expectedRelease, "release");
  }

  const assets = manifest.assets as ReleaseArtifactManifestAsset[];
  const matches = assets.filter((candidate) => candidate.name === args.assetName);
  if (matches.length === 0) {
    throw new ReleaseManifestAssetAbsentError(
      `Release artifact manifest does not include ${args.assetName}`,
    );
  }
  if (matches.length !== 1) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest includes duplicate entries for ${args.assetName}`,
    );
  }
  const entry = matches[0]!;
  if (
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest has invalid sha256 for ${args.assetName}`,
    );
  }
  if (
    typeof entry.size !== "number" ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0
  ) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest has invalid size for ${args.assetName}`,
    );
  }
  // Spec 3c: positive allowlist, enforced for EVERY manifest verification —
  // github sync registration, installer/support asset pre-flight, and recovery
  // media all funnel through here. expectedPlatformTrust (below) remains as a
  // caller-supplied stricter expectation on top of this baseline.
  try {
    assertDistributableReleaseAsset({
      assetName: args.assetName,
      platformTrust: typeof entry.platformTrust === 'string' ? entry.platformTrust : null,
      intendedUse: readIntendedUse(entry, args.assetName),
      edition: typeof entry.edition === 'string' ? entry.edition : null,
    });
  } catch (err) {
    throw new ReleaseAssetNotDistributableError(
      err instanceof Error ? err.message : String(err),
    );
  }
  warnIfUnsignedSelfHostAsset(
    args.assetName,
    typeof entry.platformTrust === 'string' ? entry.platformTrust : null,
    typeof entry.edition === 'string' ? entry.edition : null,
  );
  if (
    args.expectedPlatformTrust &&
    entry.platformTrust !== args.expectedPlatformTrust
  ) {
    throw new ReleaseAssetNotDistributableError(
      `Release artifact manifest platform trust mismatch for ${args.assetName}: expected ${args.expectedPlatformTrust}, got ${String(entry.platformTrust)}`,
    );
  }
  if (args.expectedEdition && entry.edition !== args.expectedEdition) {
    assertEditionAbsenceIsLegacySelfHost({
      assetName: args.assetName,
      release: manifest.release as string,
      edition: entry.edition,
      expectedEdition: args.expectedEdition,
      // Asserted equal to manifest.release above, so this is "the operator
      // explicitly pinned exactly this signed release".
      pinnedRelease: args.expectedRelease ?? null,
    });
  }

  return {
    ...entry,
    sha256: entry.sha256,
    size: entry.size,
  };
}

export async function verifyReleaseArtifactManifestAsset(args: {
  assetName: string;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
  expectedEdition?: string;
  requireMacosPublisher?: boolean;
}): Promise<VerifiedReleaseArtifact> {
  verifyManifestSignature(args.manifestBytes, args.signatureBytes);
  const manifest = parseManifest(args.manifestBytes);
  const entry = selectManifestAsset({
    manifest,
    assetName: args.assetName,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition: args.expectedEdition,
  });
  const publisher = readMacosPublisher(
    entry,
    args.assetName,
    args.requireMacosPublisher === true,
    manifest.release as string,
  );
  return {
    assetName: args.assetName,
    sha256: entry.sha256,
    size: entry.size,
    release: manifest.release as string,
    repository: manifest.repository as string,
    platformTrust:
      typeof entry.platformTrust === "string" ? entry.platformTrust : null,
    intendedUse: readIntendedUse(entry, args.assetName),
    edition: typeof entry.edition === 'string' ? entry.edition : null,
    ...publisher,
  };
}

/**
 * Verifies just the manifest pair's signature + schema — no per-asset lookup.
 * Used when a caller needs to know "is this a validly-signed release artifact
 * manifest" before it knows (or cares) which specific asset it will look up,
 * e.g. binarySync's local-mode official-manifest registration (spec: BYO
 * signing edition follow-up), which registers WHICHEVER assets the manifest
 * happens to cover.
 */
export function verifyReleaseArtifactManifestIntegrity(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
): { release: string; repository: string } {
  verifyManifestSignature(manifestBytes, signatureBytes);
  const manifest = parseManifest(manifestBytes);
  return {
    release: manifest.release as string,
    repository: manifest.repository as string,
  };
}

/**
 * Verifies a release manifest's signature and identity, then reports what kind
 * of release it describes. The order is the contract: nothing in the manifest —
 * least of all releaseKind/binariesRelease, which a caller may FOLLOW to another
 * release — is read before the signature verifies and the manifest is bound to
 * the expected repository (case-insensitive, as GitHub routes) and release tag.
 *
 * Full manifests (releaseKind absent or "full") are accepted exactly as the
 * per-asset verifier accepts them; sourceCommit is reported but not required,
 * since manifests predating the field are still valid full releases.
 */
export function verifyReleaseArtifactManifestIdentity(args: {
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  expectedRepository: string;
  expectedRelease: string;
}): VerifiedManifestIdentity {
  verifyManifestSignature(args.manifestBytes, args.signatureBytes);
  const manifest = parseManifest(args.manifestBytes);
  const repository = manifest.repository as string;
  if (repository.toLowerCase() !== args.expectedRepository.toLowerCase()) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest repository mismatch: expected ${args.expectedRepository}, got ${repository}`,
    );
  }
  assertStringEqual(manifest.release, args.expectedRelease, "release");
  const release = manifest.release as string;
  const sourceCommit =
    typeof manifest.sourceCommit === "string" ? manifest.sourceCommit : null;

  const kind = manifest.releaseKind ?? "full";
  if (kind === "full") {
    return { release, repository, sourceCommit, releaseKind: "full" };
  }
  if (kind !== "server-only") {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact manifest for ${release} has an unknown releaseKind ${JSON.stringify(kind)}`,
    );
  }
  const { binariesRelease, binariesSourceCommit } = manifest;
  if (
    typeof binariesRelease !== "string" ||
    !STABLE_RELEASE_TAG.test(binariesRelease) ||
    binariesRelease === release
  ) {
    throw new ReleaseManifestAssetLookupError(
      `Server-only release manifest for ${release} has an invalid binariesRelease ${JSON.stringify(binariesRelease)}`,
    );
  }
  if (
    typeof binariesSourceCommit !== "string" ||
    !FULL_COMMIT_SHA.test(binariesSourceCommit)
  ) {
    throw new ReleaseManifestAssetLookupError(
      `Server-only release manifest for ${release} has an invalid binariesSourceCommit ${JSON.stringify(binariesSourceCommit)}`,
    );
  }
  return {
    release,
    repository,
    sourceCommit,
    releaseKind: "server-only",
    binariesRelease,
    binariesSourceCommit,
  };
}

async function fetchSmallBuffer(url: string, label: string): Promise<Buffer> {
  // A naive `redirect: "follow"` on verification inputs was an SSRF bypass
  // (#3649): a trusted URL could redirect into private space. The guarded
  // helper re-validates and pins every hop before it is dialed. `maxBytes`
  // makes the manifest ceiling a streaming one — the socket is torn down on
  // overrun rather than the body being buffered and measured afterwards.
  const resp = await safeFetchFollowingRedirects(url, {
    maxBytes: MAX_MANIFEST_BYTES,
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${label}: ${resp.status}`);
  }

  const contentLength = Number(resp.headers.get("content-length") || "0");
  if (contentLength > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} is too large`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} is too large`);
  }
  return buffer;
}

/**
 * Best-effort sha256/size lookup for a named asset, for DISPLAY only (the
 * bare-metal recovery media catalog, GET /backup/bmr/boot-media — W04b).
 * Unlike verifyReleaseArtifactManifestAsset this does NOT check the Ed25519
 * signature: the value shown here is not a trust decision (the actual
 * download still goes through GitHub's release redirect, or the S3/disk
 * path in self-host local mode, unaffected by this field), it is just
 * "what does the manifest currently say" for an operator glancing at the
 * download list. Returns null on ANY failure — unreachable manifest,
 * malformed JSON, unknown asset — so a manifest hiccup degrades the catalog
 * to "no checksum shown" rather than a 500.
 */
export async function lookupReleaseManifestAssetForDisplay(
  assetName: string,
  manifestUrl: string,
): Promise<{ sha256: string; size: number } | null> {
  try {
    const manifestBytes = await fetchSmallBuffer(manifestUrl, "release artifact manifest");
    const manifest = parseManifest(manifestBytes);
    const assets = manifest.assets as ReleaseArtifactManifestAsset[];
    const entry = assets.find((a) => a.name === assetName);
    if (
      !entry ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.size !== "number" ||
      entry.size <= 0
    ) {
      return null;
    }
    return { sha256: entry.sha256, size: entry.size };
  } catch {
    return null;
  }
}

export async function probeSafeReleaseArtifact(url: string): Promise<Response> {
  return safeFetchFollowingRedirects(url, {
    method: "HEAD",
    timeoutMs: 5_000,
    maxBytes: 0,
  });
}

export async function fetchVerifiedGithubReleaseArtifact(args: {
  assetName: string;
  assetUrl: string;
  manifestUrl: string;
  signatureUrl: string;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
  expectedEdition?: string;
  requireMacosPublisher?: boolean;
  maxAssetBytes: number;
}): Promise<{ buffer: Buffer; verified: VerifiedReleaseArtifact }> {
  if (!isReleaseArtifactManifestVerificationConfigured()) {
    throw new Error(
      "Release artifact manifest public key is required for privileged installer downloads",
    );
  }

  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchSmallBuffer(args.manifestUrl, "release artifact manifest"),
    fetchSmallBuffer(
      args.signatureUrl,
      "release artifact manifest Ed25519 signature",
    ),
  ]);
  const selected = await verifyReleaseArtifactManifestAsset({
    assetName: args.assetName,
    manifestBytes,
    signatureBytes,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition: args.expectedEdition,
    requireMacosPublisher: args.requireMacosPublisher,
  });
  if (selected.size <= 0 || selected.size > args.maxAssetBytes) {
    throw new ReleaseManifestAssetLookupError(
      `Release artifact size for ${args.assetName} is outside the allowed range`,
    );
  }

  const response = await safeFetchFollowingRedirects(args.assetUrl, {
    maxBytes: selected.size,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch release artifact ${args.assetName}: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const verified = await verifyReleaseArtifactBuffer({
    assetName: args.assetName,
    assetBuffer: buffer,
    manifestBytes,
    signatureBytes,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition: args.expectedEdition,
    requireMacosPublisher: args.requireMacosPublisher,
  });
  return { buffer, verified };
}

export async function verifyGithubReleaseArtifactBuffer(args: {
  assetName: string;
  assetBuffer: Buffer;
  manifestUrl: string;
  signatureUrl: string;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
  expectedEdition?: string;
  requireMacosPublisher?: boolean;
}): Promise<VerifiedReleaseArtifact | null> {
  if (!isReleaseArtifactManifestVerificationConfigured()) {
    if (releaseArtifactManifestVerificationRequired()) {
      throw new Error(
        "Release artifact manifest public key is required for GitHub fallback asset verification in production",
      );
    }
    return null;
  }

  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchSmallBuffer(args.manifestUrl, "release artifact manifest"),
    fetchSmallBuffer(
      args.signatureUrl,
      "release artifact manifest Ed25519 signature",
    ),
  ]);

  return verifyReleaseArtifactBuffer({
    assetName: args.assetName,
    assetBuffer: args.assetBuffer,
    manifestBytes,
    signatureBytes,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition: args.expectedEdition,
    requireMacosPublisher: args.requireMacosPublisher,
  });
}
