import { isDeepStrictEqual } from 'node:util';
import { launcherTemplateOriginChanged, type SettingsSecretDestination } from './credentialOriginBinding';
import { isSettingsSecretPath } from './encryptedColumnRegistry';
import { INTEGRATION_MASKED_SECRET } from './integrationSettingsSecrets';
import { isMaskedIntegrationSecret } from './notificationChannelSecrets';
import { hmacFingerprint, isEncryptedSecret } from './secretCrypto';

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
 * A list of secret strings (`notifications.webhooks`) has no entry ids, so
 * each entry is masked as a keyed marker, `********:<key>`, where the key is
 * an HMAC of the stored entry: it names the entry without revealing it, and
 * does not depend on its position. The editor sends back the keyed markers of
 * the entries it keeps, leaves out the ones it removes, and appends typed
 * ones. A keyed marker whose entry is no longer stored — the list changed
 * since the page loaded — is refused, as is a bare marker, which cannot say
 * which entry it keeps.
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

const LIST_ENTRY_KEY_LENGTH = 16;
const KEYED_MARKER = /^\*+:([0-9a-f]+)$/;

/** Names a stored list entry without revealing it (see the module comment). */
function listEntryKey(stored: string): string {
  return hmacFingerprint(`settings-secret-list-entry:${stored}`).slice(-LIST_ENTRY_KEY_LENGTH);
}

function keyedMarker(stored: string): string {
  return `${MASKED_SETTINGS_SECRET}:${listEntryKey(stored)}`;
}

function maskAt(value: unknown, path: JsonPath): unknown {
  if (typeof value === 'string') {
    return value.length > 0 && isSecretLeaf(path, value) ? MASKED_SETTINGS_SECRET : value;
  }
  if (Array.isArray(value)) {
    if (isSettingsSecretPath(path)) {
      return value.map((entry) => (typeof entry === 'string'
        ? (entry.length > 0 ? keyedMarker(entry) : entry)
        : maskAt(entry, path)));
    }
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
 * A list of secret strings, matched by keyed marker (see the module comment):
 * a keyed marker keeps the stored entry it names, a typed value is added, and
 * an entry left out (or sent empty) is removed.
 */
function restoreSecretStringList(incoming: unknown[], stored: unknown, path: JsonPath, label: string): unknown[] {
  const storedEntries = (Array.isArray(stored) ? stored : [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  const byKey = new Map(storedEntries.map((entry) => [listEntryKey(entry), entry]));
  const changed = () => new SettingsSecretInputError(`settings.${label} changed since it was loaded; reload and save again`);

  const result: unknown[] = [];
  incoming.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      result.push(restoreValue(entry, undefined, path, `${label}[${index}]`));
      return;
    }
    if (entry.length === 0) return;
    const keyed = KEYED_MARKER.exec(entry);
    if (keyed) {
      const kept = byKey.get(keyed[1]!);
      if (kept === undefined) throw changed();
      result.push(kept);
      return;
    }
    if (isMaskedMarker(entry)) throw changed();
    if (isEncryptedSecret(entry)) {
      // A page loaded before responses were masked echoes the stored value.
      if (!storedEntries.includes(entry)) {
        throw new SettingsSecretInputError(`settings.${label}[${index}] must be re-entered, not submitted as a sealed value`);
      }
      result.push(entry);
      return;
    }
    result.push(entry);
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

/**
 * Remote-access launcher passwords and the launcher they are substituted into
 * (`{password}` in `urlTemplate`). Providers are matched by id, as the restore
 * does; a kept password may not follow a template to a new scheme/host/port.
 */
export const REMOTE_ACCESS_LAUNCHER_SECRET_DESTINATIONS: readonly SettingsSecretDestination[] = [
  {
    path: ['remoteAccessProviders', 'providers'],
    entryIdKey: 'id',
    urlKey: 'urlTemplate',
    secretKeys: ['password'],
    originChanged: launcherTemplateOriginChanged,
  },
];

export const REMOTE_ACCESS_LAUNCHER_ORIGIN_CHANGE_MESSAGE =
  'Changing the host of a remote-access launcher URL requires re-entering its password';
