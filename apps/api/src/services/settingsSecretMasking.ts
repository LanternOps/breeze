import { isDeepStrictEqual } from 'node:util';
import type { SettingsSecretDestination } from './credentialOriginBinding';
import { isSettingsSecretPath } from './encryptedColumnRegistry';
import { INTEGRATION_MASKED_SECRET } from './integrationSettingsSecrets';
import { isMaskedIntegrationSecret } from './notificationChannelSecrets';
import { isEncryptedSecret } from './secretCrypto';

/**
 * Response masking and write-side resolution for the registered `settings`
 * JSON columns (`organizations.settings`, `partners.settings`,
 * `sites.settings` — see encryptedColumnRegistry.ts).
 *
 * Those columns seal every secret leaf at rest (a `SECRET_JSON_KEYS` name or a
 * `SETTINGS_SECRET_JSON_PATHS` path — `isSettingsSecretPath`). A response must
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
 *
 * A list of secret strings (`notifications.webhooks`) has no entry ids, so its
 * entries are matched by position: the editor keeps every saved entry in
 * place (the masked marker to keep it, an empty string to remove it) and
 * appends new ones. Removed entries are dropped from the stored list, and a
 * marker with no stored entry at its position is refused — the list changed
 * since the page loaded, and resolving it would keep the wrong entry.
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

type JsonPath = readonly string[];

function isSecretLeaf(path: JsonPath, value: string): boolean {
  return isEncryptedSecret(value) || isSettingsSecretPath(path);
}

function isMaskedMarker(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isMaskedIntegrationSecret(value);
}

function maskAt(value: unknown, path: JsonPath): unknown {
  if (typeof value === 'string') {
    return value.length > 0 && isSecretLeaf(path, value) ? MASKED_SETTINGS_SECRET : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskAt(entry, path));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, maskAt(entryValue, [...path, entryKey])]),
    );
  }
  return value;
}

/**
 * Replace every secret value in a settings blob (or the effective-settings
 * category map, which has the same shape) with the masked marker.
 */
export function maskSettingsSecrets(value: unknown): unknown {
  return maskAt(value, []);
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

function restoreLeaf(incoming: string, stored: unknown, path: JsonPath, label: string): string | undefined {
  const storedSecret = typeof stored === 'string' && stored.length > 0 && isSecretLeaf(path, stored)
    ? stored
    : undefined;

  if (isEncryptedSecret(incoming)) {
    if (incoming === stored) return incoming;
    throw new SettingsSecretInputError(`settings.${label} must be re-entered, not submitted as a sealed value`);
  }
  if (isMaskedMarker(incoming) && (storedSecret !== undefined || isSettingsSecretPath(path))) {
    // No stored secret behind the marker: nothing to keep, so the key is dropped.
    return storedSecret;
  }
  return incoming;
}

/**
 * A list of secret strings, matched by position (see the module comment):
 * a marker keeps the stored entry at its position, an empty string removes
 * it, a typed value replaces or appends.
 */
function restoreSecretStringList(incoming: unknown[], stored: unknown, path: JsonPath, label: string): unknown[] {
  const storedList = Array.isArray(stored) ? stored : [];
  const result: unknown[] = [];
  incoming.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (typeof entry !== 'string') {
      result.push(restoreValue(entry, storedList[index], path, entryLabel));
      return;
    }
    if (entry.length === 0) return;
    if (isMaskedMarker(entry) && typeof storedList[index] !== 'string') {
      throw new SettingsSecretInputError(`settings.${label} changed since it was loaded; reload and save again`);
    }
    const resolved = restoreLeaf(entry, storedList[index], path, entryLabel);
    if (resolved !== undefined && resolved.length > 0) result.push(resolved);
  });
  return result;
}

function isNonEmptySecretValue(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string');
}

function restoreValue(incoming: unknown, stored: unknown, path: JsonPath, label: string): unknown {
  if (typeof incoming === 'string') return restoreLeaf(incoming, stored, path, label);

  if (Array.isArray(incoming)) {
    if (isSettingsSecretPath(path)) return restoreSecretStringList(incoming, stored, path, label);
    return incoming.map((entry, index) =>
      restoreValue(entry, storedArrayEntry(stored, entry, index), path, `${label}[${index}]`),
    );
  }

  if (isRecord(incoming)) {
    const storedRecord = isRecord(stored) ? stored : {};
    const result: JsonRecord = {};
    for (const [entryKey, entryValue] of Object.entries(incoming)) {
      result[entryKey] = restoreValue(
        entryValue,
        storedRecord[entryKey],
        [...path, entryKey],
        label ? `${label}.${entryKey}` : entryKey,
      );
    }
    // A secret the client left out of an object it did send is kept.
    for (const [entryKey, storedValue] of Object.entries(storedRecord)) {
      if (entryKey in incoming) continue;
      if (isNonEmptySecretValue(storedValue) && isSettingsSecretPath([...path, entryKey])) {
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
 * one at that path, and for a secret list that changed since it was loaded.
 */
export function restoreMaskedSettingsSecrets(incoming: unknown, stored: unknown): unknown {
  return restoreValue(incoming, stored, [], '');
}

/**
 * Whether `incoming` for the settings field `category.field` leaves the stored
 * value exactly as it is — the masked marker (or a list of them) echoed back
 * for a stored secret. Such a value is not an attempt to change the field, so
 * a partner lock on it has nothing to refuse (services/effectiveSettings.ts).
 */
export function keepsStoredSettingsSecret(
  category: string,
  field: string,
  incoming: unknown,
  stored: unknown,
): boolean {
  if (!isSettingsSecretPath([category, field])) return false;
  try {
    const resolved = restoreMaskedSettingsSecrets({ [category]: { [field]: incoming } }, { [category]: { [field]: stored } });
    return isDeepStrictEqual((resolved as Record<string, JsonRecord>)[category]?.[field], stored);
  } catch (err) {
    if (err instanceof SettingsSecretInputError) return false;
    throw err;
  }
}

/** Log-forwarding credentials and the endpoint they are sent to. */
export const LOG_FORWARDING_SECRET_DESTINATIONS: readonly SettingsSecretDestination[] = [
  { path: ['eventLogs'], urlKey: 'elasticsearchUrl', secretKeys: ['elasticsearchApiKey', 'elasticsearchPassword'] },
  { path: ['logForwarding'], urlKey: 'elasticsearchUrl', secretKeys: ['elasticsearchApiKey', 'elasticsearchPassword'] },
];

export const LOG_FORWARDING_ORIGIN_CHANGE_MESSAGE =
  'Changing the log-forwarding destination requires re-entering the API key or password';
