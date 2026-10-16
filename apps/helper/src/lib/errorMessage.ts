/**
 * Extract the human-readable `error` string from a helper API error response
 * body (`{"error":"..."}`). Returns `fallback` when the body is not JSON, has
 * no `error` key, or `error` is not a non-empty string. Never throws.
 */
export function errorMessageFromBody(body: string, fallback: string): string {
  try {
    const data = JSON.parse(body) as { error?: unknown } | null;
    const error = data?.error;
    return typeof error === 'string' && error ? error : fallback;
  } catch {
    return fallback;
  }
}
