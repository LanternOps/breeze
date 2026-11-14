/**
 * Where a local backup destination or a local vault may live.
 *
 * Paths are checked against an allow-list of absolute local forms
 * (isSupportedLocalStorePath), not a list of share spellings.
 *
 * The agent writes local destinations and vaults as its service account and
 * requires the directory to be private to that account. A network share
 * (SMB/NAS) is reached under the device's network identity instead, which
 * those checks cannot express, so network shares are not supported as local
 * destinations or vaults. Every write that sets a vault's type or path, or a
 * local destination's path, goes through these checks; the agent refuses the
 * same paths at run time for configurations saved before this check existed.
 *
 * Pool-free leaf (no db imports): shared by route schemas, AI tool schemas and
 * the services that write the rows.
 */

export const LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE =
  'A local backup destination or vault must be an absolute path on a disk attached to the device, such as '
  + 'D:\\Backups, \\\\?\\Volume{GUID}\\Backups or /var/backups/breeze. Network shares (UNC paths, mapped network drives, '
  + 'SMB and NAS shares) and device paths are not supported; use an S3 destination for off-device copies.';

export const SMB_VAULT_UNSUPPORTED_MESSAGE =
  'SMB share vaults are not supported. Use a vault on a disk attached to the device (local disk or USB), '
  + 'or an S3 destination for off-device copies.';

export class UnsupportedLocalStoreTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedLocalStoreTargetError';
  }
}

const NT_OBJECT_PREFIX = /^\/\?\?([\\/]|$)/;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const VOLUME_GUID = /^\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\/;

/**
 * Whether a path has one of the accepted forms for a local destination or
 * vault, all of them absolute paths on a volume of the device:
 *   - a drive-letter path (C:\x or C:/x);
 *   - a volume GUID path (\\?\Volume{GUID}\x);
 *   - a POSIX absolute path (/x), not starting with //, /\ or /??.
 * Everything else is refused: UNC paths in any spelling, \\?\ and \\.\
 * device paths other than a volume GUID (including GLOBALROOT paths,
 * whatever device they name), \??\ paths, relative and drive-relative paths,
 * and paths with surrounding whitespace or NUL. A drive letter mapped to a
 * share has an accepted form; the agent refuses it from what the volume is.
 */
export function isSupportedLocalStorePath(path: string): boolean {
  if (path.length === 0 || path !== path.trim() || path.includes('\0')) return false;
  if (DRIVE_ABSOLUTE.test(path)) return true;
  if (VOLUME_GUID.test(path)) return true;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  // "/??/..." is the NT object-manager prefix spelled with forward slashes.
  return !NT_OBJECT_PREFIX.test(path);
}

/**
 * The refusal for a vault write, or null. Only the fields being written are
 * checked: a write that sets neither type nor path (deactivating a vault,
 * changing its retention) is not refused, so a vault saved on a share can
 * still be switched off.
 */
export function localVaultTargetError(write: { vaultType?: unknown; vaultPath?: unknown }): string | null {
  if (write.vaultType === 'smb') return SMB_VAULT_UNSUPPORTED_MESSAGE;
  if (typeof write.vaultPath === 'string' && !isSupportedLocalStorePath(write.vaultPath)) {
    return LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE;
  }
  return null;
}

export const LOCAL_DESTINATION_PATH_KEY_MESSAGE =
  'Local destination settings must give the destination path once, under the key "path".';

/**
 * The refusal for a backup destination's provider settings, or null. A local
 * destination must name its path under exactly "path", as a string with an
 * accepted form. The settings reach the agent unchanged and its decoder
 * matches keys without regard to case, so any other spelling of the key
 * (Path, PATH) is refused rather than left unchecked.
 */
export function localDestinationTargetError(provider: unknown, providerConfig: unknown): string | null {
  if (provider !== 'local') return null;
  if (providerConfig === null || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    return LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE;
  }
  const settings = providerConfig as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (key !== 'path' && (key.toLowerCase() === 'path' || key.toUpperCase() === 'PATH')) {
      return LOCAL_DESTINATION_PATH_KEY_MESSAGE;
    }
  }
  const path = settings.path;
  if (typeof path !== 'string' || !isSupportedLocalStorePath(path)) return LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE;
  return null;
}

export function assertSupportedLocalVaultTarget(write: { vaultType?: unknown; vaultPath?: unknown }): void {
  const error = localVaultTargetError(write);
  if (error) throw new UnsupportedLocalStoreTargetError(error);
}

export function assertSupportedBackupDestination(destination: { provider: unknown; providerConfig: unknown }): void {
  const error = localDestinationTargetError(destination.provider, destination.providerConfig);
  if (error) throw new UnsupportedLocalStoreTargetError(error);
}
