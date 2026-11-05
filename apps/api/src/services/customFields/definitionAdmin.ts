/**
 * Custom-field DEFINITION schemas and access rules, shared by the REST route
 * (`routes/customFields.ts`) and the `manage_custom_fields` AI tool
 * (full-control W12, #6782). Moved verbatim from the route so both doors apply
 * one copy of the ownership and partner-wide rules.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';

// Custom field schemas (defined locally to avoid rootDir issues)
// Must match the database enum: 'text', 'number', 'boolean', 'dropdown', 'date'
export const customFieldTypeSchema = z.enum(['text', 'number', 'boolean', 'dropdown', 'date']);

// Mirrors CustomFieldOptions in packages/shared/src/types/filters.ts. The
// {label,value} choice shape is the one the shared contract, the web form and
// services/customFields/validateValue.ts readChoices() all use; the bare-string
// array is accepted for the rows already stored that way. Widening here was a
// live bug fix, not a nicety: a dropdown created through the UI was rejected by
// this very schema (#3257 Phase 0).
const customFieldChoiceSchema = z.union([
  z.string().min(1).max(255),
  z.object({ label: z.string().min(1).max(255), value: z.string().min(1).max(255) })
]);

export const customFieldOptionsSchema = z.object({
  choices: z.array(customFieldChoiceSchema).max(200).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().max(512).optional(),
  placeholder: z.string().max(255).optional()
});

export const createCustomFieldSchema = z.object({
  name: z.string().min(1).max(100),
  fieldKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, 'Field key must be lowercase alphanumeric with underscores'),
  type: customFieldTypeSchema,
  // .nullable().optional() so the create form can send explicit null
  // for unused fields. The web form serializes unused fields as null
  // rather than omitting them — without .nullable() the validator
  // rejects every non-Dropdown create (Text, Number, Boolean, Date).
  options: customFieldOptionsSchema.nullable().optional(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).nullable().optional(),
  // #2698 — may a script running on a device write this field via the
  // ::breeze:custom-fields:: marker? Default false: opting in is deliberate.
  scriptWrite: z.boolean().default(false)
});

export const updateCustomFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // Nullable for the same reason as create: the edit form sends
  // options: null for non-Dropdown types (#7476).
  options: customFieldOptionsSchema.nullable().optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  deviceTypes: z.array(z.enum(['windows', 'macos', 'linux'])).nullable().optional(),
  scriptWrite: z.boolean().optional() // #2698
});

export type CustomFieldDefinition = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  fieldKey: string;
  type: string;
  options: unknown;
  required: boolean;
  defaultValue: unknown;
  deviceTypes: string[] | null;
  scriptWrite: boolean;
  createdAt: string;
  updatedAt: string;
};

export async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  return true;
}

export function canEditField(
  field: typeof customFieldDefinitions.$inferSelect,
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'partnerOrgAccess'>
) {
  if (auth.scope === 'system') {
    return true;
  }

  if (field.orgId) {
    return auth.scope === 'organization'
      ? auth.orgId === field.orgId
      : auth.scope === 'partner'
        ? Boolean(auth.partnerId)
        : false;
  }

  if (field.partnerId) {
    // Partner-wide row (org_id NULL): epic #2135 capability gate, not just
    // scope. A `selected` partner user whose selection happens to cover every
    // current org still must not administer partner-wide state.
    return auth.partnerId === field.partnerId && canManagePartnerWidePolicies(auth);
  }

  return false;
}

export async function getCustomFieldWithAccess(
  fieldId: string,
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [field] = await db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.id, fieldId))
    .limit(1);

  if (!field) {
    return null;
  }

  if (field.orgId) {
    const hasAccess = await ensureOrgAccess(field.orgId, auth);
    if (!hasAccess) {
      return null;
    }
  } else if (field.partnerId) {
    if (auth.scope !== 'system' && auth.partnerId !== field.partnerId) {
      return null;
    }
  } else if (auth.scope !== 'system') {
    return null;
  }

  return field;
}

export function mapCustomFieldRow(
  field: typeof customFieldDefinitions.$inferSelect
): CustomFieldDefinition {
  return {
    id: field.id,
    orgId: field.orgId,
    partnerId: field.partnerId,
    name: field.name,
    fieldKey: field.fieldKey,
    type: field.type,
    options: field.options ?? null,
    required: field.required,
    defaultValue: field.defaultValue ?? null,
    deviceTypes: field.deviceTypes ?? null,
    scriptWrite: field.scriptWrite,
    createdAt: field.createdAt.toISOString(),
    updatedAt: field.updatedAt.toISOString()
  };
}
