import { coveAdapter } from './cove/adapter';
import type { BackupProviderAdapter } from './types';

/**
 * Every backup vendor Breeze can talk to. `backup_provider_connections.provider`
 * is a plain varchar rather than a pg enum precisely so this list — not a
 * migration — is the single place a vendor is added.
 */
export const BACKUP_PROVIDER_KEYS = ['cove'] as const;

export type BackupProviderKey = (typeof BACKUP_PROVIDER_KEYS)[number];

const ADAPTERS: Record<BackupProviderKey, BackupProviderAdapter> = {
  cove: coveAdapter,
};

export function isBackupProviderKey(key: string): key is BackupProviderKey {
  return (BACKUP_PROVIDER_KEYS as readonly string[]).includes(key);
}

/**
 * The adapter for `key`, or a loud throw.
 *
 * Throwing rather than returning undefined is deliberate: the caller is either
 * a route validating operator input (which turns this into a 400) or the sync
 * worker reading a stored `provider` value (where a silent undefined becomes
 * `undefined.listDevices is not a function` three frames deeper, after the
 * connection has already been marked `running`).
 *
 * The membership test goes through `isBackupProviderKey`, not a bare
 * `ADAPTERS[key]`, so an inherited key like `__proto__` or `constructor` can
 * never resolve to something callable.
 */
export function getBackupProvider(key: string): BackupProviderAdapter {
  if (!isBackupProviderKey(key)) {
    throw new Error(
      `Unknown backup provider "${key}" (registered: ${BACKUP_PROVIDER_KEYS.join(', ')})`,
    );
  }
  return ADAPTERS[key];
}

export function listBackupProviders(): BackupProviderAdapter[] {
  return BACKUP_PROVIDER_KEYS.map((key) => ADAPTERS[key]);
}
