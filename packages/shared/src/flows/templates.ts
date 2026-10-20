import { FLOW_LIMITS } from '../validators/flows';
import { parsePath, resolveFlowPath, type FlowPath, type FlowScope, type FlowValue } from './expr';

/** `{{ path }}` — template bodies are paths only (spec §6.2), never expressions. Browser safe. */
export const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface TemplateRef { pointer: string; path: FlowPath; exact: boolean }

const MAX_RENDER_DEPTH = 64;

const escapePointerToken = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

function isPlainContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

interface Located { pointer: string; value: unknown }

/** Iterative walk (never recurses, so hostile nesting cannot overflow the stack). Document order. */
function* walk(root: unknown): Generator<Located> {
  const stack: Located[] = [{ pointer: '', value: root }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (Array.isArray(cur.value)) {
      for (let i = cur.value.length - 1; i >= 0; i--) stack.push({ pointer: `${cur.pointer}/${i}`, value: cur.value[i] });
    } else if (isPlainContainer(cur.value)) {
      const keys = Object.keys(cur.value);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!;
        stack.push({ pointer: `${cur.pointer}/${escapePointerToken(k)}`, value: (cur.value as Record<string, unknown>)[k] });
      }
    } else {
      yield cur;
    }
  }
}

interface Parsed {
  parts: Array<{ kind: 'text'; text: string } | { kind: 'ref'; path: FlowPath }>;
  exact: boolean;
  error?: string;
}

function parseTemplateString(s: string): Parsed {
  const parts: Parsed['parts'] = [];
  let last = 0;
  let leftover = '';
  let count = 0;
  let exact = false;
  for (const m of s.matchAll(TEMPLATE_RE)) {
    const idx = m.index!;
    const body = m[1]!;
    const p = parsePath(body);
    if (!p.ok) return { parts, exact: false, error: `invalid template '{{ ${body} }}': ${p.error}` };
    const text = s.slice(last, idx);
    leftover += text;
    if (text) parts.push({ kind: 'text', text });
    parts.push({ kind: 'ref', path: p.path });
    last = idx + m[0].length;
    exact = count === 0 && idx === 0 && m[0].length === s.length;
    count++;
  }
  const tail = s.slice(last);
  leftover += tail;
  if (tail) parts.push({ kind: 'text', text: tail });
  if (leftover.includes('{{')) return { parts, exact: false, error: "unterminated or malformed '{{' template" };
  return { parts, exact: exact && count === 1 };
}

export function extractTemplates(value: unknown): { refs: TemplateRef[]; errors: Array<{ pointer: string; error: string }> } {
  const refs: TemplateRef[] = [];
  const errors: Array<{ pointer: string; error: string }> = [];
  for (const { pointer, value: leaf } of walk(value)) {
    if (typeof leaf !== 'string' || !leaf.includes('{{')) continue;
    const parsed = parseTemplateString(leaf);
    if (parsed.error) {
      errors.push({ pointer, error: parsed.error });
      continue;
    }
    for (const part of parsed.parts) {
      if (part.kind === 'ref') refs.push({ pointer, path: part.path, exact: parsed.exact });
    }
  }
  return { refs, errors };
}

export function templatedPointers(value: unknown): Set<string> {
  const out = new Set<string>();
  for (const { pointer, value: leaf } of walk(value)) {
    if (typeof leaf === 'string' && leaf.includes('{{')) out.add(pointer);
  }
  return out;
}

type RenderFailure = { ok: false; error: 'render_too_large' | 'template_parse_error'; pointer?: string };

function stringify(v: FlowValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function renderString(s: string, scope: FlowScope, pointer: string): { ok: true; value: FlowValue } | RenderFailure {
  if (!s.includes('{{')) return { ok: true, value: s };
  const parsed = parseTemplateString(s);
  if (parsed.error) return { ok: false, error: 'template_parse_error', pointer };
  if (parsed.exact) {
    const ref = parsed.parts[0] as { kind: 'ref'; path: FlowPath };
    return { ok: true, value: resolveFlowPath(ref.path, scope).value };
  }
  let out = '';
  for (const part of parsed.parts) {
    out += part.kind === 'text' ? part.text : stringify(resolveFlowPath(part.path, scope).value);
    if (out.length > FLOW_LIMITS.maxDocumentBytes) return { ok: false, error: 'render_too_large', pointer };
  }
  return { ok: true, value: out };
}

function renderNode(v: unknown, scope: FlowScope, pointer: string, depth: number): { ok: true; value: FlowValue } | RenderFailure {
  if (depth > MAX_RENDER_DEPTH) return { ok: false, error: 'template_parse_error', pointer };
  if (typeof v === 'string') return renderString(v, scope, pointer);
  if (Array.isArray(v)) {
    const out: FlowValue[] = [];
    for (let i = 0; i < v.length; i++) {
      const r = renderNode(v[i], scope, `${pointer}/${i}`, depth + 1);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainContainer(v)) {
    const entries: Array<[string, FlowValue]> = [];
    for (const k of Object.keys(v)) {
      const r = renderNode((v as Record<string, unknown>)[k], scope, `${pointer}/${escapePointerToken(k)}`, depth + 1);
      if (!r.ok) return r;
      entries.push([k, r.value]);
    }
    return { ok: true, value: Object.fromEntries(entries) };
  }
  if (v === undefined) return { ok: true, value: null };
  return { ok: true, value: v as FlowValue };
}

export function renderTemplates(
  value: unknown,
  scope: FlowScope,
): { ok: true; value: FlowValue } | { ok: false; error: 'render_too_large' | 'template_parse_error'; pointer?: string } {
  const r = renderNode(value, scope, '', 0);
  if (!r.ok) return r;
  const bytes = new TextEncoder().encode(JSON.stringify(r.value) ?? 'null').length;
  if (bytes > FLOW_LIMITS.maxDocumentBytes) return { ok: false, error: 'render_too_large' };
  return r;
}
