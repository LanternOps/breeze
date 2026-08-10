/**
 * Positive platform-trust allowlist for release assets (spec 3c).
 *
 * Replaces expected-value-only checking: instead of only failing when a caller
 * happened to pass expectedPlatformTrust, every manifest-verified asset is
 * checked against what its NAME requires, unknown trust vocabulary fails
 * closed, and signing-input assets (Deliverable 1's `-unsigned` uploads with
 * intendedUse: "signing-input") are never distributable.
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

// The one asset the public self-host release is expected to ship unsigned
// (platformTrust "none"): the Windows MSI. Scoped to this exact filename —
// NOT every .msi (e.g. breeze-helper-windows.msi stays signed regardless of
// edition) — because that's the only asset the release pipeline currently
// produces an unsigned self-host variant of.
const SELF_HOST_UNSIGNED_MSI_ASSET_NAME = 'breeze-agent.msi';

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
 * The one edition-aware relaxation: breeze-agent.msi with edition "self-host"
 * may carry platformTrust "none" (the public self-host release ships it
 * unsigned by default) in addition to the normal "windows-authenticode-required".
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

  const isUnsignedSelfHostMsi =
    args.assetName === SELF_HOST_UNSIGNED_MSI_ASSET_NAME &&
    required === PLATFORM_TRUST_WINDOWS &&
    args.edition === EDITION_SELF_HOST &&
    args.platformTrust === PLATFORM_TRUST_NONE;

  if (args.platformTrust !== required && !isUnsignedSelfHostMsi) {
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
