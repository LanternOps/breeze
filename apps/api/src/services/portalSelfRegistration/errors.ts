/**
 * PII-safe error reporting for self-registration (portal registration W6).
 * The flow carries a requester's address and name, and a failed query's
 * message embeds its parameters, so nothing here ever logs or reports an
 * original error's message, stack or cause — only its class (and a bounded
 * `code` when it is a short token such as an ioredis or SQLSTATE code).
 */
import { captureException } from '../sentry';

const SAFE_CODE = /^[A-Z0-9_]{1,32}$/;

/** `{ error: <class>, code?: <bounded code> }` for a log line. */
export function safeErrorFields(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.name : 'unknown';
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  return SAFE_CODE.test(code) ? { error, code } : { error };
}

/** A fresh Error that names the failure and the original class only (no message, no cause). */
export function sanitizedError(what: string, err?: unknown): Error {
  const fields = err === undefined ? null : safeErrorFields(err);
  return new Error(`[portal-self-registration] ${what}${fields ? `: ${fields.error}${fields.code ? ` (${fields.code})` : ''}` : ''}`);
}

/** Report a sanitized failure to Sentry. */
export function reportSelfRegistrationFailure(what: string, err?: unknown): void {
  captureException(sanitizedError(what, err));
}
