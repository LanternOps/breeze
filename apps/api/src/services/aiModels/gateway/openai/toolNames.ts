import type { ToolNameMap } from './types';

/** OpenAI's function-name rule. Every name the gateway puts on the wire satisfies it. */
export const OAI_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const OAI_TOOL_NAME_MAX = 64;

/** `mcp__<server>__<tool>` → `<tool>`; any other name unchanged. */
function stripMcpPrefix(name: string): string {
  const sep = name.startsWith('mcp__') ? name.indexOf('__', 5) : -1;
  return sep > 5 ? name.slice(sep + 2) : name;
}

/**
 * A tool's bare name: the `mcp__<server>__` prefix dropped, every run of
 * characters outside `[A-Za-z0-9_-]` turned into `_`, and leading/trailing
 * underscores trimmed. Not length-capped; may be empty.
 */
export function bareToolName(name: string): string {
  return stripMcpPrefix(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * The indexed wire alias `t_<index>_<bare>` cut to 64 characters, or `t_<index>`
 * when the bare name is empty. Unique within a request by construction.
 */
export function toolAlias(index: number, name: string): string {
  const head = `t_${index}`;
  const tail = bareToolName(name);
  if (tail === '') return head;
  return `${head}_${tail}`.slice(0, OAI_TOOL_NAME_MAX);
}

/**
 * Whether a bare name may go on the wire as-is. It must satisfy OpenAI's rule,
 * must not start with `mcp` (#7795: Ollama's tool-call parser drops such a
 * call), and must stay out of the gateway's own namespaces: `t_<digits>` (the
 * indexed aliases) and `h_<16 hex>` (history tools not offered this request),
 * so a bare name can never equal another tool's alias or a history name.
 */
function wireSafeBare(bare: string): boolean {
  return OAI_TOOL_NAME.test(bare) && !/^mcp/i.test(bare) && !/^t_\d/.test(bare) && !/^h_[0-9a-f]{16}$/.test(bare);
}

/**
 * Wire names for the offered tools, in order (#8081). A tool goes on the wire
 * under its bare name when that name is wire-safe and no other offered tool has
 * the same bare name; otherwise (a collision, or an illegal or reserved bare
 * name) under its indexed alias. Bare names are mutually distinct, aliases are
 * distinct by index, and the two sets cannot meet (no wire-safe bare name
 * starts with `t_<digit>`), so the result is one-to-one. No result starts with
 * `mcp`.
 *
 * Bare names first because a model that sees `t_12_get_device_hardware_health`
 * may answer with `get_device_hardware_health` (gpt-oss:20b on Ollama does).
 */
export function assignWireNames(names: readonly string[]): string[] {
  const bares = names.map(bareToolName);
  const counts = new Map<string, number>();
  for (const b of bares) if (wireSafeBare(b)) counts.set(b, (counts.get(b) ?? 0) + 1);
  return names.map((name, i) => {
    const b = bares[i]!;
    return wireSafeBare(b) && counts.get(b) === 1 ? b : toolAlias(i, name);
  });
}

/** The name with ONE recognised wrapper removed, for each wrapper the name carries. */
function unwrapOnce(raw: string): string[] {
  const out: string[] = [];
  if (raw.startsWith('functions.') && raw.length > 'functions.'.length) out.push(raw.slice('functions.'.length));
  const alias = /^t_\d+_(.+)$/.exec(raw);
  if (alias) out.push(alias[1]!);
  const bare = stripMcpPrefix(raw);
  if (bare !== raw && bare !== '') out.push(bare);
  return out;
}

const bareIndexCache = new WeakMap<ToolNameMap['schemas'], Map<string, string[]>>();
/** bare name → the offered caller names that share it. */
function bareIndex(tools: ToolNameMap): Map<string, string[]> {
  let idx = bareIndexCache.get(tools.schemas);
  if (!idx) {
    idx = new Map();
    for (const caller of tools.schemas.keys()) {
      const b = bareToolName(caller);
      if (b === '') continue;
      const list = idx.get(b);
      if (list) list.push(caller); else idx.set(b, [caller]);
    }
    bareIndexCache.set(tools.schemas, idx);
  }
  return idx;
}

export type ToolNameResolution = { ok: true; name: string } | { ok: false; reason: 'not_offered' | 'ambiguous' };

/**
 * Map a model-returned function name back to the caller's tool name (#8081).
 *
 * An exact wire name always wins. Otherwise the name, and the name with one
 * recognised wrapper removed (`functions.`, `t_<n>_`, `mcp__<server>__`), are
 * each looked up as a wire name, an offered caller name, and an offered tool's
 * bare name. The call resolves only when every match is the SAME offered tool;
 * two or more distinct tools is ambiguous and none is not offered. Only offered
 * tools are candidates, so a history-only (`h_…`) name or an invented one never
 * resolves, and arguments are still checked against the resolved tool's schema.
 */
export function resolveToolName(raw: string, tools: ToolNameMap): ToolNameResolution {
  if (raw === '') return { ok: false, reason: 'not_offered' };
  const exact = tools.fromOai.get(raw);
  if (exact !== undefined) return { ok: true, name: exact };
  const idx = bareIndex(tools);
  const matches = new Set<string>();
  for (const key of [raw, ...unwrapOnce(raw)]) {
    const wire = tools.fromOai.get(key);
    if (wire !== undefined) matches.add(wire);
    if (tools.schemas.has(key)) matches.add(key);
    for (const caller of idx.get(key) ?? []) matches.add(caller);
  }
  if (matches.size === 1) return { ok: true, name: matches.values().next().value! };
  return { ok: false, reason: matches.size === 0 ? 'not_offered' : 'ambiguous' };
}
