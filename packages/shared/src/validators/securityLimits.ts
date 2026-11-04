import { z } from 'zod';

/**
 * Bounds of the scalar limits in `settings.security` (#10081). One source for
 * the API write boundary (`PATCH /orgs/partners/me`) and the partner settings
 * form, so the form flags a value the server would reject before it is sent,
 * and the two cannot drift apart.
 *
 * `max` is omitted where the server sets no ceiling.
 */
export const SECURITY_LIMIT_BOUNDS = {
  minLength: { min: 6, max: 128 },
  expirationDays: { min: 0 },
  sessionTimeout: { min: 1, max: 720 },
  maxSessions: { min: 1 },
} as const satisfies Record<string, { min: number; max?: number }>;

/** #6111 — ceiling for `settings.security.sessionTimeout` (minutes): 12 hours. */
export const SESSION_TIMEOUT_MAX_MINUTES = SECURITY_LIMIT_BOUNDS.sessionTimeout.max;

export const sessionTimeoutMinutesSchema = z
  .number()
  .int()
  .min(SECURITY_LIMIT_BOUNDS.sessionTimeout.min)
  .max(SESSION_TIMEOUT_MAX_MINUTES, {
    message: `Session timeout cannot exceed ${SESSION_TIMEOUT_MAX_MINUTES} minutes (12 hours)`,
  });

/** One whole-number schema per scalar limit. Callers add `.nullable()`/`.optional()`. */
export const securityLimitSchemas = {
  minLength: z.number().int().min(SECURITY_LIMIT_BOUNDS.minLength.min).max(SECURITY_LIMIT_BOUNDS.minLength.max),
  expirationDays: z.number().int().min(SECURITY_LIMIT_BOUNDS.expirationDays.min),
  sessionTimeout: sessionTimeoutMinutesSchema,
  maxSessions: z.number().int().min(SECURITY_LIMIT_BOUNDS.maxSessions.min),
};

export type SecurityLimitKey = keyof typeof securityLimitSchemas;

export const SECURITY_LIMIT_KEYS = Object.keys(securityLimitSchemas) as SecurityLimitKey[];

/** True when `value` is unset or a value the server accepts for this limit. */
export function isValidSecurityLimit(key: SecurityLimitKey, value: unknown): boolean {
  return value === undefined || value === null || securityLimitSchemas[key].safeParse(value).success;
}
