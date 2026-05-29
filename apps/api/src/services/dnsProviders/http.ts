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

function toErrorMessage(status: number, statusText: string, body: string): string {
  const trimmed = body.trim();
  const bodyPreview = trimmed.length > 0 ? trimmed.slice(0, 400) : '<empty>';
  return `HTTP ${status} ${statusText}: ${bodyPreview}`;
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
        throw new Error(toErrorMessage(response.status, response.statusText, text));
      }

      if (!text.trim()) {
        return {} as T;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Provider returned invalid JSON payload: ${text.slice(0, 300)}`);
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
      const isNetwork =
        error instanceof TypeError ||
        (error instanceof Error &&
          !isSsrfBlocked &&
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
