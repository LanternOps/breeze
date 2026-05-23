/**
 * OpenAI-compatible LLM provider (chat-only PoC).
 *
 * Uses native Node fetch + manual SSE parsing to call any OpenAI-compatible endpoint
 * (target: vLLM). No `openai` npm package dependency.
 *
 * Tool-calling is explicitly unsupported on this path: we send no `tools` field.
 * If the model returns tool_calls anyway, we yield an error event and stop.
 *
 * Prompt caching: vLLM has no equivalent to Anthropic's prompt caching.
 * Cost tracking is best-effort via declared per-token pricing in config.
 */

import type { LLMProvider, LLMStreamEvent, ChatMessage } from './types';

const FETCH_TIMEOUT_MS = 6 * 60 * 1000; // 6 min, aligned with Anthropic turn timeout
const LLM_REQUEST_TIMEOUT_MESSAGE = 'LLM request timed out after 6 minutes';

/**
 * Abort comes from AbortSignal.any([caller, timeout]): distinguish timeout vs user Stop.
 */
function classifyOpenAICompatAbort(
  timeoutSignal: AbortSignal,
  callerSignal?: AbortSignal,
): 'timeout' | 'user' | null {
  if (timeoutSignal.aborted) return 'timeout';
  if (callerSignal?.aborted) return 'user';
  return null;
}

// OpenAI streaming chunk shape (minimal subset we care about)
interface OAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: unknown[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

export interface OpenAICompatibleProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** Price per million input tokens in USD (default 0) */
  priceInputPerMUsd: number;
  /** Price per million output tokens in USD (default 0) */
  priceOutputPerMUsd: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAICompatibleProviderConfig) {}

  async *chatStream(
    messages: ChatMessage[],
    options: {
      model: string;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<LLMStreamEvent> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      // Explicitly no `tools` or `tool_choice` field.
    });

    // Combine caller's abort signal with a per-request timeout.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body,
        signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const abortKind = classifyOpenAICompatAbort(timeoutController.signal, options.signal);
      if (abortKind === 'timeout') {
        yield { type: 'error', message: LLM_REQUEST_TIMEOUT_MESSAGE };
        return;
      }
      if (abortKind === 'user') {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Network error calling LLM endpoint';
      yield { type: 'error', message: msg };
      return;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      let detail = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        detail += `: ${text.slice(0, 300)}`;
      } catch { /* ignore */ }
      yield { type: 'error', message: `LLM endpoint error: ${detail}` };
      return;
    }

    if (!response.body) {
      clearTimeout(timeoutId);
      yield { type: 'error', message: 'LLM endpoint returned empty body' };
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by \r\n\r\n or \n\n (spec allows both;
          // normalise so proxies that add \r\n don't break parsing).
          const parts = buffer.split(/\r?\n\r?\n/);
          // Keep the last potentially-incomplete event in the buffer.
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            for (const line of part.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;

              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;

              let chunk: OAIChunk;
              try {
                chunk = JSON.parse(payload) as OAIChunk;
              } catch {
                continue;
              }

              // Usage is sometimes in the final chunk (stream_options.include_usage)
              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
                outputTokens = chunk.usage.completion_tokens ?? outputTokens;
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              // Defensive: reject tool_calls even though we didn't request them.
              // Check both delta.tool_calls and finish_reason since some backends
              // signal tool use via finish_reason rather than (or in addition to) delta.
              const hasToolCallDelta =
                choice.delta?.tool_calls != null && (choice.delta.tool_calls as unknown[]).length > 0;
              const hasToolCallFinishReason = choice.finish_reason === 'tool_calls';

              if (hasToolCallDelta || hasToolCallFinishReason) {
                yield {
                  type: 'error',
                  message:
                    'Tool calling is not supported on the openai-compatible path. ' +
                    'Use the Anthropic backend for tool-enabled sessions.',
                };
                return;
              }

              if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
                yield { type: 'content_delta', delta: choice.delta.content };
              }
            }
          }
        }
      } catch (err) {
        const abortKind = classifyOpenAICompatAbort(timeoutController.signal, options.signal);
        if (abortKind === 'timeout') {
          yield { type: 'error', message: LLM_REQUEST_TIMEOUT_MESSAGE };
          return;
        }
        if (abortKind === 'user') {
          return;
        }
        const msg = err instanceof Error ? err.message : 'Error reading LLM stream';
        yield { type: 'error', message: msg };
        return;
      }
    } finally {
      clearTimeout(timeoutId);
      // Cancel the stream so the underlying socket is released promptly,
      // including on early break (e.g. session closing mid-stream).
      try { await reader.cancel(); } catch { /* ignore */ }
      reader.releaseLock();
    }

    yield { type: 'message_end', inputTokens, outputTokens };
  }

  /** Compute best-effort cost in USD from token counts */
  computeCostUsd(inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens * this.config.priceInputPerMUsd +
        outputTokens * this.config.priceOutputPerMUsd) /
      1_000_000
    );
  }
}
