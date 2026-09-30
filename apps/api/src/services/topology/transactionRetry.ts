import { pgErrorCode } from '@breeze/shared/pgErrors';

/** Deadlock, serialization failure and NOWAIT lock conflict: retry the WHOLE
 * transaction in a fresh context. Never catch/retry a PostgreSQL-aborted
 * transaction inside its old context. Shared by the outbox repair tick and
 * the first-snapshot bootstrap pass (#7557). */
export function retryableTopologyTransaction(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === '40P01' || code === '40001' || code === '55P03';
}

// SQLSTATE classes that describe the connection/server, not the site's data:
// 08 connection exception, 53 insufficient resources, 57 operator
// intervention (57014 statement timeout, 57P01 admin shutdown), 58 system error.
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58']);

/** True for failures of the database/driver rather than of the work itself:
 * the SQLSTATE classes above, idle-in-transaction timeout (25P03), and any
 * non-SQLSTATE code (driver/socket level: ECONNRESET, CONNECTION_CLOSED,
 * CONNECT_TIMEOUT, ...). Callers must not record such a failure against a
 * tenant's site as if its data were at fault. */
export function transientTopologyInfrastructureError(error: unknown): boolean {
  const code = pgErrorCode(error);
  if (!code) return false;
  if (!/^[0-9A-Z]{5}$/.test(code)) return true;
  return code === '25P03' || TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
}
