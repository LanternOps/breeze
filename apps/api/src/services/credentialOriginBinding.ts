import { isEncryptedSecret } from './secretCrypto';

/**
 * Whether replacing one HTTP(S) endpoint with another crosses an origin
 * boundary. URL.origin normalizes host case and default ports while retaining
 * scheme and non-default port, which are all part of the credential receiver.
 * Malformed stored values fail closed as a changed origin.
 */
export function urlOriginChanged(current: string, next: string): boolean {
  try {
    const currentUrl = new URL(current);
    const nextUrl = new URL(next);
    if (!['http:', 'https:'].includes(currentUrl.protocol)) return true;
    if (!['http:', 'https:'].includes(nextUrl.protocol)) return true;
    return currentUrl.origin !== nextUrl.origin;
  } catch {
    return true;
  }
}

/**
 * Whether `next` contains any member `existing` does not have (trimmed,
 * exact-match comparison). For destination shapes that are a SET of hosts
 * rather than one URL — a discovery profile's `subnets`, for instance, where
 * "the destination" is everything the job probes — a credential must not
 * follow the set to a member it has never reached before. Removing members
 * only narrows the destination, so it is never itself a change: a PATCH that
 * drops subnets sends the stored secret nowhere new and needs no
 * re-confirmation, mirroring `urlOriginChanged`'s single-URL contract.
 */
export function destinationSetGainedMembers(existing: readonly string[], next: readonly string[]): boolean {
  const existingSet = new Set(existing.map((value) => value.trim()));
  return next.some((value) => !existingSet.has(value.trim()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headerValues(headers: unknown): unknown[] {
  if (Array.isArray(headers)) {
    return headers.flatMap((entry) => isRecord(entry) && 'value' in entry ? [entry.value] : []);
  }
  return isRecord(headers) ? Object.values(headers) : [];
}

export function webhookOriginChangeWouldRetainAuthorization(
  existing: unknown,
  patch: unknown,
  isMaskedSecret: (value: unknown) => boolean,
): boolean {
  if (!isRecord(existing) || !isRecord(patch)) return false;
  if (typeof patch.url !== 'string') return false;
  // A masked url is the edit form sending back the value it was shown. The
  // config merge (encryptNotificationChannelConfig) replaces it with the stored
  // url, so the destination is unchanged (#4983). Without this, new URL() on
  // the mask throws and every untouched save reads as an origin change. With no
  // stored url there is nothing to keep, so that case still fails closed below.
  if (isMaskedSecret(patch.url) && typeof existing.url === 'string') return false;

  // A schemaless/legacy channel can contain authorization material without a
  // valid stored destination. Supplying its first usable URL establishes a new
  // receiver; it must not inherit credentials from an unknown prior origin.
  // Malformed string URLs remain fail-closed through urlOriginChanged().
  const originChanged = typeof existing.url !== 'string'
    || urlOriginChanged(existing.url, patch.url);
  if (!originChanged) return false;

  for (const key of ['authToken', 'authPassword', 'apiKeyValue']) {
    if (existing[key] && (!(key in patch) || isMaskedSecret(patch[key]))) return true;
  }
  const existingHeaders = headerValues(existing.headers);
  if (existingHeaders.length > 0 && !('headers' in patch)) return true;
  return headerValues(patch.headers).some(isMaskedSecret);
}

/**
 * Whether a remote-access launcher `urlTemplate` now points somewhere else.
 * Templates carry `{id}`/`{password}` placeholders and may use a custom
 * scheme (`rustdesk://{id}?password={password}`), so this compares scheme,
 * host and port of the template with every placeholder replaced by the same
 * constant — a placeholder in the host position compares equal to itself.
 * An unchanged template is never a change; an unparseable one fails closed.
 */
export function launcherTemplateOriginChanged(current: string, next: string): boolean {
  if (current === next) return false;
  const parse = (template: string) => new URL(template.replace(/\{[^{}]*\}/g, 'placeholder'));
  try {
    const currentUrl = parse(current);
    const nextUrl = parse(next);
    return currentUrl.protocol !== nextUrl.protocol
      || currentUrl.hostname.toLowerCase() !== nextUrl.hostname.toLowerCase()
      || currentUrl.port !== nextUrl.port;
  } catch {
    return true;
  }
}

export interface SettingsSecretDestination {
  /**
   * Path of the object holding the destination URL and its credentials — or,
   * with `entryIdKey`, of a list of such objects.
   */
  path: readonly string[];
  urlKey: string;
  secretKeys: readonly string[];
  /**
   * The value at `path` is a list of destination entries. Each incoming entry
   * is compared with the stored entry carrying the same value under this key
   * (by position when it has none), the same matching
   * `restoreMaskedSettingsSecrets` uses to decide which stored secret it keeps.
   */
  entryIdKey?: string;
  /** Destination comparison; defaults to `urlOriginChanged`. */
  originChanged?: (current: string, next: string) => boolean;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Origin binding for a secret kept inside a settings JSON blob: true when the
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
  isMaskedSecret: (value: unknown) => boolean,
): boolean {
  for (const destination of destinations) {
    const next = valueAt(incoming, destination.path);
    const current = valueAt(stored, destination.path);
    if (destination.entryIdKey !== undefined) {
      if (!Array.isArray(next)) continue;
      const idKey = destination.entryIdKey;
      const storedEntries = Array.isArray(current) ? current : [];
      const followsNewOrigin = next.some((entry, index) => {
        const id = isRecord(entry) ? entry[idKey] : undefined;
        const storedEntry = typeof id === 'string' && id.length > 0
          ? storedEntries.find((candidate) => isRecord(candidate) && candidate[idKey] === id)
          : storedEntries[index];
        return entryFollowsNewOrigin(entry, storedEntry, destination, isMaskedSecret);
      });
      if (followsNewOrigin) return true;
      continue;
    }
    if (entryFollowsNewOrigin(next, current, destination, isMaskedSecret)) return true;
  }
  return false;
}

function entryFollowsNewOrigin(
  next: unknown,
  current: unknown,
  destination: SettingsSecretDestination,
  isMaskedSecret: (value: unknown) => boolean,
): boolean {
  if (!isRecord(next)) return false;
  const nextUrl = next[destination.urlKey];
  if (typeof nextUrl !== 'string' || nextUrl.trim().length === 0) return false;

  const currentRecord = isRecord(current) ? current : {};
  const currentUrl = currentRecord[destination.urlKey];

  const carriesStoredSecret = destination.secretKeys.some((secretKey) => {
    const storedSecret = currentRecord[secretKey];
    if (typeof storedSecret !== 'string' || storedSecret.length === 0) return false;
    if (!(secretKey in next) || next[secretKey] === undefined || next[secretKey] === null) return true;
    const value = next[secretKey];
    return isMaskedSecret(value) || (typeof value === 'string' && isEncryptedSecret(value));
  });
  if (!carriesStoredSecret) return false;

  const originChanged = destination.originChanged ?? urlOriginChanged;
  return typeof currentUrl !== 'string' || originChanged(currentUrl, nextUrl);
}
