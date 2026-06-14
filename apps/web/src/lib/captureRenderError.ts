import * as Sentry from '@sentry/astro';

/**
 * Capture a server render error to Sentry and return its event ID so the 500
 * page can show the user a reference code. Never throws — error reporting must
 * not be able to break the error page itself. Returns null when there is no
 * error to report or capture failed/produced no id.
 */
export function captureRenderError(error: unknown): string | null {
  if (error == null) return null;
  try {
    return Sentry.captureException(error) ?? null;
  } catch {
    return null;
  }
}
