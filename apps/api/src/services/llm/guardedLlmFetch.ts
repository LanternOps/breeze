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
 * Every call — success or failure — is reported once to the caller-supplied
 * `recordEgress` audit hook (see `llmEgressRecorder.ts`, Task 2.3). That hook
 * is fire-and-forget by contract: a throwing recorder must never fail the LLM
 * request it is merely observing.
 */
import { safeFetch } from '../urlSafety';

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

export interface GuardedLlmFetchOptions {
  /** e.g. 'https://openrouter.ai' — every request must resolve to exactly this origin. */
  allowedOrigin: string;
  /**
   * Fire-and-forget audit callback, invoked once per request that reaches
   * `safeFetch` (never for a request blocked at the origin-pinning step,
   * which made no network attempt to record). Must not throw into the call
   * path — a throw is caught and swallowed here regardless.
   */
  recordEgress: (e: { host: string; resolvedIp: string | null }) => void;
}

/**
 * Builds a `fetch` implementation suitable for the `@anthropic-ai/sdk`
 * `fetch` client option (and any other one-shot fetch-shaped client).
 */
export function buildGuardedLlmFetch(
  opts: GuardedLlmFetchOptions,
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const target = requestUrl(url);
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new LlmEgressViolationError('blocked egress to an unparseable URL');
    }
    if (parsed.origin !== opts.allowedOrigin) {
      throw new LlmEgressViolationError(
        `blocked egress to ${parsed.origin}; this client is pinned to ${opts.allowedOrigin}`,
      );
    }

    let resolvedIp: string | null = null;
    const onConnect = (ip: string): void => {
      resolvedIp = ip;
    };

    try {
      return await safeFetch(target, {
        ...init,
        // Always enforced — never let a caller-supplied `redirect: 'follow'`
        // (the SDK's default) weaken this. safeFetch never natively follows
        // redirects either way; this is defense-in-depth documentation of
        // that contract at the call site.
        redirect: 'error',
        onConnect,
      } as Parameters<typeof safeFetch>[1]);
    } finally {
      try {
        opts.recordEgress({ host: parsed.hostname, resolvedIp });
      } catch {
        // Fire-and-forget by contract — see the class doc comment above.
      }
    }
  };
}
