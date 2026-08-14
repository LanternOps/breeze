import { z } from 'zod';

/**
 * Tenant variables (#3409) — a value an MSP defines once (org-scoped or
 * partner-wide) and references from scripts / software deployment.
 */

/**
 * Lowercase snake_case. The key is interpolated into a `{{var.<key>}}` content
 * token and into a `BREEZE_VAR_<UPPER_KEY>` process env var name (PR 2), so
 * anything outside this grammar would produce an unparseable token or an
 * illegal env var. Mirrored by the tenant_variables_key_chk DB constraint.
 */
export const TENANT_VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_TENANT_VARIABLE_VALUE_LENGTH = 4096;
export const MAX_TENANT_VARIABLE_DESCRIPTION_LENGTH = 500;
/**
 * Per owner — per org, and per partner. Bounds the single per-org resolution
 * query PR 2 runs on every script dispatch, and the settings list page.
 */
export const MAX_TENANT_VARIABLES_PER_OWNER = 200;

export const tenantVariableKeySchema = z
  .string()
  .regex(
    TENANT_VARIABLE_KEY_PATTERN,
    'Key must be lowercase letters, digits and underscores, and start with a letter'
  );

/**
 * Default-free base carrying every MUTABLE field. Nothing here may declare a
 * `.default()`: `updateTenantVariableSchema` is `.partial()` of this, and in
 * Zod 4 `.partial()` does NOT suppress defaults — an omitted field would be
 * materialized with its default and silently overwrite the stored value.
 * Create-time defaults live only on createTenantVariableSchema.
 */
/**
 * A value that already looks like our own at-rest envelope is rejected rather
 * than stored: `encryptSecret` treats an `enc:vN:` prefix as "already
 * encrypted" and passes it through untouched, which would persist caller-
 * controlled text as if it were ciphertext — and then fail to decrypt on the
 * way back out. No real vendor token starts with this prefix.
 */
export const TENANT_VARIABLE_CIPHERTEXT_PREFIX = /^enc:v\d+:/;

const tenantVariableBaseSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(MAX_TENANT_VARIABLE_VALUE_LENGTH)
    .refine((v) => !TENANT_VARIABLE_CIPHERTEXT_PREFIX.test(v), {
      message: 'Value must not start with "enc:v<n>:" — that prefix is reserved for encrypted storage'
    }),
  isSecret: z.boolean(),
  // Nullable so the editor can CLEAR a description: the update schema is
  // .partial(), so omitting the key keeps the stored value.
  description: z.string().max(MAX_TENANT_VARIABLE_DESCRIPTION_LENGTH).nullable().optional()
});

export const createTenantVariableSchema = tenantVariableBaseSchema.extend({
  // Ownership axis (Partner-Wide First, epic #2135). 'partner' = an all-orgs
  // variable; the server derives the partner from the caller's OWN token — a
  // client-supplied partner id is never trusted. orgId is only consulted when
  // ownerScope is 'organization'.
  ownerScope: z.enum(['organization', 'partner']),
  orgId: z.string().guid().optional(),
  // Create-only: renaming a key would silently break every script referencing
  // the old {{var.<key>}} token, so there is no update path for it.
  key: tenantVariableKeySchema,
  isSecret: z.boolean().default(false)
});

/**
 * ownerScope, orgId and key are immutable by omission — none of them is part
 * of the base, so none can appear on an update payload at all.
 *
 * Omitting `value` is the no-clobber path: the stored (encrypted) value is
 * left byte-identical. That is the only way to edit a secret variable's
 * description, since secret values are never returned to the client.
 */
export const updateTenantVariableSchema = tenantVariableBaseSchema.partial();

export type CreateTenantVariableInput = z.infer<typeof createTenantVariableSchema>;
export type UpdateTenantVariableInput = z.infer<typeof updateTenantVariableSchema>;
