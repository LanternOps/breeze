/**
 * Canonical macOS installer app naming — single source of truth.
 *
 * These strings are a CONTRACT with the shipped Swift installer:
 * `agent/installer/macos-app/Sources/NUAgentInstaller/FilenameTokenParser.swift`
 * reads its enrollment token from either
 *   1. the app bundle's own filename — `<APP> [TOKEN@host].app`, or
 *   2. a sibling `<APP>.bootstrap.json`
 * If these names drift from the client, `renameAppInZip` throws and the server
 * silently falls back to an UNSTAMPED installer, which then fails to enroll.
 * Change these only together with the Swift client and release.yml.
 */

/** The app bundle name inside the release zip (no token stamp). */
export const INSTALLER_APP_NAME = 'Nodes Unlimited Installer.app';

/** The release asset (zip) name produced by release.yml. */
export const INSTALLER_APP_ZIP_NAME = 'Nodes Unlimited Installer.app.zip';

/** Sibling bootstrap payload the Swift client prefers over the filename stamp. */
export const INSTALLER_BOOTSTRAP_PAYLOAD_NAME =
  'Nodes Unlimited Installer.bootstrap.json';

/**
 * Pre-rebrand asset name. Kept ONLY as a read fallback so a release cut before
 * the rebrand still serves a stamped installer. Never used for new writes.
 */
export const LEGACY_INSTALLER_APP_ZIP_NAME = 'Breeze Installer.app.zip';

/** Pre-rebrand bundle name, accepted when renaming an older zip. */
export const LEGACY_INSTALLER_APP_NAME = 'Breeze Installer.app';

/** `Nodes Unlimited Installer [TOKEN@host].app` */
export function stampedInstallerAppName(token: string, apiHost: string): string {
  return `Nodes Unlimited Installer [${token}@${apiHost}].app`;
}

/**
 * The notarized DMG asset name produced by release.yml (no token stamp).
 * Attached to the GitHub release under this on-disk name.
 */
export const INSTALLER_DMG_NAME = 'Nodes Unlimited Agent.dmg';

/**
 * `Nodes Unlimited Agent [TOKEN@host].dmg`
 *
 * CONTRACT with the macOS installer app, which parses its enrollment token out
 * of the DMG's own download filename. Square brackets, exactly one space before
 * `[`, `.dmg` extension. `token` must match `^[A-Z0-9]{10}$` and `apiHost` must
 * be a bare https host with no port (macosBundleApiHost()).
 *
 * Unlike the Windows MSI (which uses PARENTHESES because MSI's Formatted-field
 * engine eats `[...]`), nothing rewrites the DMG filename between download and
 * mount, so the bracket form is safe here.
 */
export function stampedInstallerDmgName(token: string, apiHost: string): string {
  return `Nodes Unlimited Agent [${token}@${apiHost}].dmg`;
}
