import { z } from 'zod';

export const MFA_PRIMARY_METHODS = ['totp', 'sms', 'passkey'] as const;
export type MfaPrimaryMethod = typeof MFA_PRIMARY_METHODS[number];

export const MFA_METHODS = [...MFA_PRIMARY_METHODS, 'recovery_code'] as const;
export type MfaMethod = typeof MFA_METHODS[number];

export const mfaAllowedMethodsSchema = z
  .object({
    totp: z.boolean().optional(),
    sms: z.boolean().optional(),
    passkey: z.boolean().optional(),
  })
  .strict()
  .refine(
    (methods) => MFA_PRIMARY_METHODS.some((method) => methods[method] === true),
    { message: 'At least one MFA method must be allowed' },
  );

export function preferCanonicalMfaAllowedMethodsInput(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const security = value as Record<string, unknown>;
  if (!Object.hasOwn(security, 'allowedMethods')) return value;
  const { allowedMfaMethods: _legacyAlias, ...canonical } = security;
  return canonical;
}

const mfaSecuritySettingsSchema = z
  .preprocess(preferCanonicalMfaAllowedMethodsInput, z.object({
    requireMfa: z.boolean().optional(),
    allowedMethods: mfaAllowedMethodsSchema.optional(),
    // Input/read migration alias only. The transform below always removes it.
    allowedMfaMethods: mfaAllowedMethodsSchema.optional(),
  })
  .passthrough())
  .transform(({ allowedMfaMethods, allowedMethods, ...security }) => ({
    ...security,
    ...(allowedMethods !== undefined
      ? { allowedMethods }
      : allowedMfaMethods !== undefined
        ? { allowedMethods: allowedMfaMethods }
        : {}),
  }));

/**
 * Validates only the MFA portion of the extensible settings JSON and preserves
 * unrelated keys. Legacy `allowedMfaMethods` is accepted at the input boundary
 * but the parsed value has one authority: `allowedMethods`.
 */
export const mfaSettingsSchema = z
  .object({
    security: mfaSecuritySettingsSchema.nullable().optional(),
  })
  .passthrough();

function settingsSecurity(settings: unknown): Record<string, unknown> | undefined {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const security = (settings as Record<string, unknown>).security;
  if (security === null || typeof security !== 'object' || Array.isArray(security)) return undefined;
  return security as Record<string, unknown>;
}

export function hasMfaAllowedMethodsInput(settings: unknown): boolean {
  const security = settingsSecurity(settings);
  return security !== undefined
    && (Object.hasOwn(security, 'allowedMethods') || Object.hasOwn(security, 'allowedMfaMethods'));
}

/**
 * Read an explicit persisted primary-factor allowlist. Canonical data wins if
 * both spellings are present. Missing policy is unrestricted; malformed or
 * explicitly empty policy throws so callers cannot fail open.
 */
export function getExplicitMfaAllowedMethods(
  settings: unknown,
): ReadonlySet<MfaPrimaryMethod> | undefined {
  const security = settingsSecurity(settings);
  if (!security) return undefined;

  const hasCanonical = Object.hasOwn(security, 'allowedMethods');
  const hasLegacy = Object.hasOwn(security, 'allowedMfaMethods');
  if (!hasCanonical && !hasLegacy) return undefined;

  const raw = hasCanonical ? security.allowedMethods : security.allowedMfaMethods;
  const parsed = mfaAllowedMethodsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Stored MFA allowed methods are invalid or empty');
  }

  return new Set(
    MFA_PRIMARY_METHODS.filter((method) => parsed.data[method] === true),
  );
}
