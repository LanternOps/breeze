import { pgErrorCode } from '@breeze/shared/pgErrors';

/** Deadlock, serialization failure and NOWAIT lock conflict: retry the WHOLE
 * transaction in a fresh context. Never catch/retry a PostgreSQL-aborted
 * transaction inside its old context. Shared by the outbox repair tick and
 * the first-snapshot bootstrap pass (#7557). */
export function retryableTopologyTransaction(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === '40P01' || code === '40001' || code === '55P03';
}
