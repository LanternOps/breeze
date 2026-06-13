/** Safely cast unknown to a record for property access */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Parse unknown to a clamped 0-100 percent, returning 0 for invalid values */
export function toPercent(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;

  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, Number(parsed.toFixed(1))));
}

/** Parse unknown to a clamped 0-100 percent, returning null for invalid values */
export function toPercentNullable(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;

  if (!Number.isFinite(parsed)) return null;
  return Math.min(100, Math.max(0, Number(parsed.toFixed(2))));
}

/**
 * Normalize a raw `osVersion` string for the "OS Version" display column/row.
 *
 * The agent reports `osVersion` as gopsutil's `Platform + " " + PlatformVersion`.
 * On Windows, `PlatformVersion` embeds the build number (and often a redundant
 * `Build NNNNN` suffix), so the raw string looks like
 * `"Microsoft Windows 11 Pro 10.0.22631 Build 22631"`. That build also lives in
 * the separate `osBuild` field, so showing it inside OS Version is duplicative
 * (issue #1302). This strips the embedded Windows build artifacts, leaving the
 * marketing name (e.g. `"Microsoft Windows 11 Pro"`).
 *
 * macOS/Linux versions are plain marketing versions (e.g. `"26.3.1"`) and are
 * left intact aside from stripping a leading kernel name (`darwin`/`linux`).
 *
 * @param raw       the raw osVersion string
 * @param fallback  value returned when `raw` is empty/whitespace (default "—")
 */
export function formatOsVersionForDisplay(
  raw: string | null | undefined,
  fallback = '—',
): string {
  if (!raw || !raw.trim()) return fallback;

  // Strip kernel name prefix (e.g. "darwin 26.3.1" → "26.3.1").
  let v = raw.replace(/^(darwin|linux)\s+/i, '').trim();

  // Strip a trailing Windows build clause: an optional dotted build version
  // (e.g. "10.0.22631", "10.0.26200.7623") optionally followed by a redundant
  // "Build NNNNN[.NNNN]" suffix — or a standalone "Build NNNNN[.NNNN]". This
  // intentionally requires the dotted number to have 3+ segments so plain
  // macOS/Linux versions like "26.3.1" or "10.15" are preserved.
  const stripped = v
    .replace(/\s+\d+\.\d+\.\d+(?:\.\d+)*(?:\s+Build\s+[\d.]+)?\s*$/i, '')
    .replace(/\s+Build\s+[\d.]+\s*$/i, '')
    .trim();

  // If stripping removed everything (e.g. osVersion was just a bare build like
  // "10.0.20348"), fall back to the kernel-stripped value rather than blank.
  return stripped || v;
}
