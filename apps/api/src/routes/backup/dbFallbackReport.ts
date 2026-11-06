import { captureException } from '../../services/sentry';

/**
 * Report a database failure that backup verification falls back from. A fallback
 * gives a plausible answer, so the failure has to be visible somewhere other than
 * the answer. Reports the SQLSTATE or error name, never the error itself: a Drizzle
 * query error serializes its bound parameters into the message.
 */
export function reportBackupDbFallback(message: string, error: unknown): void {
  const { cause, code, name } = (error ?? {}) as { cause?: { code?: unknown }; code?: unknown; name?: unknown };
  const reason = String(cause?.code ?? code ?? name ?? 'unknown');
  console.warn(`${message} (${reason})`);
  captureException(new Error(`${message} (${reason})`));
}
