import { createHash } from 'node:crypto';

/**
 * Canonical form for change detection (spec §5.4): object keys sorted, arrays
 * sorted by each element's own canonical string, `undefined` normalised to
 * null.
 *
 * Sorting arrays by canonical string handles both cases the spec names —
 * arrays of primitives and arrays of objects — with one rule, so a role list
 * and a sku-id list cannot drift apart in behaviour. It is a deliberate
 * *semantic* choice, not just a stabiliser: Graph returns these collections in
 * an order it does not promise, so an order-sensitive hash would rewrite every
 * row on every run and destroy the "steady-state writes ~= 0" property this
 * whole design rests on.
 *
 * Only JSON-primitive leaves may appear here. Projections are executor JSON,
 * so a Date or a Map would be a bug; both would canonicalise to `{}` and
 * silently collapse distinct values, which is why nothing in this module
 * accepts a row object straight off Drizzle.
 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((a, b) => {
        const left = stableKey(a);
        const right = stableKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 hex of the canonical projection. 64 lowercase hex chars, matching `core_hash char(64)`. */
export function canonicalHash(record: Record<string, unknown>): string {
  return createHash('sha256').update(stableKey(canonicalize(record))).digest('hex');
}
