// Breeze Assist (component=helper) release assets: the Tauri helper ships as
// per-OS installers, not as breeze-helper-{os}-{arch} raw binaries — the one
// macOS .dmg covers both arches.
//
// This table is the single source of truth for the installer name a helper row
// is registered under. Both binarySync registration paths (syncFromGitHub and
// the BINARY_SOURCE=local scanHelperInstallerDir) look the official manifest
// entry up by exactly this name, and the download-time manifest check
// (routes/agentVersions.ts canonicalReleaseAssetName) must resolve the same
// name (#11298). Kept dependency-free so the route can import it without
// pulling in binarySync.
export const HELPER_TARGETS = [
  { goos: "windows", goarch: "amd64", assetName: "breeze-helper-windows.msi" },
  { goos: "darwin", goarch: "amd64", assetName: "breeze-helper-macos.dmg" },
  { goos: "darwin", goarch: "arm64", assetName: "breeze-helper-macos.dmg" },
  { goos: "linux", goarch: "amd64", assetName: "breeze-helper-linux.AppImage" },
] as const;

/**
 * The installer asset name for a helper row on (platform, arch). Accepts the
 * DB platform value "macos" as well as Go's "darwin". Null for any target
 * HELPER_TARGETS does not ship (e.g. windows/arm64).
 */
export function helperInstallerAssetName(platform: string, arch: string): string | null {
  const goos = platform === "macos" ? "darwin" : platform;
  const target = HELPER_TARGETS.find((t) => t.goos === goos && t.goarch === arch);
  return target?.assetName ?? null;
}
