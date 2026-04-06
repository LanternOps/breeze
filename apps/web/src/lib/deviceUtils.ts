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
