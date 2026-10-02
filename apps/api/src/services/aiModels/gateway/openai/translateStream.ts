import { GATEWAY_MAX_TOOL_ARGS_BYTES, GATEWAY_MAX_TOOL_CALLS } from '../limits';
import { encodeSse, parseSse } from './sse';
import { mapFinish, resolveUsage, UNSAFE_TOOL_CALL_NOTE, validateToolCalls } from './translateResponse';
import type { OaiChatResponse, OaiUsage, ToolNameMap } from './types';

interface PendingCall { id?: string; name?: string; arguments: string; bytes: number }

/**
 * Finish reasons that mark a complete answer. Anything else (an unknown value)
 * does not, so buffered tool calls are only released by one of these or by
 * the `[DONE]` sentinel — never by an unrecognised finish followed by EOF.
 */
const TERMINAL_FINISH_REASONS: ReadonlySet<unknown> = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

/**
 * OpenAI chat-completions SSE → Anthropic Messages SSE. Tool calls are buffered
 * and validated as a batch. As soon as one call's arguments exceed the per-call
 * byte cap, or the number of distinct calls exceeds the call cap, the stream is
 * abandoned: the upstream is no longer read (leaving the loop cancels it) and
 * only the visible note is emitted.
 */
export async function* translateChatStream(
  upstream: AsyncIterable<Uint8Array>,
  ctx: { model: string; tools: ToolNameMap; messageId: string; estimatedInputTokens: number },
): AsyncIterable<Uint8Array> {
  let index = 0;
  let textOpen = false;
  let finish: string | null = null;
  let sawDone = false;
  let overLimit = false;
  let emittedChars = 0;
  let argChars = 0;
  let usage: OaiUsage | null = null;
  const calls = new Map<number, PendingCall>();

  yield encodeSse('message_start', {
    type: 'message_start',
    message: { id: ctx.messageId, type: 'message', role: 'assistant', model: ctx.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });

  try {
    for await (const { data } of parseSse(upstream)) {
      if (data.trim() === '[DONE]') { sawDone = true; break; }
      let chunk: OaiChatResponse;
      try { chunk = JSON.parse(data) as OaiChatResponse; } catch {
        yield encodeSse('error', { type: 'error', error: { type: 'api_error', message: 'The endpoint sent a malformed stream event.' } });
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
        const cur = calls.get(tc.index) ?? { arguments: '', bytes: 0 };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name && !cur.name) cur.name = tc.function.name;
        const piece = tc.function?.arguments;
        if (typeof piece === 'string' && piece.length > 0) {
          cur.arguments += piece;
          cur.bytes += Buffer.byteLength(piece, 'utf8');
          argChars += piece.length;
        }
        calls.set(tc.index, cur);
        if (cur.bytes > GATEWAY_MAX_TOOL_ARGS_BYTES || calls.size > GATEWAY_MAX_TOOL_CALLS) { overLimit = true; break; }
      }
      if (overLimit) break;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch {
    yield encodeSse('error', { type: 'error', error: { type: 'api_error', message: 'The endpoint stream failed.' } });
    return;
  }

  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  const terminated = sawDone || TERMINAL_FINISH_REASONS.has(finish);
  const toolUses = overLimit || (calls.size > 0 && !terminated) ? null : validateToolCalls(ordered, ctx.tools);
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
