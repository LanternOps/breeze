import { safeFetch } from '../urlSafety';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

interface RequestJsonInit extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Opt-in for on-prem appliance providers (Pi-hole / AdGuard Home on
   * self-hosted deployments). Allows RFC1918/ULA targets while still blocking
   * metadata/loopback/link-local/CGNAT. Hosted SaaS leaves this unset (strict).
   */
  allowPrivateNetwork?: boolean;
}

/**
 * Error thrown for a non-2xx (or unparseable) DNS provider response.
 *
 * SECURITY: `.message` is deliberately body-free — for an HTTP error it is just
 * the `HTTP <status> <statusText>` status line. The raw upstream response body
 * is preserved on `.responseBody` for SERVER-SIDE logging ONLY. It must never be
 * persisted to a tenant-visible column (e.g. `dns_filter_integrations.lastSyncError`
 * or `dns_policies.syncError`): for self-hosted Pi-hole/AdGuard providers the
 * tenant supplies the endpoint host, so reflecting an upstream body back to them
 * is a partial-read oracle / confused-deputy for arbitrary public hosts.
 */
export class DnsProviderHttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;

  constructor(
    status: number,
    statusText: string,
    responseBody: string,
    /** Optional body-free message override; defaults to the status line. */
    message?: string
  ) {
    super(message ?? `HTTP ${status} ${statusText}`);
    this.name = 'DnsProviderHttpError';
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
  }
}

export async function requestJson<T>(
  input: string | URL,
  init: RequestJsonInit = {}
): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    allowPrivateNetwork,
    ...fetchInit
  } = init;

  const parseRetryAfterMs = (header: string | null): number | null => {
    if (!header) return null;
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.min(asSeconds * 1000, 60_000);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) {
      return Math.max(0, Math.min(at - Date.now(), 60_000));
    }
    return null;
  };

  const computeBackoffMs = (attempt: number, retryAfterHeader: string | null): number => {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== null) return retryAfterMs;
    const base = 500 * (2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(base + jitter, 10_000);
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

  const isRetriableStatus = (status: number): boolean => {
    return status === 429 || status >= 500;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await safeFetch(String(input), {
        ...fetchInit,
        timeoutMs,
        allowPrivateNetwork,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(fetchInit.headers ?? {})
        }
      });

      const text = await response.text();
      if (!response.ok) {
        if (attempt < maxRetries && isRetriableStatus(response.status)) {
          await sleep(computeBackoffMs(attempt, response.headers.get('retry-after')));
          continue;
        }
        // Body-free `.message` (status line); raw body kept on `.responseBody`
        // for server-side logging only — never reflect it to the tenant.
        throw new DnsProviderHttpError(response.status, response.statusText, text);
      }

      if (!text.trim()) {
        return {} as T;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        // Same rule for an unparseable 2xx body: body-free message, raw text
        // retained on `.responseBody` for server-side logging only.
        throw new DnsProviderHttpError(
          response.status,
          response.statusText,
          text,
          'Provider returned invalid JSON payload'
        );
      }
    } catch (error) {
      // An SSRF policy violation must NOT be retried — fail fast. SsrfBlockedError
      // is a plain Error subclass (not a TypeError), so the network checks below
      // never match it; we additionally guard by name for clarity.
      const isSsrfBlocked = error instanceof Error && error.name === 'SsrfBlockedError';
      const isAbort = error instanceof Error && error.name === 'AbortError';
      // safeFetch surfaces transport/TLS failures as plain Error (with `cause`)
      // and timeouts/aborts as Error('request timed out…')/Error('aborted'). Treat
      // those — plus the legacy fetch TypeError — as retriable transient failures.
      // A DnsProviderHttpError reaching here is a non-retriable 4xx (or an already
      // retry-exhausted 5xx) / invalid-JSON — never retry it.
      const isNetwork =
        error instanceof TypeError ||
        (error instanceof Error &&
          !isSsrfBlocked &&
          !(error instanceof DnsProviderHttpError) &&
          (/timed out/i.test(error.message) ||
            error.message === 'aborted' ||
            error.message === 'socket hang up' ||
            'cause' in error));
      if (attempt < maxRetries && !isSsrfBlocked && (isAbort || isNetwork)) {
        await sleep(computeBackoffMs(attempt, null));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Provider request failed after retries');
}
