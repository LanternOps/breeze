import { randomBytes } from 'node:crypto';
import { GATEWAY_MAX_TOOL_ARGS_BYTES, GATEWAY_MAX_TOOL_CALLS } from '../limits';
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

const nonNeg = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function mapUsage(u: OaiUsage | null | undefined): AnthropicMessage['usage'] {
  const prompt = nonNeg(u?.prompt_tokens);
  const cached = Math.min(nonNeg(u?.prompt_tokens_details?.cached_tokens), prompt);
  return { input_tokens: prompt - cached, output_tokens: nonNeg(u?.completion_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const reported = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Estimate missing upstream usage so an omitted counter is never billed as zero. */
export function resolveUsage(u: OaiUsage | null | undefined, est: { inputTokens: number; outputChars: number }): AnthropicMessage['usage'] {
  if (u && reported(u.prompt_tokens) && reported(u.completion_tokens)) return mapUsage(u);
  console.warn('[modelGateway] endpoint reported no usable token usage; billing an estimate');
  return { input_tokens: Math.max(1, est.inputTokens), output_tokens: Math.ceil(est.outputChars / 3), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

export const genToolUseId = (): string => `toolu_gw_${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, '0')}`;
export const genMessageId = (): string => `msg_gw_${randomBytes(12).toString('hex')}`;

/** Validate a complete set of tool calls; any unsafe member rejects the whole batch. */
export function validateToolCalls(
  calls: ReadonlyArray<{ id?: string; name?: string; arguments?: string }>,
  tools: ToolNameMap,
): Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> | null {
  if (calls.length === 0) return [];
  if (calls.length > GATEWAY_MAX_TOOL_CALLS) return null;
  const out: Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> = [];
  const seenIds = new Set<string>();
  for (const c of calls) {
    const name = c.name ? tools.fromOai.get(c.name) : undefined;
    if (!name) return null;
    const args = c.arguments ?? '';
    if (Buffer.byteLength(args, 'utf8') > GATEWAY_MAX_TOOL_ARGS_BYTES || args.trim() === '') return null;
    let input: unknown;
    try { input = JSON.parse(args); } catch { return null; }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
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
  const calls = choice.message.tool_calls ?? [];
  const toolUses = validateToolCalls(calls.map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })), ctx.tools);
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
      outputChars: content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : JSON.stringify(b.input).length), 0),
    }),
  };
}
