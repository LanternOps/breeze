import { decryptSecret, isEncryptedSecret } from './secretCrypto';
import {
  columnAad,
  isSecretJsonKey,
  isSecretJsonPath,
  transformEncryptedColumnValue,
  type EncryptedColumnSpec,
} from './encryptedColumnTransform';

/**
 * At-rest sealing for `backup_configs.provider_config`.
 *
 * The column is a Drizzle custom type (db/schema/backup.ts) that seals on the
 * way to the database and opens on the way back, so every Drizzle reader —
 * dispatch, storage sessions, connection tests, credential history, recovery
 * media — sees the same plaintext object it always did, and every Drizzle
 * writer stores ciphertext without doing anything. The column is also in the
 * encrypted-column registry (encryptedColumnRegistry.ts), so key rotation
 * re-seals it like every other registered secret.
 *
 * Pool-free on purpose: imported by the schema module, so it must not import
 * the database.
 */

// Field names (case and punctuation ignored) that hold a credential in any
// provider's config. S3: accessKey/accessKeyId, secretKey/secretAccessKey,
// sessionToken. Azure Blob: accountKey (agent alias `key`), sasToken,
// connectionString. Google Cloud: credentialsJson / credentials (string or the
// service-account object). Backblaze B2: applicationKey (agent alias appKey).
// The same set drives response masking (backupProviderConfigSecrets.ts), so a
// field sealed at rest is always masked on read.
const SECRET_FIELD_NAMES = new Set([
  'accesskey',
  'accesskeyid',
  'accountkey',
  'apikey',
  'apisecret',
  'appkey',
  'applicationkey',
  'authtoken',
  'clientsecret',
  'connectionstring',
  'credential',
  'credentials',
  'credentialsjson',
  'encryptionkey',
  'key',
  'password',
  'privatekey',
  'sastoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'sessiontoken',
  'token',
]);

export function isSecretField(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return SECRET_FIELD_NAMES.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    // The names every registered JSON column seals (encryptedColumnTransform),
    // so nothing is sealed at rest that a response would show unmasked.
    || isSecretJsonKey(key);
}

/**
 * A leaf is secret when any key on its path is a secret field — so a secret
 * held as an object (a GCS service-account key) has every string inside it
 * sealed, not just leaves that happen to carry a secret-sounding name.
 */
export function isBackupProviderSecretPath(path: readonly string[]): boolean {
  return path.some(isSecretField);
}

export const BACKUP_PROVIDER_CONFIG_COLUMN: EncryptedColumnSpec = {
  table: 'backup_configs',
  column: 'provider_config',
  kind: 'json',
  isSecretLeaf: isBackupProviderSecretPath,
  description: 'backup destination credentials inside the provider config (S3 key pair and session token, Azure account key, GCS service-account JSON, B2 application key)',
};

const AAD = columnAad(BACKUP_PROVIDER_CONFIG_COLUMN);

export class BackupProviderConfigSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupProviderConfigSealError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapStrings(
  value: unknown,
  path: readonly string[],
  fn: (leaf: string, path: readonly string[]) => string,
): unknown {
  if (typeof value === 'string') return fn(value, path);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, path, fn));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, [...path, key], fn)]),
    );
  }
  return value;
}

function someString(
  value: unknown,
  path: readonly string[],
  test: (leaf: string, path: readonly string[]) => boolean,
): readonly string[] | null {
  if (typeof value === 'string') return test(value, path) ? path : null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = someString(entry, path, test);
      if (hit) return hit;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const hit = someString(entry, [...path, key], test);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The path of a value that is already in the stored ciphertext format, or
 * null. A config arriving from a caller is plaintext by construction (reads
 * open every sealed value), so a ciphertext-shaped value there was supplied
 * by someone — and storing it would have the server decrypt it on their
 * behalf and send the result to a destination they choose.
 */
export function findCiphertextShapedValue(value: unknown): string | null {
  const hit = someString(value, [], (leaf) => isEncryptedSecret(leaf));
  return hit ? (hit.length > 0 ? hit.join('.') : '(root)') : null;
}

function isSealablePath(path: readonly string[]): boolean {
  return isSecretJsonPath(path) || isBackupProviderSecretPath(path);
}

/** Whether a STORED value still holds a secret that is not ciphertext. */
export function holdsUnsealedBackupProviderSecret(stored: unknown): boolean {
  return someString(stored, [], (leaf, path) => leaf.length > 0 && !isEncryptedSecret(leaf) && isSealablePath(path)) !== null;
}

/**
 * Plaintext config (what callers hold) → stored form. Refuses a value that is
 * already ciphertext-shaped (see findCiphertextShapedValue).
 */
export function sealBackupProviderConfig(value: unknown): unknown {
  const presealed = findCiphertextShapedValue(value);
  if (presealed) {
    throw new BackupProviderConfigSealError(
      `backup destination setting "${presealed}" cannot be stored: the value is in an internal encrypted format`,
    );
  }
  return transformEncryptedColumnValue(BACKUP_PROVIDER_CONFIG_COLUMN, value);
}

/**
 * Stored form → stored form with every unsealed secret sealed. Used by the
 * backfill over rows written before the column was sealed; values already
 * sealed are kept (or re-sealed under the active key, exactly as the
 * rotation walker would).
 */
export function sealStoredBackupProviderConfig(stored: unknown): unknown {
  return transformEncryptedColumnValue(BACKUP_PROVIDER_CONFIG_COLUMN, stored);
}

/**
 * Stored form → plaintext config. Opens every sealed value, whatever its key
 * id or format version; plaintext (a row the backfill has not reached yet)
 * passes through unchanged.
 */
export function openBackupProviderConfig(stored: unknown): unknown {
  return mapStrings(stored, [], (leaf) => (isEncryptedSecret(leaf) ? decryptSecret(leaf, { aad: AAD }) ?? '' : leaf));
}
