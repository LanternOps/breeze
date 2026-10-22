import {
  YARA_IOC_FILE_EXTENSIONS,
  YARA_IOC_FILENAME_MAX_BYTES,
  YARA_IOC_KINDS,
  YARA_IOC_MAX_PER_BATCH,
  YARA_IOC_MAX_TEXT_BYTES,
  YARA_IOC_PATH_MAX_BYTES,
  YARA_IOC_RULE_SOURCE_BUDGET,
  YARA_IOC_STRING_MAX_BYTES,
  YARA_IOC_STRING_MIN_BYTES,
  type YaraGeneratedRule,
  type YaraIoc,
  type YaraIocErrorCode,
  type YaraIocKind,
  type YaraRuleSeverity,
} from '../types/yara';

/**
 * IOC paste importer (#6263 W04-1): parse pasted IOCs, validate them, and
 * generate YARA rules from them.
 *
 * Pure and browser-safe (no node built-ins): the web preview and the API
 * import route run this same code, so the preview is byte-identical to what
 * is saved. The route never accepts rule text — it takes structured IOCs and
 * re-generates. Generated source carries no timestamp or random value.
 */

export class YaraIocInputError extends Error {
  /** `index` is the IOC's position in the batch, or -1 for a batch-level problem. */
  constructor(message: string, readonly errors: ReadonlyArray<{ index: number; code: YaraIocErrorCode }>) {
    super(message);
    this.name = 'YaraIocInputError';
  }
}

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

const KIND_SET: ReadonlySet<string> = new Set(YARA_IOC_KINDS);
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(YARA_IOC_FILE_EXTENSIONS);
const HASH_HEX_LENGTH: Record<'md5' | 'sha1' | 'sha256', number> = { md5: 32, sha1: 40, sha256: 64 };

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const UNICODE_DOMAIN_RE = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,63}$/u;
const IPV4_SHAPE_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const FILENAME_SHAPE_RE = /^[^\\/:]+\.([A-Za-z0-9]+)$/;

function isKind(k: string): k is YaraIocKind {
  return KIND_SET.has(k);
}

/** `evil[.]com` → `evil.com`, `hxxp` → `http`, `[:]` → `:`. */
function refang(value: string): string {
  return value
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\[:\]/g, ':')
    .replace(/h([xX])([xX])p/g, (_m, a: string, b: string) => `h${a === 'X' ? 'T' : 't'}${b === 'X' ? 'T' : 't'}p`);
}

function isFilepathShape(v: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\');
}

function parseIpv4(v: string): number[] | null {
  if (!IPV4_SHAPE_RE.test(v)) return null;
  const parts = v.split('.');
  const out: number[] = [];
  for (const p of parts) {
    if (p.length > 1 && p.startsWith('0')) return null; // ambiguous octal-looking octet
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** RFC 5952 text for `groups` (compress the longest run of ≥ 2 zero groups, first on a tie). */
function renderIpv6Groups(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = (g: number[]) => g.map((n) => n.toString(16)).join(':');
  if (bestStart < 0) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLen))}`;
}

/** Canonical (compressed, lowercase) IPv6, or null when `v` is not a valid address. */
function canonicalIpv6(v: string): string | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(v) || !v.includes(':')) return null;
  let s = v;
  let v4: number[] | null = null;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    v4 = parseIpv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (h: string) => (h === '' ? [] : h.split(':'));
  let parts: string[];
  if (halves.length === 2) {
    const head = split(halves[0]!);
    const tail = split(halves[1]!);
    if (head.length + tail.length > 7) return null;
    parts = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    parts = s.split(':');
  }
  if (parts.length !== 8 || parts.some((p) => !/^[0-9A-Fa-f]{1,4}$/.test(p))) return null;
  const groups = parts.map((p) => parseInt(p, 16));
  if (!v4) return renderIpv6Groups(groups);
  const head = renderIpv6Groups(groups.slice(0, 6));
  return `${head}${head.endsWith('::') ? '' : ':'}${v4.join('.')}`;
}

/** The kind a refanged value looks like (W04-1 classification order). */
function classify(v: string): YaraIocKind {
  if (/^[0-9A-Fa-f]{32}$/.test(v)) return 'md5';
  if (/^[0-9A-Fa-f]{40}$/.test(v)) return 'sha1';
  if (/^[0-9A-Fa-f]{64}$/.test(v)) return 'sha256';
  if (/^HK[A-Za-z_]*\\/.test(v)) return 'string';
  if (isFilepathShape(v)) return 'filepath';
  if (IPV4_SHAPE_RE.test(v)) return 'ip';
  if ((v.match(/:/g)?.length ?? 0) >= 2 && /^[0-9A-Fa-f:.]+$/.test(v)) return 'ip';
  const file = FILENAME_SHAPE_RE.exec(v);
  if (file && FILE_EXTENSIONS.has(file[1]!.toLowerCase())) return 'filename';
  if (DOMAIN_RE.test(v.toLowerCase())) return 'domain';
  // Internationalised names classify as domains so validation can ask for
  // the punycode form instead of silently importing a content string.
  if (/[^\x00-\x7f]/.test(v) && UNICODE_DOMAIN_RE.test(v)) return 'domain';
  return 'string';
}

type ValidateResult = { ok: true; ioc: YaraIoc } | { ok: false; code: YaraIocErrorCode };

/**
 * Normalizes one IOC (trim, refang, lowercase hashes and domains, canonical
 * IPv6) and checks its kind's shape and length.
 */
export function validateIoc(ioc: YaraIoc): ValidateResult {
  const kind = (ioc as { kind: unknown }).kind;
  if (typeof kind !== 'string' || !isKind(kind)) return { ok: false, code: 'unknown_kind' };
  const raw = (ioc as { value: unknown }).value;
  if (typeof raw !== 'string') return { ok: false, code: 'empty' };
  const value = refang(raw.trim());
  if (value === '') return { ok: false, code: 'empty' };

  switch (kind) {
    case 'md5':
    case 'sha1':
    case 'sha256': {
      const hex = value.toLowerCase();
      if (hex.length !== HASH_HEX_LENGTH[kind] || !/^[0-9a-f]+$/.test(hex)) return { ok: false, code: 'bad_hash' };
      return { ok: true, ioc: { kind, value: hex } };
    }
    case 'filename': {
      if (/[\\/]/.test(value) || CONTROL_RE.test(value)) return { ok: false, code: 'bad_path' };
      if (utf8Length(value) > YARA_IOC_FILENAME_MAX_BYTES) return { ok: false, code: 'too_long' };
      return { ok: true, ioc: { kind, value } };
    }
    case 'filepath': {
      if (!isFilepathShape(value) || CONTROL_RE.test(value)) return { ok: false, code: 'bad_path' };
      if (utf8Length(value) > YARA_IOC_PATH_MAX_BYTES) return { ok: false, code: 'too_long' };
      return { ok: true, ioc: { kind, value } };
    }
    case 'domain': {
      const d = value.toLowerCase();
      if (!DOMAIN_RE.test(d)) return { ok: false, code: 'bad_domain' };
      return { ok: true, ioc: { kind, value: d } };
    }
    case 'ip': {
      const v4 = parseIpv4(value);
      if (v4) return { ok: true, ioc: { kind, value: v4.join('.') } };
      const v6 = canonicalIpv6(value);
      if (!v6) return { ok: false, code: 'bad_ip' };
      return { ok: true, ioc: { kind, value: v6 } };
    }
    case 'string': {
      const n = utf8Length(value);
      if (n < YARA_IOC_STRING_MIN_BYTES) return { ok: false, code: 'too_short' };
      if (n > YARA_IOC_STRING_MAX_BYTES) return { ok: false, code: 'too_long' };
      return { ok: true, ioc: { kind, value } };
    }
  }
}

/** filename, filepath and domain dedupe case-insensitively; everything else exactly. */
function dedupeKey(ioc: YaraIoc): string {
  const v = ioc.kind === 'filename' || ioc.kind === 'filepath' || ioc.kind === 'domain' ? ioc.value.toLowerCase() : ioc.value;
  return `${ioc.kind}\u0000${v}`;
}

/**
 * Validates a structured batch (what the import route receives): every bad
 * entry and every duplicate is reported by index.
 */
export function validateIocBatch(
  iocs: readonly YaraIoc[],
): { ok: true; iocs: YaraIoc[] } | { ok: false; errors: Array<{ index: number; code: YaraIocErrorCode }> } {
  const errors: Array<{ index: number; code: YaraIocErrorCode }> = [];
  const out: YaraIoc[] = [];
  const seen = new Set<string>();
  iocs.forEach((ioc, index) => {
    const res = validateIoc(ioc);
    if (!res.ok) { errors.push({ index, code: res.code }); return; }
    const key = dedupeKey(res.ioc);
    if (seen.has(key)) { errors.push({ index, code: 'duplicate' }); return; }
    seen.add(key);
    out.push(res.ioc);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, iocs: out };
}

/** `kind:value` applies only when the text before the first `:` is exactly a kind name. */
function splitPrefix(line: string): { kind: YaraIocKind | null; value: string } {
  const idx = line.indexOf(':');
  if (idx > 0) {
    const prefix = line.slice(0, idx).trim().toLowerCase();
    if (isKind(prefix)) return { kind: prefix, value: line.slice(idx + 1) };
  }
  return { kind: null, value: line };
}

type ParseError = { line: number; value: string; code: YaraIocErrorCode };

/**
 * Parses pasted text: one IOC per line (`#` comments and blank lines are
 * skipped, `kind:value` overrides classification), or a JSON array of strings
 * and `{ kind, value }` objects. Duplicates after normalization are reported
 * on the later line.
 */
export function parseIocText(text: string): { iocs: YaraIoc[]; errors: ParseError[] } {
  if (utf8Length(text) > YARA_IOC_MAX_TEXT_BYTES) {
    return { iocs: [], errors: [{ line: 0, value: '', code: 'too_long' }] };
  }

  type Entry = { line: number; kind: YaraIocKind | null; value: string } | { line: number; error: ParseError };
  let entries: Entry[] | null = null;

  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        entries = parsed.map((item, i): Entry => {
          const line = i + 1;
          if (typeof item === 'string') return { line, ...splitPrefix(item) };
          if (item && typeof item === 'object') {
            const k = (item as { kind?: unknown }).kind;
            const v = (item as { value?: unknown }).value;
            const value = typeof v === 'string' ? v.trim() : '';
            if (typeof v !== 'string') return { line, error: { line, value, code: 'empty' } };
            if (k === undefined) return { line, kind: null, value: v };
            const kind = typeof k === 'string' ? k.trim().toLowerCase() : '';
            if (!isKind(kind)) return { line, error: { line, value, code: 'unknown_kind' } };
            return { line, kind, value: v };
          }
          return { line, error: { line, value: '', code: 'empty' } };
        });
      }
    } catch {
      entries = null; // not JSON: treat as lines
    }
  }

  if (!entries) {
    entries = [];
    text.split(/\r?\n/).forEach((rawLine, i) => {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) return;
      entries!.push({ line: i + 1, ...splitPrefix(line) });
    });
  }

  const iocs: YaraIoc[] = [];
  const errors: ParseError[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if ('error' in e) { errors.push(e.error); continue; }
    const shown = e.value.trim();
    const kind = e.kind ?? classify(refang(shown));
    const res = validateIoc({ kind, value: shown });
    if (!res.ok) { errors.push({ line: e.line, value: shown, code: res.code }); continue; }
    const key = dedupeKey(res.ioc);
    if (seen.has(key)) { errors.push({ line: e.line, value: shown, code: 'duplicate' }); continue; }
    seen.add(key);
    iocs.push(res.ioc);
  }
  return { iocs, errors };
}

/** YARA text-string escaping: `\` and `"` escaped, every byte outside 0x20–0x7e as `\xNN`. */
export function escapeYaraText(value: string): string {
  let out = '';
  for (const b of encoder.encode(value)) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x22) out += '\\"';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function utf16leHex(value: string): string {
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const u = value.charCodeAt(i);
    out.push((u & 0xff).toString(16).padStart(2, '0'), (u >> 8).toString(16).padStart(2, '0'));
  }
  return out.join(' ');
}

function slugify(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64).replace(/_+$/, '');
  return slug === '' ? 'batch' : slug;
}

/** FNV-1a 64-bit over the UTF-8 bytes, as 16 lowercase hex chars. */
function fnv1a64Hex(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of encoder.encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

const PATTERN_KINDS: ReadonlySet<YaraIocKind> = new Set(['domain', 'ip', 'string']);
const HASH_KINDS: ReadonlySet<YaraIocKind> = new Set(['md5', 'sha1', 'sha256']);
const CONDITION_SEPARATOR = ' or\n';

function ruleHeader(name: string, kind: YaraIocKind, label: string, count: number): string {
  return (
    (HASH_KINDS.has(kind) ? 'import "hash"\n\n' : '') +
    `rule ${name} : ioc ${kind}\n{\n` +
    '  meta:\n' +
    '    source = "breeze-ioc-import"\n' +
    `    label = "${escapeYaraText(label)}"\n` +
    `    ioc_count = ${count}\n`
  );
}

function ruleFooter(kind: YaraIocKind): string {
  return PATTERN_KINDS.has(kind) ? '  condition:\n    any of them\n}\n' : '\n}\n';
}

/** The body text one IOC contributes (a strings line, or a condition expression). */
function itemText(kind: YaraIocKind, value: string, index: number): string {
  const esc = escapeYaraText(value);
  switch (kind) {
    case 'md5':
    case 'sha1':
    case 'sha256':
      return `    hash.${kind}(0, filesize) == "${value}"`;
    case 'filename':
    case 'filepath':
      return `    ${kind} iequals "${esc}"`;
    case 'domain':
      return `    $i${index} = "${esc}" ascii wide nocase\n`;
    case 'ip':
    case 'string':
      // `ascii wide` over UTF-8 escapes would never match UTF-16 text, so a
      // non-ASCII value gets its UTF-8 bytes plus a UTF-16LE hex pattern.
      if (/[^\x00-\x7f]/.test(value)) {
        return `    $i${index} = "${esc}"\n    $i${index}w = { ${utf16leHex(value)} }\n`;
      }
      return `    $i${index} = "${esc}" ascii wide\n`;
  }
}

function renderRule(name: string, kind: YaraIocKind, label: string, values: readonly string[]): string {
  const items = values.map((v, i) => itemText(kind, v, i));
  const body = PATTERN_KINDS.has(kind) ? `  strings:\n${items.join('')}` : `  condition:\n${items.join(CONDITION_SEPARATOR)}`;
  return ruleHeader(name, kind, label, values.length) + body + ruleFooter(kind);
}

/**
 * One rule per kind, IOCs sorted by value and packed into rules of at most
 * `YARA_IOC_RULE_SOURCE_BUDGET` bytes (`_2`, `_3`, … for later chunks), so the
 * output depends only on the set of IOCs, never on paste order.
 * Throws `YaraIocInputError` on an empty, over-cap, invalid or duplicated batch.
 */
export function generateIocRules(input: {
  label: string;
  iocs: readonly YaraIoc[];
  severity?: YaraRuleSeverity;
}): YaraGeneratedRule[] {
  if (input.iocs.length === 0) throw new YaraIocInputError('No IOCs to import', [{ index: -1, code: 'empty' }]);
  if (input.iocs.length > YARA_IOC_MAX_PER_BATCH) {
    throw new YaraIocInputError(`At most ${YARA_IOC_MAX_PER_BATCH} IOCs per import`, [{ index: -1, code: 'too_long' }]);
  }
  const checked = validateIocBatch(input.iocs);
  if (!checked.ok) throw new YaraIocInputError('Some IOCs are invalid', checked.errors);

  const label = input.label.trim();
  const slug = slugify(label);
  const severity = input.severity ?? 'high';
  const rules: YaraGeneratedRule[] = [];

  for (const kind of YARA_IOC_KINDS) {
    const values = checked.iocs
      .filter((i) => i.kind === kind)
      .map((i) => i.value)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (values.length === 0) continue;

    const base = `ioc_${slug}_${kind}_`;
    // Upper bound for the fixed part: a 16-hex hash, a `_NNNN` suffix and a
    // 4-digit count (a batch is ≤ 1000 IOCs), so every chunk fits once rendered.
    const fixed = utf8Length(ruleHeader(`${base}${'0'.repeat(16)}_9999`, kind, label, 9999) + ruleFooter(kind))
      + (PATTERN_KINDS.has(kind) ? utf8Length('  strings:\n') : utf8Length('  condition:\n'));

    const chunks: string[][] = [];
    let current: string[] = [];
    let size = fixed;
    for (const v of values) {
      const cost = utf8Length(itemText(kind, v, current.length)) + CONDITION_SEPARATOR.length;
      if (current.length > 0 && size + cost > YARA_IOC_RULE_SOURCE_BUDGET) {
        chunks.push(current);
        current = [];
        size = fixed;
        size += utf8Length(itemText(kind, v, 0)) + CONDITION_SEPARATOR.length;
      } else {
        size += cost;
      }
      current.push(v);
    }
    chunks.push(current);

    chunks.forEach((chunk, i) => {
      const name = `${base}${fnv1a64Hex(chunk.join('\n'))}${i === 0 ? '' : `_${i + 1}`}`;
      const source = renderRule(name, kind, label, chunk);
      if (utf8Length(source) > YARA_IOC_RULE_SOURCE_BUDGET) {
        throw new Error(`generated rule ${name} exceeds the source budget`); // unreachable: the estimate is an upper bound
      }
      rules.push({ name, source, severity, tags: ['ioc', kind], kind, iocCount: chunk.length });
    });
  }
  return rules;
}
