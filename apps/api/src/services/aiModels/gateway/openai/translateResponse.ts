import { randomBytes } from 'node:crypto';
import { GATEWAY_MAX_TOOL_ARGS_BYTES, GATEWAY_MAX_TOOL_CALLS, GATEWAY_MAX_USAGE_TOKENS } from '../limits';
import { GatewayError } from '../types';
import type { OaiChatResponse, OaiUsage, ToolNameMap } from './types';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal';
  stop_sequence: null;
  stop_details?: { type: 'refusal'; category: null };
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
}

export const UNSAFE_TOOL_CALL_NOTE =
  '[Breeze: the model asked to run a tool in a form Breeze could not verify, so nothing was run. Try rephrasing, or choose a different model.]';

/** Clamp a token count into [0, GATEWAY_MAX_USAGE_TOKENS]. */
const clampTokens = (n: number): number => Math.min(Math.max(0, Math.floor(n)), GATEWAY_MAX_USAGE_TOKENS);
/** A usable reported counter, clamped; null when absent or not a finite non-negative number. */
const reported = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? clampTokens(n) : null);

/**
 * Billable usage for one call. The endpoint's counters are untrusted: a counter
 * that is missing, non-numeric, or zero while the matching side of the exchange
 * is non-empty (prompt for a non-empty request, completion for a non-empty
 * answer or tool-call arguments) is replaced by a conservative estimate, and
 * every counter is clamped to a plausible maximum with cached ≤ prompt.
 * `est.outputChars` is what the model produced (text plus raw tool-call
 * arguments, accepted or not), never gateway-authored text.
 */
export function resolveUsage(u: OaiUsage | null | undefined, est: { inputTokens: number; outputChars: number }): AnthropicMessage['usage'] {
  let fellBack = false;
  let prompt = reported(u?.prompt_tokens);
  let cached = 0;
  if (prompt === null || (prompt === 0 && est.inputTokens > 0)) {
    prompt = clampTokens(Math.max(1, est.inputTokens));
    fellBack = true;
  } else {
    cached = Math.min(reported(u?.prompt_tokens_details?.cached_tokens) ?? 0, prompt);
  }
  let output = reported(u?.completion_tokens);
  if (output === null || (output === 0 && est.outputChars > 0)) {
    output = clampTokens(Math.ceil(est.outputChars / 3));
    fellBack = true;
  }
  if (fellBack) console.warn('[modelGateway] endpoint reported missing or implausible token usage; billing an estimate');
  return { input_tokens: prompt - cached, output_tokens: output, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** Deeper schemas than this are treated as unverifiable (fail closed); also bounds recursion. */
const SCHEMA_MAX_DEPTH = 64;

/** true/false for a recognised JSON-schema type name; null for an unrecognised one (not constraining). */
function typeMatches(t: string, v: unknown): boolean | null {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    default: return null;
  }
}

/** Schema nodes one validation may visit (combinators re-walk a value per branch); beyond it the call fails closed. */
const SCHEMA_MAX_STEPS = 100_000;

interface SchemaWalk {
  /** The tool's whole input_schema: local `$ref`s resolve against it. */
  root: unknown;
  steps: number;
  exhausted: boolean;
  /** The `$ref`s being followed on the current path, with the value each was applied to. */
  refPath: Array<{ ref: string; value: unknown }>;
}

/**
 * Resolve a local `$ref` (`#` or a `#/...` JSON pointer, URI-escaped, with
 * `~1`/`~0` escapes) into the root schema; `$defs`, `definitions` or any other
 * path. undefined for a non-local or unresolvable reference.
 */
function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let key: string;
    try { key = decodeURIComponent(raw); } catch { return undefined; }
    key = key.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node) && /^\d+$/.test(key)) node = node[Number(key)];
    else if (isPlainObject(node) && Object.hasOwn(node, key)) node = node[key];
    else return undefined;
  }
  return node;
}

/**
 * Check a model-produced value against the subset of JSON Schema the gateway
 * enforces: `type` (name or list, plus OpenAPI `nullable`), `required`,
 * `properties`, `additionalProperties` (false or a schema), `items`, primitive
 * `enum`/`const`, and the combinators `allOf` (every branch), `anyOf` (at least
 * one) and `oneOf` (checked as at least one: rejecting a value that matches
 * several branches would turn an imprecise schema into a false rejection).
 * A local `$ref` (`#/...` into the tool's own schema, `$defs`/`definitions`
 * included) is followed, together with any sibling keywords; a `$ref` cycle
 * that makes no progress on the value adds no constraint. A non-local or
 * unresolvable `$ref` cannot be checked offline and constrains nothing.
 * `not`, `if`/`then`/`else`, formats and patterns are not evaluated (no
 * schema-supplied regex is ever compiled). Work is bounded by
 * SCHEMA_MAX_DEPTH and SCHEMA_MAX_STEPS; hitting either fails closed.
 */
export function matchesToolSchema(value: unknown, schema: unknown): boolean {
  const walk: SchemaWalk = { root: schema, steps: 0, exhausted: false, refPath: [] };
  return matchesSchema(value, schema, 0, walk) && !walk.exhausted;
}

function matchesSchema(value: unknown, schema: unknown, depth: number, walk: SchemaWalk): boolean {
  if (schema === false) return false;
  if (!isPlainObject(schema)) return true;
  if (depth > SCHEMA_MAX_DEPTH) return false;
  if (walk.exhausted || ++walk.steps > SCHEMA_MAX_STEPS) { walk.exhausted = true; return false; }
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    const target = resolveLocalRef(walk.root, ref);
    const revisit = walk.refPath.some((e) => e.ref === ref && Object.is(e.value, value));
    if (target !== undefined && !revisit) {
      walk.refPath.push({ ref, value });
      const ok = matchesSchema(value, target, depth + 1, walk);
      walk.refPath.pop();
      if (!ok) return false;
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) if (!matchesSchema(value, branch, depth + 1, walk)) return false;
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0
      && !branches.some((branch) => matchesSchema(value, branch, depth + 1, walk))) return false;
  }
  if (!(value === null && schema.nullable === true)) {
    const t = schema.type;
    const names = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
    if (names.length > 0) {
      const results = names.map((n) => typeMatches(n, value));
      if (!results.includes(null) && !results.includes(true)) return false;
    }
  }
  if (Array.isArray(schema.enum)) {
    if (isPrimitive(value)) { if (!schema.enum.some((e) => e === value)) return false; }
    else if (schema.enum.every(isPrimitive)) return false;
  }
  if ('const' in schema && isPrimitive(schema.const) && value !== schema.const) return false;
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (typeof k === 'string' && !Object.hasOwn(value, k)) return false;
    }
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    // patternProperties would admit keys this check cannot evaluate without compiling a schema regex.
    const extra = schema.patternProperties === undefined ? schema.additionalProperties : undefined;
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) { if (!matchesSchema(v, props[k], depth + 1, walk)) return false; }
      else if (extra === false) return false;
      else if (isPlainObject(extra) && !matchesSchema(v, extra, depth + 1, walk)) return false;
    }
  }
  if (Array.isArray(value) && (isPlainObject(schema.items) || schema.items === false)) {
    for (const item of value) if (!matchesSchema(item, schema.items, depth + 1, walk)) return false;
  }
  return true;
}

export const genToolUseId = (): string => `toolu_gw_${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, '0')}`;
export const genMessageId = (): string => `msg_gw_${randomBytes(12).toString('hex')}`;

/**
 * Validate a complete set of tool calls; any unsafe member rejects the whole
 * batch, so a caller never receives (and executes) part of a batch. Each call
 * must name an offered tool and carry arguments that satisfy that tool's
 * input_schema; a tool with no retained schema fails closed.
 */
export function validateToolCalls(
  calls: ReadonlyArray<{ id?: string; name?: string; arguments?: string }>,
  tools: ToolNameMap,
): Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> | null {
  if (calls.length === 0) return [];
  if (calls.length > GATEWAY_MAX_TOOL_CALLS) return null;
  const out: Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> = [];
  const seenIds = new Set<string>();
  for (const c of calls) {
    const name = typeof c.name === 'string' && c.name ? tools.fromOai.get(c.name) : undefined;
    if (!name) return null;
    const schema = tools.schemas.get(name);
    if (!schema) return null;
    const args = c.arguments ?? '';
    if (typeof args !== 'string') return null;
    if (Buffer.byteLength(args, 'utf8') > GATEWAY_MAX_TOOL_ARGS_BYTES || args.trim() === '') return null;
    let input: unknown;
    try { input = JSON.parse(args); } catch { return null; }
    if (!isPlainObject(input) || !matchesToolSchema(input, schema)) return null;
    // An untrusted endpoint may repeat an id; a duplicate tool_use id would make the
    // caller's tool_result ambiguous, so any reuse gets a fresh id.
    const id = c.id && /^[A-Za-z0-9_-]{1,128}$/.test(c.id) && !seenIds.has(c.id) ? c.id : genToolUseId();
    seenIds.add(id);
    out.push({ type: 'tool_use', id, name, input: input as Record<string, unknown> });
  }
  return out;
}

export function mapFinish(finish: string | null | undefined, emittedToolUse: boolean): AnthropicMessage['stop_reason'] {
  switch (finish) {
    case 'length': return 'max_tokens';
    case 'tool_calls': case 'function_call': return emittedToolUse ? 'tool_use' : 'end_turn';
    case 'content_filter': return 'refusal';
    default: return emittedToolUse ? 'tool_use' : 'end_turn';
  }
}

export function translateChatResponse(res: unknown, ctx: { model: string; tools: ToolNameMap; estimatedInputTokens?: number }): AnthropicMessage {
  const r = res as OaiChatResponse;
  if (!r || typeof r !== 'object' || !Array.isArray(r.choices)) {
    throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned a malformed response.');
  }
  const choice = r.choices[0];
  if (!choice?.message) throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned no choices.');
  const content: AnthropicContentBlock[] = [];
  if (typeof choice.message.content === 'string' && choice.message.content.length > 0) content.push({ type: 'text', text: choice.message.content });
  const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  const toolUses = validateToolCalls(calls.map((c) => ({ id: c?.id, name: c?.function?.name, arguments: c?.function?.arguments })), ctx.tools);
  if (toolUses === null) content.push({ type: 'text', text: UNSAFE_TOOL_CALL_NOTE });
  else content.push(...toolUses);
  const emitted = toolUses !== null && toolUses.length > 0;
  const stop = mapFinish(choice.finish_reason, emitted);
  return {
    id: genMessageId(), type: 'message', role: 'assistant', model: ctx.model, content,
    stop_reason: stop, stop_sequence: null,
    ...(stop === 'refusal' ? { stop_details: { type: 'refusal' as const, category: null } } : {}),
    usage: resolveUsage(r.usage, {
      inputTokens: ctx.estimatedInputTokens ?? 1,
      // What the model produced: its text and every tool call's raw arguments, accepted or not.
      outputChars: (typeof choice.message.content === 'string' ? choice.message.content.length : 0)
        + calls.reduce((n, c) => n + (typeof c?.function?.arguments === 'string' ? c.function.arguments.length : 0), 0),
    }),
  };
}
