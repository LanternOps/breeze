/**
 * Increment the last numeric segment of a version string, preserving any
 * suffix and zero-padding: "1.2.3" → "1.2.4", "1.0.0-beta2" → "1.0.0-beta3",
 * "1.09" → "1.10". Returns "" when the string contains no digits — the caller
 * should leave the field for the user to fill in.
 */
export function bumpVersionString(version: string): string {
  const match = version.trim().match(/^(.*?)(\d+)(\D*)$/s);
  if (!match) return "";
  const [, prefix, digits, suffix] = match;
  const bumped = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${prefix}${bumped}${suffix}`;
}
