/**
 * Guarded fetch adapter for one-shot Anthropic-compatible clients (#3922 phase
 * 2, Wave 2, Task 2.1).
 *
 * Any `@anthropic-ai/sdk` client constructed against a catalog/operator-
 * supplied `baseUrl` is attacker-influenced the moment the caller who supplied
 * that URL is (a platform admin running the fidelity harness, or a resolved
 * partner catalog endpoint). `buildGuardedLlmFetch` is the single `fetch`
 * implementation every such client is handed, and it closes two independent
 * holes:
 *
 *  - **Origin pinning.** Anything not on the pinned origin is refused before a
 *    socket is opened, so the client cannot be steered elsewhere by a
 *    malicious or buggy response (a rewritten request, a client-library bug
 *    that appends "helper" endpoints, etc.).
 *  - **Connect-time SSRF pinning + no redirects.** Delegates to `safeFetch`
 *    (`services/urlSafety.ts`), which resolves DNS once and dials only a
 *    validated public IP — closing the classic rebind-between-validate-and-
 *    connect window — and always with `redirect: 'error'`, so a 3xx surfaces
 *    to the SDK as an error instead of becoming a second, unvalidated request.
 *
 *  - **Bounded response body.** `safeFetch` buffers the whole body in memory
 *    (it is not a streaming client), so an attacker-influenced endpoint that
 *    answers at line rate for the SDK's 60s timeout is a memory-exhaustion
 *    vector. Every guarded client therefore carries a hard `maxBytes` ceiling
 *    that a caller-supplied `init` cannot widen.
 *
 * Every attempt — success, policy refusal, or transport failure — is reported
 * once to the caller-supplied `recordEgress` audit hook (see
 * `llmEgressRecorder.ts`, Task 2.3), carrying `blocked` so the audit table can
 * never assert that traffic reached a host it did not. That hook is
 * fire-and-forget by contract: a throwing recorder must never fail (or rescue)
 * the LLM request it is merely observing.
 */
import { safeFetch } from '../urlSafety';

/**
 * Ceiling on the buffered response body for a guarded LLM call. Anthropic
 * `/v1/messages` responses are JSON in the low hundreds of KB even at the
 * largest `max_tokens`; 8 MiB is far above any legitimate answer and far below
 * anything that threatens the API process.
 */
export const DEFAULT_MAX_LLM_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A request the guarded fetch refused to make. Never carries a response body. */
export class LlmEgressViolationError extends Error {
  readonly status = 502;
  readonly code = 'llm_egress_blocked';

  constructor(message: string) {
    super(message);
    this.name = 'LlmEgressViolationError';
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof (input as Request).url === 'string') return (input as Request).url;
  throw new LlmEgressViolationError('unrecognised request target');
}

/**
 * One guarded-fetch attempt. Mirrors `LlmEgressAttempt` in `llmEgressProxy.ts`
 * so both egress paths feed the recorder the same shape.
 *
 * `blocked` is true whenever no response came back from the pinned origin —
 * an origin-pin refusal, an unparseable target, an SSRF refusal inside
 * `safeFetch`, or a transport failure. `resolvedIp` separates the two:
 * `null` means no socket was ever opened to a validated IP.
 */
export interface GuardedLlmFetchAttempt {
  host: string;
  resolvedIp: string | null;
  blocked: boolean;
}

export interface GuardedLlmFetchOptions {
  /** e.g. 'https://openrouter.ai' — every request must resolve to exactly this origin. */
  allowedOrigin: string;
  /**
   * Fire-and-forget audit callback, invoked exactly once per attempt —
   * including attempts refused at the origin-pinning step, which are recorded
   * with `blocked: true` rather than silently dropped. Must not throw into the
   * call path — a throw is caught and swallowed here regardless.
   */
  recordEgress: (e: GuardedLlmFetchAttempt) => void;
  /**
   * Hard ceiling on the buffered response body, in bytes. Defaults to
   * {@link DEFAULT_MAX_LLM_RESPONSE_BYTES}. A caller-supplied `init.maxBytes`
   * never widens it — the guard is the point.
   */
  maxResponseBytes?: number;
}

/** Never let an unparseable target string grow the audit row without bound. */
const MAX_RECORDED_HOST_LENGTH = 255;

/**
 * Builds a `fetch` implementation suitable for the `@anthropic-ai/sdk`
 * `fetch` client option (and any other one-shot fetch-shaped client).
 */
export function buildGuardedLlmFetch(
  opts: GuardedLlmFetchOptions,
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_LLM_RESPONSE_BYTES;

  const record = (attempt: GuardedLlmFetchAttempt): void => {
    try {
      opts.recordEgress({
        ...attempt,
        host: attempt.host.slice(0, MAX_RECORDED_HOST_LENGTH),
      });
    } catch {
      // Fire-and-forget by contract — see the module doc comment above.
    }
  };

  return async (url, init) => {
    let target: string;
    try {
      target = requestUrl(url);
    } catch (error) {
      record({ host: '', resolvedIp: null, blocked: true });
      throw error;
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      // No host to attribute it to, but the attempt itself is still auditable —
      // recording the raw target is what distinguishes "the client tried
      // something nonsensical" from "nothing happened".
      record({ host: target, resolvedIp: null, blocked: true });
      throw new LlmEgressViolationError('blocked egress to an unparseable URL');
    }
    if (parsed.origin !== opts.allowedOrigin) {
      // A client steered off-origin is exactly the event the audit table
      // exists for — refusing it silently would leave no trace at all.
      record({ host: parsed.hostname, resolvedIp: null, blocked: true });
      throw new LlmEgressViolationError(
        `blocked egress to ${parsed.origin}; this client is pinned to ${opts.allowedOrigin}`,
      );
    }

    let resolvedIp: string | null = null;
    const onConnect = (ip: string): void => {
      resolvedIp = ip;
    };

    try {
      const response = await safeFetch(target, {
        ...init,
        // Always enforced — never let a caller-supplied `redirect: 'follow'`
        // (the SDK's default) weaken this. safeFetch never natively follows
        // redirects either way; this is defense-in-depth documentation of
        // that contract at the call site.
        redirect: 'error',
        // After the spread, so a caller-supplied maxBytes cannot widen it.
        maxBytes,
        onConnect,
      } as Parameters<typeof safeFetch>[1]);
      record({ host: parsed.hostname, resolvedIp, blocked: false });
      return response;
    } catch (error) {
      // Nothing came back from the pinned origin — an SSRF refusal, an
      // oversized body, or a transport failure. All are `blocked: true`: the
      // audit row must never claim a response arrived when none did.
      record({ host: parsed.hostname, resolvedIp, blocked: true });
      throw error;
    }
  };
}
