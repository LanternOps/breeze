/**
 * Increment the last numeric segment of a version string, preserving any
 * suffix and zero-padding: "1.2.3" → "1.2.4", "1.0.0-beta2" → "1.0.0-beta3",
 * "1.09" → "1.10". Returns "" when the string contains no digits — the caller
 * should leave the field for the user to fill in.
 */
/**
 * Rewrite occurrences of the old version inside a carried-over download URL so
 * a prefilled "1.2.4" doesn't silently point at the 1.2.3 binary
 * (".../app-1.2.3.msi" → ".../app-1.2.4.msi"). When the URL doesn't embed the
 * version, it is returned unchanged — the user still sees it in the form.
 */
export function substituteVersionInUrl(
  url: string,
  oldVersion: string,
  newVersion: string,
): string {
  if (!url || !oldVersion || !newVersion || oldVersion === newVersion) return url;
  return url.split(oldVersion).join(newVersion);
}

export function bumpVersionString(version: string): string {
  const match = version.trim().match(/^(.*?)(\d+)(\D*)$/s);
  if (!match) return "";
  const [, prefix, digits, suffix] = match;
  const bumped = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${prefix}${bumped}${suffix}`;
}
