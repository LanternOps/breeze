// Shared parser/writer for the dashboard click-through hash grammar
// (spec 2026-10-18 §3.2.1):
//
//   #<tab>[/<selection>][&<key>=<value>[,<value>…]]…
//
// - The tab token comes first and only counts when it is in `knownTabs`.
// - `/<selection>` is the sub-selection slot (`#cves/<groupKey>`).
// - Filters are `&`-joined `key=value` pairs; multi-value is comma-separated.
// - Parsers ignore unknown keys / invalid values and never throw.
// - Writers preserve every key they do not own.

export interface ParsedHash {
  tab: string | null;
  selection: string | null;
  params: Record<string, string[]>;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function stripHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

/** Split into the leading tab segment (no `=`) and the `k=v` segments. */
function splitSegments(raw: string, knownTabs: readonly string[]): {
  tab: string | null;
  selection: string | null;
  rest: string[];
} {
  const parts = raw.split('&');
  const first = parts[0] ?? '';
  let tab: string | null = null;
  let selection: string | null = null;
  let rest = parts;
  if (first && !first.includes('=')) {
    const slash = first.indexOf('/');
    const tabToken = safeDecode(slash === -1 ? first : first.slice(0, slash));
    if (knownTabs.includes(tabToken)) {
      tab = tabToken;
      if (slash !== -1) {
        const sel = safeDecode(first.slice(slash + 1));
        selection = sel === '' ? null : sel;
      }
      rest = parts.slice(1);
    }
  }
  return { tab, selection, rest };
}

// Keys that must never become property names on the parsed container are
// rejected inline below with explicit comparisons (not a Set lookup) so static
// analysis recognises the guard; the container is also prototype-less.

// Materialise the parsed params as a prototype-less record. Accumulating in a
// Map (not `record[key] = …`) keeps user-controlled keys away from dynamic
// property writes; the reserved-key skip above is defence in depth.
function toNullProtoRecord(map: ReadonlyMap<string, string[]>): Record<string, string[]> {
  return Object.assign(Object.create(null) as Record<string, string[]>, Object.fromEntries(map));
}

export function parseHashGrammar(hash: string, knownTabs: readonly string[]): ParsedHash {
  const { tab, selection, rest } = splitSegments(stripHash(hash ?? ''), knownTabs);
  const params = new Map<string, string[]>();
  for (const seg of rest) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const key = safeDecode(seg.slice(0, eq));
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const values = seg
      .slice(eq + 1)
      .split(',')
      .map(safeDecode)
      .filter((v) => v !== '');
    if (values.length === 0) continue;
    params.set(key, values);
  }
  return { tab, selection, params: toNullProtoRecord(params) };
}

/**
 * Rewrite only the `owned` keys (null deletes) and return the new hash string
 * (with leading `#`, or '' when nothing remains). The tab/selection segment and
 * every key not named in `owned` are preserved untouched.
 */
export function writeHashKeys(
  currentHash: string,
  owned: Record<string, string[] | null>,
  knownTabs: readonly string[],
): string {
  const raw = stripHash(currentHash ?? '');
  const parts = raw.split('&').filter((p) => p !== '');
  const { tab } = splitSegments(raw, knownTabs);
  const head = tab !== null && parts.length > 0 ? [parts[0]!] : [];
  const tail = tab !== null ? parts.slice(1) : parts;
  const ownedKeys = new Set(Object.keys(owned));
  const kept = tail.filter((seg) => {
    const eq = seg.indexOf('=');
    if (eq <= 0) return true; // not a k=v pair: not ours, keep verbatim
    return !ownedKeys.has(safeDecode(seg.slice(0, eq)));
  });
  const written: string[] = [];
  for (const [key, values] of Object.entries(owned)) {
    if (values === null || values.length === 0) continue;
    written.push(`${encodeURIComponent(key)}=${values.map(encodeURIComponent).join(',')}`);
  }
  const out = [...head, ...kept, ...written].join('&');
  return out ? `#${out}` : '';
}
