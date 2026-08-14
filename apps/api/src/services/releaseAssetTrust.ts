/**
 * Platform-trust LABEL-CONSISTENCY guard for release assets (spec 3c).
 *
 * Replaces expected-value-only checking: instead of only failing when a caller
 * happened to pass expectedPlatformTrust, every manifest-verified asset is
 * checked against what its NAME requires, unknown trust vocabulary fails
 * closed, and signing-input assets (Deliverable 1's `-unsigned` uploads with
 * intendedUse: "signing-input") are never distributable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO. It never inspects the bytes. Nothing here (or anywhere
 * else in the API) verifies an Authenticode signature or a notarization ticket.
 * It compares the manifest's platformTrust LABEL against what the asset's name
 * implies, so for any manifest produced by the reference generator in
 * .github/workflows/release.yml it is a tautology — both sides compute the same
 * value from the same filename by the same rules. It can only fire on a
 * manifest whose label contradicts its own name.
 *
 * That is still worth having: it catches a hand-rolled or partially-implemented
 * third-party manifest that omits or downgrades the label. But it is NOT
 * evidence that a binary was signed. A self-hoster whose fork keeps the
 * manifest-generation step and drops the signing step produces assets that pass
 * this gate unsigned. The control that actually establishes signing lives in
 * the producing workflow (the breeze-selfhost-signing template's publish job
 * requires a per-asset signing attestation before it will emit a *-required
 * platformTrust); this is the consuming-side sanity check on top of it.
 * ---------------------------------------------------------------------------
 *
 * The name classifier deliberately mirrors the manifest generator in
 * .github/workflows/release.yml (platform_trust(), ~line 2088) — keep the two
 * in sync when the asset taxonomy changes.
 */

export const PLATFORM_TRUST_WINDOWS = 'windows-authenticode-required';
export const PLATFORM_TRUST_MACOS = 'macos-developer-id-notarization-required';
export const PLATFORM_TRUST_WORKFLOW = 'release-workflow-produced';
export const PLATFORM_TRUST_NONE = 'none';

export const KNOWN_PLATFORM_TRUST_VALUES: ReadonlySet<string> = new Set([
  PLATFORM_TRUST_WINDOWS,
  PLATFORM_TRUST_MACOS,
  PLATFORM_TRUST_WORKFLOW,
  PLATFORM_TRUST_NONE,
]);

export const INTENDED_USE_SIGNING_INPUT = 'signing-input';

// Release editions (BYO signing follow-up): "self-host" is the public release
// build (unsigned by default — BYO-signing repos re-sign it before publishing
// their own release); "hosted" is built and distributed privately and must
// never be fetched from a public GitHub release.
export const EDITION_SELF_HOST = 'self-host';
export const EDITION_HOSTED = 'hosted';

export const KNOWN_EDITION_VALUES: ReadonlySet<string> = new Set([
  EDITION_SELF_HOST,
  EDITION_HOSTED,
]);

// The assets the public self-host release is expected to ship unsigned
// (platformTrust "none"). An EXACT-FILENAME allowlist, deliberately not a
// pattern: an unrecognised .exe/.msi must still require Authenticode, so a new
// or renamed Windows asset fails closed until it is added here on purpose.
// breeze-helper-windows.msi, for instance, stays signed regardless of edition.
//
// This list mirrors the assets .github/workflows/release.yml builds without
// signing — the MSI (built by the "Build unsigned self-host MSI" step) and the
// four exes it is built from. Keep it in sync when that job's asset set changes.
//
// #3504: the four exes were missing here. #3351 removed Authenticode signing
// from the public pipeline ("the public pipeline no longer signs these",
// release.yml:419) but this allowlist was not widened alongside it, so every
// public release from v0.105.0 on was rejected at sync time. Because
// binarySync's Phase 1 aborts the whole sync on a trust failure by design
// (bbde37ea9, pinned by binarySync.test.ts), one rejected exe also prevented
// the Linux and macOS assets from registering — surfacing to self-hosters as a
// 404 "Version not found for the specified platform and architecture" on every
// platform, which points at entirely the wrong thing.
const SELF_HOST_UNSIGNED_ASSET_NAMES: ReadonlySet<string> = new Set([
  'breeze-agent.msi',
  'breeze-agent-windows-amd64.exe',
  'breeze-backup-windows-amd64.exe',
  'breeze-watchdog-windows-amd64.exe',
  'breeze-user-helper-windows-amd64.exe',
]);

// Raw darwin Mach-O binaries carry Developer ID + notarization even though
// they ship inside the .pkg (see release.yml DARWIN_BINARY_RE).
const DARWIN_BINARY_RE = /^breeze-(agent|backup|desktop-helper|watchdog)-darwin-(amd64|arm64)$/;

// "-unsigned" immediately before the extension chain (or at the end for
// extensionless darwin/linux binaries): breeze-agent-windows-amd64-unsigned.exe,
// breeze-agent-darwin-arm64-unsigned.
const SIGNING_INPUT_NAME_RE = /-unsigned(\.[A-Za-z0-9]+)*$/i;

export function isSigningInputAssetName(assetName: string): boolean {
  return SIGNING_INPUT_NAME_RE.test(assetName);
}

/**
 * True when this asset is being admitted ONLY because of the self-host unsigned
 * relaxation — i.e. it would be refused if it were not labeled edition
 * "self-host". Callers use this to warn that an unsigned binary is about to be
 * served; it does not itself permit or refuse anything.
 *
 * Returns false for a signed self-host asset (a BYO-signing repo that re-signed
 * before publishing), which is the case that needs no warning.
 */
export function isUnsignedSelfHostAsset(args: {
  assetName: string;
  platformTrust: string | null;
  edition?: string | null;
}): boolean {
  return (
    SELF_HOST_UNSIGNED_ASSET_NAMES.has(args.assetName) &&
    args.edition === EDITION_SELF_HOST &&
    args.platformTrust === PLATFORM_TRUST_NONE
  );
}

/**
 * The platformTrust value an asset's NAME requires, or null when the name
 * implies no platform-signing requirement (Linux binaries, scripts, manifests).
 */
export function requiredPlatformTrustFor(assetName: string): string | null {
  if (/\.(exe|msi)$/i.test(assetName)) return PLATFORM_TRUST_WINDOWS;
  if (/\.pkg$/i.test(assetName) || /\.dmg$/i.test(assetName) || /\.app\.zip$/i.test(assetName)) {
    return PLATFORM_TRUST_MACOS;
  }
  if (DARWIN_BINARY_RE.test(assetName)) return PLATFORM_TRUST_MACOS;
  return null;
}

/**
 * Throws unless the asset may be registered or served to end users/agents.
 * Fail-closed on: any intendedUse (the only known value, "signing-input", is
 * never distributable, and unknown future values must not slip through), a
 * signing-input-shaped name, unknown platformTrust vocabulary, unknown edition
 * vocabulary, and a canonical Windows/macOS asset whose trust label is missing
 * or weaker than required.
 *
 * platformTrust === null on a NON-canonical asset is tolerated for manifests
 * predating the platformTrust field. edition is optional throughout — a
 * manifest predating the edition field (edition undefined/null) behaves
 * exactly as before this field existed.
 *
 * The one edition-aware relaxation: an asset in SELF_HOST_UNSIGNED_ASSET_NAMES
 * (breeze-agent.msi plus the four Windows exes) with edition "self-host" may
 * carry platformTrust "none" — the public self-host release ships those
 * unsigned by design — in addition to the normal "windows-authenticode-required".
 * Any other edition value, or none, still requires the signed label.
 */
export function assertDistributableReleaseAsset(args: {
  assetName: string;
  platformTrust: string | null;
  intendedUse: string | null;
  edition?: string | null;
}): void {
  if (args.intendedUse !== null) {
    throw new Error(
      `Release asset ${args.assetName} is not distributable (intendedUse=${args.intendedUse})`,
    );
  }
  if (isSigningInputAssetName(args.assetName)) {
    throw new Error(
      `Release asset ${args.assetName} is a signing input and must never be registered or served`,
    );
  }
  if (args.platformTrust !== null && !KNOWN_PLATFORM_TRUST_VALUES.has(args.platformTrust)) {
    throw new Error(
      `Release asset ${args.assetName} has unknown platformTrust "${args.platformTrust}"`,
    );
  }
  if (
    args.edition !== undefined &&
    args.edition !== null &&
    !KNOWN_EDITION_VALUES.has(args.edition)
  ) {
    throw new Error(
      `Release asset ${args.assetName} has unknown edition "${args.edition}"`,
    );
  }
  const required = requiredPlatformTrustFor(args.assetName);
  if (required === null) return;

  // The edition check is the safety property of this relaxation, not a
  // formality: hosted artifacts are signed and distributed privately, so an
  // unsigned asset claiming edition "hosted" — or claiming no edition at all —
  // is a mislabel or an attack and must still be refused.
  const isUnsignedSelfHostAsset =
    SELF_HOST_UNSIGNED_ASSET_NAMES.has(args.assetName) &&
    required === PLATFORM_TRUST_WINDOWS &&
    args.edition === EDITION_SELF_HOST &&
    args.platformTrust === PLATFORM_TRUST_NONE;

  if (args.platformTrust !== required && !isUnsignedSelfHostAsset) {
    throw new Error(
      `Release asset ${args.assetName} requires platformTrust "${required}", got ${
        args.platformTrust === null ? 'none recorded' : `"${args.platformTrust}"`
      }`,
    );
  }
}

/**
 * Defense-in-depth policy for the GitHub-fetch surfaces (installerBuilder's
 * fetchRegularMsi/fetchMacosInstallerAppZip, binarySync's GitHub sync): an
 * asset labeled edition "hosted" must never be accepted from a public GitHub
 * release, regardless of how well-formed its trust metadata is. Hosted
 * artifacts are distributed privately; if one ever showed up in a public
 * release manifest that would itself be the bug this guards against.
 */
export function assertGithubFetchableEdition(args: {
  assetName: string;
  edition: string | null;
}): void {
  if (args.edition === EDITION_HOSTED) {
    throw new Error(
      `Release asset ${args.assetName} is edition "hosted" and must never be fetched from a public GitHub release`,
    );
  }
}
