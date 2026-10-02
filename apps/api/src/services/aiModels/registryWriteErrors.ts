/**
 * The one error mapper for AI model registry writes (W04, #7602).
 * Every /ai/models write path catches into toRegistryWriteError. An error that
 * carries SQL query values (DrizzleQueryError params, postgres.js parameters)
 * is never rethrown as-is: its params can hold key ciphertext and fingerprints
 * (safeDbError.ts header). Anything without query values is rethrown untouched
 * so programming bugs stay diagnosable.
 */
import { carriesQueryValues, errorSqlstate, formatSafeDbErrorDetail, safeDbErrorDetail } from './safeDbError';
import { OfferingWriteError } from './offerings';
import { ConnectionKeyError } from './connectionKeys';

export type RegistryWriteCode =
  | 'not_found' | 'unpriced' | 'not_eligible' | 'offering_in_use' | 'stale_write'
  | 'conflict' | 'invalid' | 'tools_unsupported' | 'widens_partner' | 'write_failed'
  | 'registry_busy';

export const REGISTRY_BUSY_MESSAGE = 'Another AI configuration change is in progress. Try again in a moment.';

/** W03 soft-disconnect: the offering's connection is kept as provenance only; nothing may edit, verify or re-enable it. */
export const CONNECTION_DISCONNECTED_MESSAGE = "This model's connection is disconnected.";

export class RegistryWriteError extends Error {
  constructor(
    message: string,
    readonly code: RegistryWriteCode,
    readonly status: 400 | 404 | 409 | 422 | 500 | 503,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RegistryWriteError';
  }
}

/**
 * Rethrows RegistryWriteError / OfferingWriteError / ConnectionKeyError as
 * RegistryWriteError, scrubs any error that carries query values into a 500
 * 'write_failed' (cause keeps SQLSTATE), maps 23505 → 409 conflict and
 * 23503/23514 → 422 invalid, and rethrows anything else untouched.
 */
export function toRegistryWriteError(error: unknown, fallbackMessage: string): never {
  if (error instanceof RegistryWriteError) throw error;
  if (error instanceof OfferingWriteError) {
    throw new RegistryWriteError(error.message, error.code, error.code === 'not_found' ? 404 : 409);
  }
  if (error instanceof ConnectionKeyError) {
    throw new RegistryWriteError(error.message, 'invalid', 400);
  }
  if (!carriesQueryValues(error)) throw error;

  const detail = safeDbErrorDetail(error);
  const sqlstate = errorSqlstate(error);
  const constraint = detail.constraint;
  let mapped: RegistryWriteError;
  if (sqlstate === '23505') {
    mapped = new RegistryWriteError('This conflicts with an existing setting.', 'conflict', 409, constraint ? { constraint } : undefined);
  } else if (sqlstate === '23503' || sqlstate === '23514') {
    mapped = new RegistryWriteError('That value is not allowed here.', 'invalid', 422, constraint ? { constraint } : undefined);
  } else {
    mapped = new RegistryWriteError(fallbackMessage, 'write_failed', 500);
  }
  const formatted = formatSafeDbErrorDetail(detail);
  mapped.cause = Object.assign(
    new Error(`AI model registry write failed: ${detail.kind}${formatted ? ` (${formatted})` : ''}`),
    sqlstate ? { code: sqlstate } : {},
  );
  throw mapped;
}
