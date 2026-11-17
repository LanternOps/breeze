import type { WakeFailureCode } from './wakeOnLan';

/**
 * HTTP status for a refused/failed wake. WAKE_LOOKUP_FAILED is a transient
 * policy-lookup failure (nothing was attempted), so it is a retryable 503;
 * every other code is a precondition failure (412).
 */
export function wakeFailureStatus(code: WakeFailureCode): 412 | 503 {
  return code === 'WAKE_LOOKUP_FAILED' ? 503 : 412;
}
