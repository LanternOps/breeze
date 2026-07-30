/**
 * Canonical JSON serialization and digesting for approval-bound arguments.
 *
 * This module is the SINGLE canonicalizer for the action-intent chain. It lives in
 * `@breeze/shared` rather than in the API because more than one process has to agree
 * on the bytes: the API computes the digest an approver signs off on, and an executor
 * recomputes it from the request it received before touching any credential. If either
 * side reimplements this, the digest check silently degrades from a binding check into
 * a self-consistency check that always passes. `./vectors` exists to make that drift
 * fail loudly — see the note there.
 *
 * Exposed as the `@breeze/shared/canonicalize` subpath and deliberately NOT re-exported
 * from the package root: `computeArgumentDigest` pulls in `node:crypto`, and the root
 * barrel is bundled into the browser via `apps/web`.
 */
import { createHash } from 'node:crypto';

function sortValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError('argument value is not JSON-serializable');
    }
    return value;
  }
  if (seen.has(value as object)) throw new TypeError('circular argument structure');
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((item) => sortValue(item, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortValue(item, seen);
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

export function canonicalizeArguments(input: Record<string, unknown>): string {
  return JSON.stringify(sortValue(input, new WeakSet()));
}

export function computeArgumentDigest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
