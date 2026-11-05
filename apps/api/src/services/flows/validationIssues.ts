/**
 * Tool Catalog W03 (#5218) — the issue and template-aware partial-validation
 * helpers of the flow validator (spec §6.3 rule 2). Moved out of
 * flowValidator.ts in W5 PR B (#5220) so the built-in step validator
 * (validateBuiltins.ts) shares them without an import cycle. Pure: no I/O.
 */
import { z } from 'zod';
import { templateLeafKinds, type FlowIssue } from '@breeze/shared';

export function issue(
  code: FlowIssue['code'],
  message: string,
  extra: { stepId?: string; pointer?: string; severity?: FlowIssue['severity'] } = {},
): FlowIssue {
  return {
    code,
    severity: extra.severity ?? 'error',
    message,
    ...(extra.stepId !== undefined ? { stepId: extra.stepId } : {}),
    ...(extra.pointer !== undefined ? { pointer: extra.pointer } : {}),
  };
}

export function escapePointerSegment(seg: string | number): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function toPointer(path: ReadonlyArray<PropertyKey>): string {
  return path.map((s) => `/${escapePointerSegment(typeof s === 'symbol' ? s.toString() : (s as string | number))}`).join('');
}

export type LeafKinds = ReadonlyMap<string, 'exact' | 'partial'>;

/**
 * Which templated leaf, if any, an issue at `pointer` sits under. An exact
 * leaf can render to any JSON type, so it covers its descendants too; a
 * partial leaf always renders to a string, which has none.
 */
export function templateKindAt(pointer: string, kinds: LeafKinds): 'exact' | 'partial' | null {
  const own = kinds.get(pointer);
  if (own) return own;
  for (const [t, kind] of kinds) {
    if (kind === 'exact' && pointer.startsWith(`${t}/`)) return 'exact';
  }
  return null;
}

export function containsTemplate(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.includes('{{')) return true;
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v && typeof v === 'object') {
      stack.push(...Object.values(v));
    }
  }
  return false;
}

export function utf8Bytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Zod 4 codes that describe a VALUE (a templated leaf's runtime value can
 * satisfy them). Structural codes — `custom` (refinements such as run_script's
 * exactly-one-of rules), `unrecognized_keys`, a missing required key (an
 * `invalid_type` at a path no template occupies) — are never masked.
 */
const MASKABLE_ZOD_CODES: ReadonlySet<string> = new Set([
  'invalid_type', 'invalid_format', 'invalid_value', 'invalid_union', 'too_small', 'too_big', 'not_multiple_of',
]);

type LooseZodIssue = z.core.$ZodIssue & {
  expected?: string;
  format?: string;
  values?: unknown[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  divisor?: number;
  errors?: LooseZodIssue[][];
};

function zodIssueMasked(zi: LooseZodIssue, kind: 'exact' | 'partial' | null): boolean {
  if (kind === 'exact') return MASKABLE_ZOD_CODES.has(zi.code);
  if (kind !== 'partial') return false;
  switch (zi.code) {
    case 'invalid_format': return true;
    case 'invalid_value': return Array.isArray(zi.values) && zi.values.some((v) => typeof v === 'string');
    case 'too_small':
    case 'too_big': return zi.origin === 'string';
    default: return false;
  }
}

const FORMAT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  uuid: '00000000-0000-4000-8000-000000000000',
  guid: '00000000-0000-4000-8000-000000000000',
  email: 'placeholder@example.com',
  url: 'https://example.com/',
  datetime: '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
};

/**
 * A value that satisfies the failing check, used ONLY to re-parse so that
 * refinements Zod skipped after an aborting issue at a templated leaf still
 * run (Zod 4 does not run an object's refinements once a child aborted).
 * Never stored; the masked check itself is re-run on the rendered value at
 * run time (W04).
 */
function placeholderFor(i: LooseZodIssue): { ok: true; value: unknown } | { ok: false } {
  switch (i.code) {
    case 'invalid_type':
      switch (i.expected) {
        case 'string': return { ok: true, value: 'x' };
        case 'number': case 'int': return { ok: true, value: 0 };
        case 'boolean': return { ok: true, value: false };
        case 'array': return { ok: true, value: [] };
        case 'object': case 'record': return { ok: true, value: {} };
        case 'null': return { ok: true, value: null };
        default: return { ok: false };
      }
    case 'invalid_format': {
      const v = i.format ? FORMAT_PLACEHOLDERS[i.format] : undefined;
      return v ? { ok: true, value: v } : { ok: false };
    }
    case 'invalid_value':
      return Array.isArray(i.values) && i.values.length > 0 ? { ok: true, value: i.values[0] } : { ok: false };
    case 'too_small':
      if (i.origin === 'number' && typeof i.minimum === 'number') return { ok: true, value: i.inclusive === false ? i.minimum + 1 : i.minimum };
      if (i.origin === 'string' && typeof i.minimum === 'number') return { ok: true, value: 'x'.repeat(Math.min(i.minimum, 1024)) };
      return { ok: false };
    case 'too_big':
      if (i.origin === 'number' && typeof i.maximum === 'number') return { ok: true, value: i.inclusive === false ? i.maximum - 1 : i.maximum };
      if (i.origin === 'string') return { ok: true, value: '' };
      return { ok: false };
    case 'invalid_union': {
      const first = i.errors?.[0]?.[0];
      return first ? placeholderFor(first) : { ok: false };
    }
    default:
      return { ok: false };
  }
}

function setAtPath(root: Record<string, unknown>, path: ReadonlyArray<PropertyKey>, value: unknown): boolean {
  if (path.length === 0) return false;
  let cur: unknown = root;
  for (let k = 0; k < path.length - 1; k++) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Record<PropertyKey, unknown>)[path[k]!];
  }
  if (!cur || typeof cur !== 'object') return false;
  (cur as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value;
  return true;
}

/** Rule 2 against a Zod schema, with every issue at a templated leaf masked (re-checked unmasked at run time). */
export function zodInputIssues(schema: z.ZodType, input: Record<string, unknown>, stepId: string, base: string): FlowIssue[] {
  const kinds = templateLeafKinds(input);
  const seen = new Set<string>();
  const out: FlowIssue[] = [];
  const collect = (issues: LooseZodIssue[]): LooseZodIssue[] => {
    const masked: LooseZodIssue[] = [];
    for (const zi of issues) {
      const pointer = toPointer(zi.path);
      if (zodIssueMasked(zi, templateKindAt(pointer, kinds))) {
        masked.push(zi);
        continue;
      }
      const key = `${zi.code}|${pointer}|${zi.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue('input_invalid', `${pointer || '/'}: ${zi.message}`, { stepId, pointer: `${base}${pointer}` }));
    }
    return masked;
  };

  // A deep copy, so placeholders never leak into the caller's document. The
  // input is parsed JSON, so structuredClone cannot fail on it.
  const working: Record<string, unknown> = structuredClone(input);
  let parsed = schema.safeParse(working);
  let masked = parsed.success ? [] : collect(parsed.error.issues as LooseZodIssue[]);
  for (let round = 0; round < 5 && masked.length > 0; round++) {
    let changed = false;
    for (const zi of masked) {
      const p = placeholderFor(zi);
      if (p.ok && setAtPath(working, zi.path, p.value)) changed = true;
    }
    if (!changed) break;
    parsed = schema.safeParse(working);
    masked = parsed.success ? [] : collect(parsed.error.issues as LooseZodIssue[]);
  }
  return out;
}
