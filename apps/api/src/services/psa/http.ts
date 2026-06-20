import { checkSsrfSafe } from '../ssrfGuard';
import { safeFetch, SsrfBlockedError, type SafeFetchInit } from '../urlSafety';

const DEFAULT_PSA_TIMEOUT_MS = 20_000;

export function validatePsaBaseUrl(rawUrl: string): string | null {
  const result = checkSsrfSafe(rawUrl, { mode: 'strict-https' });
  return result.ok ? null : result.reason ?? 'URL is not safe';
}

export async function psaFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const rawUrl = String(input);
  const staticError = validatePsaBaseUrl(rawUrl);
  if (staticError) {
    throw new SsrfBlockedError(`PSA URL rejected: ${staticError}`);
  }

  return safeFetch(rawUrl, {
    timeoutMs: DEFAULT_PSA_TIMEOUT_MS,
    redirect: 'error',
    ...init,
  });
}
