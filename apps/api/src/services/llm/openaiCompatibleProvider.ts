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

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body,
        signal: options.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error calling LLM endpoint';
      yield { type: 'error', message: msg };
      return;
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        detail += `: ${text.slice(0, 300)}`;
      } catch { /* ignore */ }
      yield { type: 'error', message: `LLM endpoint error: ${detail}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', message: 'LLM endpoint returned empty body' };
      return;
    }

    yield { type: 'message_start' };

    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE lines are separated by \n\n; each line may be "data: <json>" or "data: [DONE]"
        const parts = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          for (const line of part.split('\n')) {
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

            // Defensive: reject tool_calls even though we didn't request them
            if (choice.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
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
    } finally {
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
