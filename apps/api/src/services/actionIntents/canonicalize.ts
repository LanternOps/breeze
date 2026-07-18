import { createHash } from 'crypto';

function sortValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError('argument value is not JSON-serializable');
    }
    return value;
  }
  if (seen.has(value as object)) throw new TypeError('circular argument structure');
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => sortValue(item, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = sortValue(item, seen);
  }
  return out;
}

export function canonicalizeArguments(input: Record<string, unknown>): string {
  return JSON.stringify(sortValue(input, new WeakSet()));
}

export function computeArgumentDigest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
