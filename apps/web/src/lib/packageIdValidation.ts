/**
 * Client-side package-id validation for package-manager install methods.
 *
 * Deliberately DUPLICATED from the API (`routes/softwareInstallMethods.ts`)
 * rather than imported: `apps/web` must not depend on `@breeze/api`, and these
 * regexes are a stable wire contract, not shared behaviour. The server remains
 * the authority — this exists so the modal can reject an obviously-bad manual
 * entry before a round trip, never as the only gate.
 *
 * Returns a machine CODE (not a message) so callers translate at render time;
 * comparing UI logic against a translated string is a repo-wide banned pattern
 * (see lib/__tests__/no-translated-comparisons.test.ts).
 */
export type PackagePlatform = 'windows' | 'macos';
export type InstallMethodKind = 'winget' | 'homebrew_cask' | 'homebrew_formula';

export const WINGET_PACKAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const BREW_PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._/@-]{0,255}$/;

export const MAX_PACKAGE_ID_LENGTH = 256;

/** Kinds valid for each platform — winget is Windows-only, brew macOS-only. */
export const KINDS_BY_PLATFORM: Record<PackagePlatform, InstallMethodKind[]> = {
  windows: ['winget'],
  macos: ['homebrew_cask', 'homebrew_formula'],
};

export type PackageIdError = 'too_long' | 'empty' | 'invalid_winget' | 'invalid_brew';

export function validatePackageIdForKind(
  kind: InstallMethodKind,
  packageId: string,
): PackageIdError | null {
  if (packageId.length === 0) return 'empty';
  if (packageId.length > MAX_PACKAGE_ID_LENGTH) return 'too_long';
  if (kind === 'winget') {
    return WINGET_PACKAGE_ID_RE.test(packageId) ? null : 'invalid_winget';
  }
  if (
    !BREW_PACKAGE_NAME_RE.test(packageId) ||
    packageId.startsWith('-') ||
    packageId.startsWith('/') ||
    packageId.includes('..')
  ) {
    return 'invalid_brew';
  }
  return null;
}

export function platformForKind(kind: InstallMethodKind): PackagePlatform {
  return kind === 'winget' ? 'windows' : 'macos';
}
