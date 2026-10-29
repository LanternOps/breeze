/**
 * Compare two dotted version strings numerically, segment by segment
 * (missing trailing segments count as 0). Deliberately NOT a lexicographic
 * string comparison: '10.10' < '10.2' lexicographically but is numerically
 * greater, which would make a 'version_below' check breach on a device that
 * is actually up to date.
 *
 * Returns -1/0/1, or `null` if either version has a non-numeric segment —
 * callers must not guess in that case.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const aRaw = aParts[i] ?? '0';
    const bRaw = bParts[i] ?? '0';
    if (!/^\d+$/.test(aRaw) || !/^\d+$/.test(bRaw)) {
      return null;
    }
    const aNum = Number.parseInt(aRaw, 10);
    const bNum = Number.parseInt(bRaw, 10);
    if (aNum !== bNum) {
      return aNum < bNum ? -1 : 1;
    }
  }
  return 0;
}


/**
 * Numeric key for inventory versions. Keep this rule aligned with
 * softwareVersionKeySql in filterEngine: optional v/V, leading dotted numeric
 * prefix only, and no trailing zero segments. Canonical decimal strings avoid
 * losing precision on long vendor build numbers.
 */
export function normalizeSoftwareVersion(version: string | null | undefined): string[] | null {
  if (typeof version !== 'string') return null;
  const prefix = /^[vV]?(\d+(?:\.\d+)*)/.exec(version.trim())?.[1];
  if (prefix === undefined) return null;

  const segments = prefix.split('.').map((segment) => segment.replace(/^0+(?=\d)/, ''));
  while (segments.length > 1 && segments[segments.length - 1] === '0') {
    segments.pop();
  }
  return segments;
}

/** Compare inventory version keys with arbitrary-length integer segments. */
export function compareSoftwareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): -1 | 0 | 1 | null {
  const aParts = normalizeSoftwareVersion(a);
  const bParts = normalizeSoftwareVersion(b);
  if (aParts === null || bParts === null) return null;

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] ?? '0';
    const bPart = bParts[i] ?? '0';
    if (aPart.length !== bPart.length) return aPart.length < bPart.length ? -1 : 1;
    if (aPart !== bPart) return aPart < bPart ? -1 : 1;
  }
  return 0;
}
