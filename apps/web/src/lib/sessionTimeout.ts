/**
 * #6111 — ceiling for the Session Timeout setting (minutes): 12 hours.
 * Defined once in @breeze/shared (validators/securityLimits.ts), the same
 * module the API write boundary uses (#10081).
 */
export { SESSION_TIMEOUT_MAX_MINUTES } from '@breeze/shared';
