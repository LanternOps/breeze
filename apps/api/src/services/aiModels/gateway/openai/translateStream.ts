import { GATEWAY_MAX_TOOL_ARGS_BYTES, GATEWAY_MAX_TOOL_CALLS } from '../limits';
import { scrubSecrets } from '../scrub';
import { encodeSse, parseSse } from './sse';
import { mapFinish, resolveUsage, UNSAFE_TOOL_CALL_NOTE, validateToolCalls } from './translateResponse';
import type { OaiChatChoice, OaiChatResponse, OaiUsage, ToolNameMap } from './types';

interface PendingCall { id?: string; name?: string; arguments: string; bytes: number }
type ToolCallDelta = NonNullable<NonNullable<OaiChatChoice['delta']>['tool_calls']>[number];

export interface TranslateStreamContext {
  model: string;
  tools: ToolNameMap;
  messageId: string;
  estimatedInputTokens: number;
  /** Diagnostics only: identify the grant/connection in warnings. */
  grantId?: string;
  connectionId?: string;
  /** Secrets scrubbed from any logged text (the connection credential). */
  secrets?: ReadonlyArray<string | null>;
}

/**
 * Finish reasons that mark a complete answer. Anything else (an unknown value)
 * does not, so a stream only counts as complete after one of these or the
 * `[DONE]` sentinel — never after an unrecognised finish followed by EOF.
 */
const TERMINAL_FINISH_REASONS: ReadonlySet<unknown> = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

const LOG_TEXT_MAX = 200;

function errorEvent(message: string): Uint8Array {
  return encodeSse('error', { type: 'error', error: { type: 'api_error', message } });
}

/**
 * Groups streamed tool-call fragments into calls. Fragments are keyed by
 * `index` when the endpoint sends one (a different `id` at an index already in
 * use starts a new call); without an index, by `id` when present; otherwise a
 * fragment carrying a new `function.name` starts a new call and any other
 * fragment continues the most recent one.
 */
class ToolCallAssembler {
  readonly calls: PendingCall[] = [];
  private readonly byIndex = new Map<number, PendingCall>();
  private readonly byId = new Map<string, PendingCall>();
  private last: PendingCall | null = null;

  private start(): PendingCall {
    const call: PendingCall = { arguments: '', bytes: 0 };
    this.calls.push(call);
    return call;
  }

  private callFor(tc: ToolCallDelta): PendingCall {
    const id = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : undefined;
    const name = typeof tc.function?.name === 'string' && tc.function.name.length > 0 ? tc.function.name : undefined;
    const known = id !== undefined ? this.byId.get(id) : undefined;
    if (known) return known;
    if (typeof tc.index === 'number') {
      const existing = this.byIndex.get(tc.index);
      if (existing && !(id !== undefined && existing.id !== undefined && existing.id !== id)) return existing;
      const call = this.start();
      this.byIndex.set(tc.index, call);
      return call;
    }
    if (id !== undefined) return this.start();
    if (name !== undefined) return this.last && this.last.name === undefined ? this.last : this.start();
    return this.last ?? this.start();
  }

  /** Adds one fragment; returns the call it landed in. */
  add(tc: ToolCallDelta): PendingCall {
    const call = this.callFor(tc);
    if (typeof tc.id === 'string' && tc.id.length > 0 && call.id === undefined) {
      call.id = tc.id;
      this.byId.set(tc.id, call);
    }
    if (tc.function?.name && !call.name) call.name = tc.function.name;
    this.last = call;
    return call;
  }
}

/**
 * OpenAI chat-completions SSE → Anthropic Messages SSE. Tool calls are buffered
 * and validated as a batch. As soon as one call's arguments exceed the per-call
 * byte cap, or the number of distinct calls exceeds the call cap, the stream is
 * abandoned: the upstream is no longer read (leaving the loop cancels it) and
 * only the visible note is emitted. A stream that ends without `[DONE]` or a
 * recognised finish reason is incomplete and ends with an `error` event, never
 * a clean end_turn.
 */
export async function* translateChatStream(
  upstream: AsyncIterable<Uint8Array>,
  ctx: TranslateStreamContext,
): AsyncIterable<Uint8Array> {
  let index = 0;
  let textOpen = false;
  let finish: string | null = null;
  let sawDone = false;
  let overLimit = false;
  let emittedChars = 0;
  let argChars = 0;
  let usage: OaiUsage | null = null;
  const assembler = new ToolCallAssembler();

  const warn = (what: string, detail?: string): void => {
    const ids = `grant ${ctx.grantId ?? 'unknown'}, connection ${ctx.connectionId ?? 'unknown'}`;
    const suffix = detail ? `: ${scrubSecrets(detail, ctx.secrets ?? [], LOG_TEXT_MAX)}` : '';
    console.warn(`[modelGateway] ${what} (${ids})${suffix}`);
  };

  yield encodeSse('message_start', {
    type: 'message_start',
    message: { id: ctx.messageId, type: 'message', role: 'assistant', model: ctx.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });

  try {
    for await (const { data } of parseSse(upstream)) {
      if (data.trim() === '[DONE]') { sawDone = true; break; }
      let chunk: OaiChatResponse;
      try { chunk = JSON.parse(data) as OaiChatResponse; } catch (error) {
        warn('malformed upstream stream event', error instanceof Error ? error.message : String(error));
        yield errorEvent('The endpoint sent a malformed stream event.');
        return;
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          textOpen = true;
        }
        emittedChars += delta.content.length;
        yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = assembler.add(tc);
        const piece = tc.function?.arguments;
        if (typeof piece === 'string' && piece.length > 0) {
          cur.arguments += piece;
          cur.bytes += Buffer.byteLength(piece, 'utf8');
          argChars += piece.length;
        }
        if (cur.bytes > GATEWAY_MAX_TOOL_ARGS_BYTES || assembler.calls.length > GATEWAY_MAX_TOOL_CALLS) { overLimit = true; break; }
      }
      if (overLimit) break;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (error) {
    warn('upstream stream failed', error instanceof Error ? error.message : String(error));
    yield errorEvent('The endpoint stream failed.');
    return;
  }

  const terminated = sawDone || TERMINAL_FINISH_REASONS.has(finish);
  if (!overLimit && !terminated) {
    warn('upstream stream ended without [DONE] or a recognised finish reason');
    yield errorEvent('The endpoint stream ended early.');
    return;
  }
  const toolUses = overLimit ? null : validateToolCalls(assembler.calls, ctx.tools);
  if (toolUses === null) {
    if (!textOpen) {
      yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      textOpen = true;
    }
    yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: UNSAFE_TOOL_CALL_NOTE } });
  }
  if (textOpen) { yield encodeSse('content_block_stop', { type: 'content_block_stop', index }); index += 1; }
  for (const tu of toolUses ?? []) {
    yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} } });
    yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input) } });
    yield encodeSse('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  const stop = mapFinish(finish, (toolUses?.length ?? 0) > 0);
  // Billed output covers everything the model generated, including rejected tool-call arguments.
  const u = resolveUsage(usage, { inputTokens: ctx.estimatedInputTokens, outputChars: emittedChars + argChars });
  yield encodeSse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: null } } : {}) },
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: 0 },
  });
  yield encodeSse('message_stop', { type: 'message_stop' });
}
