/**
 * The flow event trigger's filter match (spec §6.1), a leaf module so callers
 * that only compare a filter (the W06 conversion shadow) do not load the
 * trigger subscriber and the run service. `eventTrigger.ts` re-exports it.
 */

/**
 * Path segments that never match, own property or not: every Object.prototype
 * member name (`__proto__`, `constructor`, `toString`, `hasOwnProperty`, …)
 * and `prototype`. Refusing them outright (rather than "missing ⇒ null
 * matches") means a filter naming one can never be satisfied by accident.
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

export function isPlainContainer(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * The trigger filter (spec §6.1): every key is a dot path into the payload,
 * walked through OWN properties only; the value must be strictly equal, and
 * `null` matches a missing or null value. A path naming an Object.prototype
 * member (`__proto__`, `constructor`, `toString`, …) or `prototype` never
 * matches, and nothing inherited is ever read (`length` of a string is not
 * data) — a filter can only ever see data the event actually carried.
 */
export function eventMatchesFilter(filter: Record<string, string | number | boolean | null>, payload: unknown): boolean {
  for (const [path, expected] of Object.entries(filter)) {
    const segments = path.split('.');
    if (segments.some((seg) => seg.length === 0 || FORBIDDEN_SEGMENTS.has(seg))) return false;
    let current: unknown = payload;
    let found = true;
    for (const seg of segments) {
      if (!isPlainContainer(current) || !Object.hasOwn(current, seg)) {
        found = false;
        break;
      }
      current = (current as Record<string, unknown>)[seg];
    }
    const actual = found ? current : undefined;
    if (expected === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}
