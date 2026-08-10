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
 * signing-input-shaped name, unknown platformTrust vocabulary, and a canonical
 * Windows/macOS asset whose trust label is missing or weaker than required.
 *
 * platformTrust === null on a NON-canonical asset is tolerated for manifests
 * predating the platformTrust field.
 */
export function assertDistributableReleaseAsset(args: {
  assetName: string;
  platformTrust: string | null;
  intendedUse: string | null;
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
  const required = requiredPlatformTrustFor(args.assetName);
  if (required !== null && args.platformTrust !== required) {
    throw new Error(
      `Release asset ${args.assetName} requires platformTrust "${required}", got ${
        args.platformTrust === null ? 'none recorded' : `"${args.platformTrust}"`
      }`,
    );
  }
}
