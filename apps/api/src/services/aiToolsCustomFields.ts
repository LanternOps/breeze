/**
 * `manage_custom_fields` (full-control W12, #6782; the #6141 custom-field
 * writes gap). Reads stay with `query_custom_fields`.
 *
 *  - `create_definition` (t2; supervised for `ownerScope: 'partner'`, every
 *    org, behind `canManagePartnerWidePolicies`) / `update_definition` (t2):
 *    POST / PATCH /custom-fields — the route's own rules, shared through
 *    services/customFields/definitionAdmin.ts. An EXISTING partner-wide
 *    definition is never edited or deleted here (W12-D10).
 *  - `delete_definition` (supervised): DELETE /custom-fields/:id. Irreversible:
 *    the FK cascade removes every device's value for the field.
 *  - `set_values` (supervised, quorum QW1): PATCH /devices/:id/custom-fields.
 *    Values are an installer-argument sink and a dynamic-group targeting
 *    control. The result carries the PREVIOUS values so a person can put them
 *    back.
 *
 * The whole tool is AGENT_HUMAN_ONLY_TOOLS (quorum QW6): values feed an agent's
 * run scope through dynamic groups, and definition edits decide which value
 * writes are admitted.
 *
 * Definition writes refuse a site- or device-restricted session (REST does
 * too); value writes follow the device's site (REST). Every write's REST twin
 * carries `requireMfa()` (W12-D5).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { customFieldDefinitions, devices } from '../db/schema';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { createAuditLog } from './auditService';
import { aiOriginAuditActor } from './aiOriginColumns';
import {
  canEditField, createCustomFieldSchema, ensureOrgAccess, getCustomFieldWithAccess, mapCustomFieldRow, updateCustomFieldSchema,
} from './customFields/definitionAdmin';
import { customFieldWriteConflict } from './customFields/writeErrors';
import { validateCustomFieldMap } from './customFields/validateValueMap';
import { persistDeviceCustomFieldValues } from './customFields/queries';
import { CUSTOM_FIELD_ACTIONS } from './aiToolSchemasSoftware';
import {
  auditToolWrite, bounded, json, jsonError, notFound, orgWideWriteDenied, requireFields, str, thrown,
} from './aiToolsSoftwareShared';

type Action = (typeof CUSTOM_FIELD_ACTIONS)[number];
const TOOL = 'manage_custom_fields';
const MAX_VALUES_PER_CALL = 50;

/** The `devices.custom_fields` projection as an object (same reading as routes/devices/customFieldValues.ts). */
function readExistingCustomFields(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The definition body the route would parse, built from the tool's flat input. */
function definitionBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ['name', 'fieldKey', 'type', 'required', 'defaultValue', 'deviceTypes', 'scriptWrite'] as const) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (Array.isArray(input.choices)) body.options = { choices: input.choices };
  return body;
}

export function registerCustomFieldTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 2,
    domain: 'devices',
    searchHint: 'create, edit or delete custom field definitions, or set custom field values on a device',
    deviceArgs: ['deviceId'],
    definition: {
      name: TOOL,
      description: 'Custom fields. create_definition/update_definition (org, or ownerScope partner), delete_definition (removes every device\'s value), set_values on one device ({fieldKey: value}, null clears).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...CUSTOM_FIELD_ACTIONS], description: 'The action to perform' },
          definitionId: { type: 'string', description: 'Definition UUID (update/delete)' },
          orgId: { type: 'string', description: 'create: owning organization (partner scope)' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'create: partner = every org of the partner' },
          name: { type: 'string', description: 'Display name' },
          fieldKey: { type: 'string', description: 'create: lowercase key, e.g. license_key' },
          type: { type: 'string', enum: ['text', 'number', 'boolean', 'dropdown', 'date'], description: 'create: value type' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Dropdown choices' },
          required: { type: 'boolean', description: 'Value required' },
          defaultValue: { description: 'Default value (string, number or boolean)' },
          deviceTypes: { type: 'array', items: { type: 'string', enum: ['windows', 'macos', 'linux'] }, description: 'OSes the field applies to' },
          scriptWrite: { type: 'boolean', description: 'Allow device scripts to write the value' },
          deviceId: { type: 'string', description: 'set_values: device UUID' },
          values: { type: 'object', description: 'set_values: { fieldKey: value }; null clears' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!CUSTOM_FIELD_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;

      try {
        if (action === 'set_values') {
          const missing = requireFields(input, ['deviceId', 'values'], action);
          if (missing) return missing;
          const updates = input.values as Record<string, unknown>;
          const keys = Object.keys(updates ?? {});
          if (keys.length === 0) return jsonError('values must name at least one field', 'VALIDATION_ERROR');
          if (keys.length > MAX_VALUES_PER_CALL) return jsonError(`At most ${MAX_VALUES_PER_CALL} fields per call`, 'VALIDATION_ERROR');
          const access = await verifyDeviceAccess(String(input.deviceId), auth);
          if ('error' in access) return notFound('Device');
          const device = access.device;
          const validation = await validateCustomFieldMap(device.orgId, device.osType, updates);
          if (!validation.ok) {
            return JSON.stringify({ error: 'One or more custom field values are invalid', code: 'VALIDATION_ERROR', fields: validation.rejected });
          }
          const previousAll = readExistingCustomFields(device.customFields);
          const previous = Object.fromEntries(keys.map((k) => [k, previousAll[k] ?? null]));
          await persistDeviceCustomFieldValues(device.id, device.orgId, validation.writes, 'manual');
          const [updated] = await db
            .select({ customFields: devices.customFields })
            .from(devices)
            .where(and(eq(devices.id, device.id), eq(devices.orgId, device.orgId)))
            .limit(1);
          // Awaited like the route: the trail must land before success is reported. Keys only, never values.
          const actor = auth.aiOrigin
            ? aiOriginAuditActor(auth.aiOrigin, { agentActorId: auth.user.id, humanActorId: auth.user.id })
            : { actorType: 'user' as const, actorId: auth.user.id, initiatedBy: 'ai' as const, originDetails: {} };
          await createAuditLog({
            orgId: device.orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            ...(actor.actorType === 'user' && auth.user.email ? { actorEmail: auth.user.email } : {}),
            action: 'device.custom_field.update',
            resourceType: 'device',
            resourceId: device.id,
            resourceName: device.hostname ?? undefined,
            details: { changedFields: keys, ...actor.originDetails },
            result: 'success',
            initiatedBy: actor.initiatedBy,
          });
          const current = readExistingCustomFields(updated?.customFields ?? null);
          return bounded({
            deviceId: device.id,
            values: Object.fromEntries(keys.map((k) => [k, current[k] ?? null])),
            previous,
          });
        }

        const denied = orgWideWriteDenied(auth, 'A custom field definition');
        if (denied) return denied;

        if (action === 'create_definition') {
          const parsed = createCustomFieldSchema.safeParse(definitionBody(input));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid definition', 'VALIDATION_ERROR');
          const payload = parsed.data;
          // Ownership exactly as POST /custom-fields: org scope is its own org; partner scope names an org or,
          // with ownerScope 'partner', creates a partner-wide row behind canManagePartnerWidePolicies.
          let orgId: string | null = null;
          let partnerId: string | null = null;
          const wantsPartner = input.ownerScope === 'partner';
          if (auth.scope === 'organization') {
            if (wantsPartner) return jsonError('Partner-wide definitions need a partner-scope session', 'ACCESS_DENIED');
            if (!auth.orgId) return jsonError('Organization context required', 'ACCESS_DENIED');
            orgId = auth.orgId;
          } else if (auth.scope === 'partner') {
            if (!auth.partnerId) return jsonError('Partner context required', 'ACCESS_DENIED');
            if (wantsPartner) {
              if (str(input.orgId)) return jsonError('Pass orgId or ownerScope partner, not both', 'VALIDATION_ERROR');
              if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
              partnerId = auth.partnerId;
            } else {
              const requested = str(input.orgId);
              if (!requested) return jsonError('orgId is required (or ownerScope partner for a partner-wide field)', 'VALIDATION_ERROR');
              if (!(await ensureOrgAccess(requested, auth))) return notFound('Organization');
              orgId = requested;
            }
          } else {
            const requested = str(input.orgId);
            if (!requested) return jsonError('orgId is required', 'VALIDATION_ERROR');
            orgId = requested;
          }
          let field;
          try {
            [field] = await db.insert(customFieldDefinitions).values({
              orgId, partnerId, name: payload.name, fieldKey: payload.fieldKey, type: payload.type, options: payload.options,
              required: payload.required, defaultValue: payload.defaultValue, deviceTypes: payload.deviceTypes, scriptWrite: payload.scriptWrite,
            }).returning();
          } catch (err) {
            const conflict = customFieldWriteConflict(err, payload.fieldKey);
            if (conflict) return jsonError(conflict.error, 'CONFLICT');
            throw err;
          }
          if (!field) return jsonError('Failed to create custom field');
          auditToolWrite(auth, {
            orgId: field.orgId, partnerId: field.partnerId, action: 'custom_field.create', resourceType: 'custom_field',
            resourceId: field.id, resourceName: field.name, details: { fieldKey: field.fieldKey, type: field.type },
          });
          return json({ definition: mapCustomFieldRow(field) });
        }

        const missing = requireFields(input, ['definitionId'], action);
        if (missing) return missing;
        const field = await getCustomFieldWithAccess(String(input.definitionId), auth);
        if (!field) return notFound('Custom field');
        // W12-D10 (quorum QW1): an existing partner-wide definition (every org) is edited or deleted in the web app.
        if (!field.orgId) {
          return jsonError('This is a partner-wide custom field; change or delete it in the Breeze web app', 'ACCESS_DENIED');
        }
        if (!canEditField(field, auth)) return jsonError('Access to this custom field denied', 'ACCESS_DENIED');

        if (action === 'update_definition') {
          const body = definitionBody(input);
          delete body.fieldKey;
          delete body.type;
          const parsed = updateCustomFieldSchema.safeParse(body);
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid update', 'VALIDATION_ERROR');
          const changed = Object.keys(parsed.data);
          if (changed.length === 0) return jsonError('Nothing to update (fieldKey and type cannot change)', 'VALIDATION_ERROR');
          const [updated] = await db
            .update(customFieldDefinitions)
            .set({ ...parsed.data, updatedAt: new Date() })
            .where(eq(customFieldDefinitions.id, field.id))
            .returning();
          if (!updated) return notFound('Custom field');
          auditToolWrite(auth, {
            orgId: updated.orgId, partnerId: updated.partnerId, action: 'custom_field.update', resourceType: 'custom_field',
            resourceId: updated.id, resourceName: updated.name, details: { changedFields: changed },
          });
          return json({ definition: mapCustomFieldRow(updated) });
        }

        // delete_definition
        const [deleted] = await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, field.id)).returning({ id: customFieldDefinitions.id });
        if (!deleted) return notFound('Custom field');
        auditToolWrite(auth, {
          orgId: field.orgId, partnerId: field.partnerId, action: 'custom_field.delete', resourceType: 'custom_field',
          resourceId: field.id, resourceName: field.name,
        });
        return json({ deleted: true, definition: mapCustomFieldRow(field) });
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
