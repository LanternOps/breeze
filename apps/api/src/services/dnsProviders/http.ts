const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

interface RequestJsonInit extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
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
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, ...fetchInit } = init;

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
      const response = await fetch(input, {
        ...fetchInit,
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
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const isNetwork = error instanceof TypeError;
      if (attempt < maxRetries && (isAbort || isNetwork)) {
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
