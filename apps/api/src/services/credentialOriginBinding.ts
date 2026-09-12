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
