import { describe, expect, it } from 'vitest';
import {
  assertSupportedBackupDestination,
  assertSupportedLocalVaultTarget,
  isSupportedLocalStorePath,
  localDestinationTargetError,
  localVaultTargetError,
  LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE,
  SMB_VAULT_UNSUPPORTED_MESSAGE,
  UnsupportedLocalStoreTargetError,
} from './localStoreTargets';

// Allow-list: only absolute paths on a disk attached to the device are
// accepted. Anything else, including every UNC, device or GLOBALROOT form,
// is refused without naming it.
describe('isSupportedLocalStorePath', () => {
  it.each([
    'C:\\BreezeBackups',
    'd:\\Breeze\\Backups',
    'D:/BreezeBackups',
    'E:\\',
    '\\\\?\\Volume{0b2f1e52-0000-0000-0000-100000000000}\\BreezeBackups',
    '\\\\?\\Volume{0B2F1E52-0000-0000-0000-100000000000}\\',
    '/var/backups/breeze',
    '/mnt/usb/breeze',
    '/',
  ])('accepts %s', (path) => {
    expect(isSupportedLocalStorePath(path)).toBe(true);
  });

  it.each([
    // UNC and share spellings
    '\\\\nas\\backups',
    '//nas/backups/breeze',
    '\\/nas/backups',
    '/\\nas\\backups',
    '\\\\?\\UNC\\nas\\backups',
    '\\\\.\\UNC\\nas\\backups',
    '\\??\\UNC\\nas\\backups',
    '\\\\nas@SSL\\DavWWWRoot\\breeze',
    '\\\\tsclient\\c\\breeze',
    // device and GLOBALROOT paths, whatever device they name
    '\\\\?\\GLOBALROOT\\Device\\Mup\\nas\\backups',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\BreezeBackups',
    '\\\\?\\GLOBALROOT\\Device\\WebDavRedirector\\nas\\backups',
    '\\\\.\\GLOBALROOT\\Device\\RdpDr\\x',
    '\\\\?\\C:\\BreezeBackups',
    '\\\\.\\D:\\BreezeBackups',
    '\\??\\C:\\BreezeBackups',
    '\\\\.\\pipe\\x',
    '\\\\?\\Volume{not-a-guid}\\BreezeBackups',
    '\\\\?\\Volume{0b2f1e52-0000-0000-0000-100000000000}',
    // relative and drive-relative
    'backups',
    './backups',
    'C:backups',
    '\\BreezeBackups',
    '',
    '  /var/backups/breeze',
    '//var/backups/breeze',
    'C:\\Backups\u0000x',
    '/var/backups/breeze ',
    'D:\\Backups ',
    // NT object-manager prefix spelled with forward slashes
    '/??/UNC/nas/share',
    '/??/C:/BreezeBackups',
    '/??',
  ])('refuses %j', (path) => {
    expect(isSupportedLocalStorePath(path)).toBe(false);
  });
});

describe('localVaultTargetError', () => {
  it('refuses the SMB share vault type', () => {
    expect(localVaultTargetError({ vaultType: 'smb' })).toBe(SMB_VAULT_UNSUPPORTED_MESSAGE);
  });

  it.each(['local', 'usb'])('refuses a network share path for a %s vault', (vaultType) => {
    expect(localVaultTargetError({ vaultType, vaultPath: '\\\\nas\\vault' })).toBe(LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE);
  });

  it.each(['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Vault', '\\\\?\\C:\\Vault', 'Vault'])('refuses a vault path outside the accepted forms: %s', (vaultPath) => {
    expect(localVaultTargetError({ vaultType: 'local', vaultPath })).toBe(LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE);
  });

  it('accepts attached-disk vaults and writes that change neither type nor path', () => {
    expect(localVaultTargetError({ vaultType: 'local', vaultPath: 'D:\\Vault' })).toBeNull();
    expect(localVaultTargetError({ vaultType: 'usb', vaultPath: '/media/usb/vault' })).toBeNull();
    // The services pass whole update payloads; fields other than type and path are ignored.
    const deactivate: Record<string, unknown> = { isActive: false };
    const retention: Record<string, unknown> = { retentionCount: 4 };
    expect(localVaultTargetError(deactivate)).toBeNull();
    expect(localVaultTargetError(retention)).toBeNull();
  });

  it('throws a typed error from the assertion', () => {
    expect(() => assertSupportedLocalVaultTarget({ vaultType: 'smb' })).toThrow(UnsupportedLocalStoreTargetError);
    expect(() => assertSupportedLocalVaultTarget({ vaultPath: '//nas/vault' })).toThrow(LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE);
    expect(() => assertSupportedLocalVaultTarget({ vaultType: 'usb', vaultPath: 'E:\\Vault' })).not.toThrow();
  });
});

describe('localDestinationTargetError', () => {
  it('refuses a local destination on a network share', () => {
    expect(localDestinationTargetError('local', { path: '\\\\nas\\breeze' })).toBe(LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE);
    expect(() => assertSupportedBackupDestination({ provider: 'local', providerConfig: { path: '//nas/breeze' } }))
      .toThrow(UnsupportedLocalStoreTargetError);
  });

  it.each(['\\\\.\\D:\\BreezeBackups', '\\\\?\\GLOBALROOT\\Device\\WebDavRedirector\\nas', 'backups', ''])('refuses a local destination path outside the accepted forms: %j', (path) => {
    expect(localDestinationTargetError('local', { path })).toBe(LOCAL_STORE_PATH_UNSUPPORTED_MESSAGE);
  });

  // The agent decodes the settings with case-insensitive key matching, so a
  // second spelling of "path" would reach it unchecked.
  it.each([
    [{ Path: '\\\\nas\\x' }],
    [{ PATH: '\\\\nas\\x' }],
    [{ path: '/var/backups/breeze', Path: '\\\\nas\\x' }],
    [{ pAtH: 'D:\\Backups' }],
  ])('refuses a local destination whose path key is not exactly "path": %j', (providerConfig) => {
    expect(localDestinationTargetError('local', providerConfig)).not.toBeNull();
  });

  it.each([[{}], [{ path: 42 }], [{ path: null }], [null], [undefined], [[]]])('refuses a local destination without a string path: %j', (providerConfig) => {
    expect(localDestinationTargetError('local', providerConfig)).not.toBeNull();
  });

  it('accepts attached-disk local destinations and other providers', () => {
    expect(localDestinationTargetError('local', { path: '/var/backups/breeze' })).toBeNull();
    expect(localDestinationTargetError('local', { path: 'D:\\BreezeBackups' })).toBeNull();
    expect(localDestinationTargetError('s3', { path: '\\\\nas\\breeze', bucket: 'b' })).toBeNull();
  });
});
