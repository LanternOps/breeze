import { isSecretJsonKey } from './encryptedColumnRegistry';
import { urlOriginChanged } from './credentialOriginBinding';
import { INTEGRATION_MASKED_SECRET } from './integrationSettingsSecrets';
import { isMaskedIntegrationSecret } from './notificationChannelSecrets';
import { isEncryptedSecret } from './secretCrypto';

/**
 * Response masking and write-side resolution for the registered `settings`
 * JSON columns (`organizations.settings`, `partners.settings`,
 * `sites.settings` — see encryptedColumnRegistry.ts).
 *
 * Those columns seal every `SECRET_JSON_KEYS` value at rest. A response must
 * never carry the sealed value (or a plaintext one from a row written before
 * sealing): it carries the shared masked marker instead, the same
 * `'********'` string the integration, SNMP and notification-channel editors
 * already use. The editors send that marker back on save, and
 * `restoreMaskedSettingsSecrets` swaps it for the stored value before the
 * write.
 *
 * Write contract for a secret leaf, per path:
 *   - masked marker, or key omitted from a present parent object → keep stored
 *   - empty string                                           → clear
 *   - any other plaintext                                    → replace
 *   - sealed value identical to the stored one               → keep (a page
 *     loaded before responses were masked still saves)
 *   - any other sealed value                                 → refused; a
 *     client never legitimately holds ciphertext it was not given
 */

export const MASKED_SETTINGS_SECRET = INTEGRATION_MASKED_SECRET;

export class SettingsSecretInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsSecretInputError';
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSecretLeaf(key: string | undefined, value: string): boolean {
  return isEncryptedSecret(value) || (key !== undefined && isSecretJsonKey(key));
}

function isMaskedMarker(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isMaskedIntegrationSecret(value);
}

/** Replace every secret value in a settings blob with the masked marker. */
export function maskSettingsSecrets(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return value.length > 0 && isSecretLeaf(key, value) ? MASKED_SETTINGS_SECRET : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskSettingsSecrets(entry, key));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, maskSettingsSecrets(entryValue, entryKey)]),
    );
  }
  return value;
}

/** A row (organization, partner, site) with its `settings` column masked. */
export function withMaskedSettings<T>(row: T): T {
  if (!isRecord(row) || !('settings' in row)) return row;
  return { ...row, settings: maskSettingsSecrets(row.settings) } as T;
}

function entryId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined;
}

function storedArrayEntry(stored: unknown, entry: unknown, index: number): unknown {
  if (!Array.isArray(stored)) return undefined;
  const id = entryId(entry);
  // Entries that carry an id are matched by it, so reordering a list cannot
  // attach one entry's secret to another.
  if (id !== undefined) return stored.find((candidate) => entryId(candidate) === id);
  return stored[index];
}

function restoreLeaf(incoming: string, stored: unknown, key: string | undefined, path: string): string | undefined {
  const storedSecret = typeof stored === 'string' && stored.length > 0 && isSecretLeaf(key, stored)
    ? stored
    : undefined;

  if (isEncryptedSecret(incoming)) {
    if (incoming === stored) return incoming;
    throw new SettingsSecretInputError(`settings.${path} must be re-entered, not submitted as a sealed value`);
  }
  if (isMaskedMarker(incoming) && (storedSecret !== undefined || (key !== undefined && isSecretJsonKey(key)))) {
    // No stored secret behind the marker: nothing to keep, so the key is dropped.
    return storedSecret;
  }
  return incoming;
}

function restoreValue(incoming: unknown, stored: unknown, key: string | undefined, path: string): unknown {
  if (typeof incoming === 'string') return restoreLeaf(incoming, stored, key, path);

  if (Array.isArray(incoming)) {
    return incoming.map((entry, index) =>
      restoreValue(entry, storedArrayEntry(stored, entry, index), key, `${path}[${index}]`),
    );
  }

  if (isRecord(incoming)) {
    const storedRecord = isRecord(stored) ? stored : {};
    const result: JsonRecord = {};
    for (const [entryKey, entryValue] of Object.entries(incoming)) {
      result[entryKey] = restoreValue(entryValue, storedRecord[entryKey], entryKey, path ? `${path}.${entryKey}` : entryKey);
    }
    // A secret the client left out of an object it did send is kept.
    for (const [entryKey, storedValue] of Object.entries(storedRecord)) {
      if (entryKey in incoming) continue;
      if (typeof storedValue === 'string' && storedValue.length > 0 && isSecretJsonKey(entryKey)) {
        result[entryKey] = storedValue;
      }
    }
    return result;
  }

  return incoming;
}

/**
 * Resolve masked markers (and omitted secret keys) in an incoming settings
 * value against the stored one, so the write keeps the stored secret.
 * Throws `SettingsSecretInputError` for a sealed value that is not the stored
 * one at that path.
 */
export function restoreMaskedSettingsSecrets(incoming: unknown, stored: unknown): unknown {
  return restoreValue(incoming, stored, undefined, '');
}

export interface SettingsSecretDestination {
  /** Path of the object holding the destination URL and its credentials. */
  path: readonly string[];
  urlKey: string;
  secretKeys: readonly string[];
}

/** Log-forwarding credentials and the endpoint they are sent to. */
export const LOG_FORWARDING_SECRET_DESTINATIONS: readonly SettingsSecretDestination[] = [
  { path: ['eventLogs'], urlKey: 'elasticsearchUrl', secretKeys: ['elasticsearchApiKey', 'elasticsearchPassword'] },
  { path: ['logForwarding'], urlKey: 'elasticsearchUrl', secretKeys: ['elasticsearchApiKey', 'elasticsearchPassword'] },
];

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Same origin-binding contract as credentialOriginBinding.ts: true when the
 * incoming settings point a destination at a different origin while a stored
 * credential for it would be kept (masked marker, omitted key, or the sealed
 * value echoed back) rather than entered again. A stored credential with no
 * recorded destination fails closed. Evaluate on the raw request, before
 * `restoreMaskedSettingsSecrets`.
 */
export function settingsSecretWouldFollowNewOrigin(
  incoming: unknown,
  stored: unknown,
  destinations: readonly SettingsSecretDestination[],
): boolean {
  for (const destination of destinations) {
    const next = valueAt(incoming, destination.path);
    if (!isRecord(next)) continue;
    const nextUrl = next[destination.urlKey];
    if (typeof nextUrl !== 'string' || nextUrl.trim().length === 0) continue;

    const current = valueAt(stored, destination.path);
    const currentRecord = isRecord(current) ? current : {};
    const currentUrl = currentRecord[destination.urlKey];

    const carriesStoredSecret = destination.secretKeys.some((secretKey) => {
      const storedSecret = currentRecord[secretKey];
      if (typeof storedSecret !== 'string' || storedSecret.length === 0) return false;
      if (!(secretKey in next) || next[secretKey] === undefined || next[secretKey] === null) return true;
      const value = next[secretKey];
      return isMaskedMarker(value) || (typeof value === 'string' && isEncryptedSecret(value));
    });
    if (!carriesStoredSecret) continue;

    if (typeof currentUrl !== 'string' || urlOriginChanged(currentUrl, nextUrl)) return true;
  }
  return false;
}

export const LOG_FORWARDING_ORIGIN_CHANGE_MESSAGE =
  'Changing the log-forwarding destination requires re-entering the API key or password';
