/**
 * OpenAI-compatible LLM provider (chat-only PoC).
 *
 * Calls any OpenAI-compatible endpoint (target: vLLM) with manual SSE parsing.
 * No `openai` npm package dependency.
 *
 * Egress goes through `safeFetch` (#4121), never raw global `fetch`. The
 * endpoint comes from operator config (`MCP_LLM_BASE_URL`) rather than from a
 * tenant, so this is defense in depth rather than a live exploit fix — but a
 * module that dials an operator-supplied URL with no DNS pinning and no
 * redirect discipline is exactly the exception that quietly becomes a real
 * SSRF hole the first time someone extends it. Routing through the shared
 * helper also brings this path under the #1105 held-DB-context tripwire, which
 * a direct `fetch()` bypasses entirely.
 *
 * `streamResponse: true` is load-bearing: `safeFetch`'s default mode buffers
 * the whole body before resolving, which would collapse an incremental SSE
 * chat stream into a single burst delivered after the turn ended.
 *
 * Tool-calling is explicitly unsupported on this path: we send no `tools` field.
 * If the model returns tool_calls anyway, we yield an error event and stop.
 *
 * Prompt caching: vLLM has no equivalent to Anthropic's prompt caching.
 * Cost tracking is best-effort via declared per-token pricing in config.
 */

import { safeFetch, SsrfBlockedError } from '../urlSafety';
import { selfHostAllowsPrivateNetwork } from '../../config/env';
import type { LLMProvider, LLMStreamEvent, ChatMessage } from './types';

const FETCH_TIMEOUT_MS = 6 * 60 * 1000; // 6 min, aligned with Anthropic turn timeout
const LLM_REQUEST_TIMEOUT_MESSAGE = 'LLM request timed out after 6 minutes';

/**
 * Ceiling on a single streamed turn. Nothing is accumulated in memory (the body
 * is consumed as it arrives), so this exists to bound a hostile or wedged
 * endpoint that answers at line rate for the full six-minute timeout rather
 * than to cap a buffer. SSE framing costs ~60 bytes of JSON envelope per token,
 * so even a 100k-token answer lands around 6 MB — 32 MiB leaves generous room
 * above any legitimate turn while still being a hard stop.
 */
const MAX_STREAM_RESPONSE_BYTES = 32 * 1024 * 1024;

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
      response = await safeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body,
        signal,
        // Inert inside safeFetch (it never follows a Location and hands back
        // the raw 3xx), but stated at the call site so the intent survives:
        // a redirect on a POST carrying a bearer token is refused, not chased.
        // The explicit 3xx check below is what actually enforces it.
        redirect: 'error',
        // Without this the body would be buffered to completion and the chat
        // would stop streaming. See the module comment.
        streamResponse: true,
        maxBytes: MAX_STREAM_RESPONSE_BYTES,
        // Same pair `webhookDelivery` uses. `MCP_LLM_PROVIDER=openai-compatible`
        // is a self-host-only path and a self-hosted vLLM normally lives on the
        // operator's LAN, so without the opt-in every such deployment would
        // fail with "URL points to blocked address"; `requirePrivateForCleartext`
        // keeps the cleartext allowance confined to that LAN hop instead of
        // letting an `http://` endpoint ship the API key over the open internet.
        allowPrivateNetwork: selfHostAllowsPrivateNetwork(),
        requirePrivateForCleartext: true,
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
      if (err instanceof SsrfBlockedError) {
        // The operator set this URL in their own env, so the fix is theirs to
        // make — say what is actually allowed instead of just "blocked address".
        yield {
          type: 'error',
          message:
            `LLM endpoint refused by the egress guard: ${err.message}. MCP_LLM_BASE_URL must ` +
            'point at a public host, or — on a self-hosted install with IS_HOSTED=false — an ' +
            'RFC1918/ULA LAN address. Loopback (127.0.0.1/::1) is never dialable; use the ' +
            "service name or LAN IP of the model host instead of 'localhost'.",
        };
        return;
      }
      const msg = err instanceof Error ? err.message : 'Network error calling LLM endpoint';
      yield { type: 'error', message: msg };
      return;
    }

    // `safeFetch` deliberately follows nothing and returns the raw 3xx, so the
    // refusal has to be explicit here. `!response.ok` below would also catch it,
    // but only incidentally — and the operator deserves to be told the endpoint
    // tried to redirect rather than a bare "HTTP 302". Following it would be an
    // SSRF bypass and would replay the bearer token at whatever the Location says.
    if (response.status >= 300 && response.status < 400) {
      // Release the socket before disarming the timeout that protects it.
      // `cancel()` cannot reject with today's stream teardown, but a floating
      // promise here would become an unhandled rejection if that ever changed.
      void response.body?.cancel().catch(() => { /* socket is going away anyway */ });
      clearTimeout(timeoutId);
      yield {
        type: 'error',
        message:
          `LLM endpoint error: refused to follow a redirect (HTTP ${response.status}) from the ` +
          'configured endpoint. Point MCP_LLM_BASE_URL at the endpoint that serves the response.',
      };
      return;
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        // The body is a LIVE stream now, so this read can block. The turn
        // timeout has to stay armed across it — clearing it first (as the
        // buffered version safely could) would let an endpoint that sends
        // error headers and then stalls hang the turn forever.
        const text = await response.text();
        detail += `: ${text.slice(0, 300)}`;
      } catch (readErr) {
        // The status still reaches the user; only the extra detail is lost. Say
        // why, so a transport failure while reading an error page (or a
        // maxBytes truncation) leaves a trail instead of looking like an
        // endpoint that returned an empty error body.
        const why = readErr instanceof Error ? readErr.message : String(readErr);
        console.warn(`openaiCompatibleProvider: could not read the error body for ${detail}: ${why}`);
      } finally {
        clearTimeout(timeoutId);
      }
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

              // Some OpenAI-compatible backends return `delta.content` as a multipart
              // array; vLLM does not today, so non-string content is silently dropped.
              // Revisit if a future backend emits multipart chunks here.
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
