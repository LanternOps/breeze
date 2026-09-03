import { and, eq, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema/customFields';
import { devices, organizations } from '../../db/schema';

export interface WriteBackDevice {
  id: string;
  orgId: string;
  osType: string | null;
  hostname: string | null;
  displayName: string | null;
  customFields: unknown;
}

export interface ScriptWritableDefinition {
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: unknown;
  deviceTypes: string[] | null;
  scriptWrite: boolean;
}

/** Ambient ORG context — `devices` is shape 1 and RLS is a real backstop here. */
export async function loadDeviceForWriteBack(deviceId: string): Promise<WriteBackDevice | null> {
  const [row] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      osType: devices.osType,
      hostname: devices.hostname,
      displayName: devices.displayName,
      customFields: devices.customFields,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
}

/**
 * SYSTEM context, deliberately.
 *
 * `custom_field_definitions` is dual-axis (org OR partner). The caller runs
 * under `runWithAgentOrgDbAccess`, which sets accessiblePartnerIds: [] and
 * currentPartnerId: null, so `breeze_has_partner_access(partner_id)` is false
 * and every partner-wide definition (org_id IS NULL) is INVISIBLE from there.
 * A partner that defines one field for all its orgs would silently have no
 * script-writable fields at all. See CLAUDE.md, Partner-Wide First §3.
 *
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` is the only form
 * that genuinely opens a second context — a bare nested
 * `withSystemDbAccessContext` early-returns and runs under the ORG context
 * instead. The scope is app-layer: an explicit org/partner predicate, kept
 * narrow, and the context is released immediately (it holds a second pooled
 * connection for its duration — #1105).
 */
export async function loadScriptWritableDefinitions(
  orgId: string,
): Promise<ScriptWritableDefinition[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const ownerCondition = org?.partnerId
        ? or(
            eq(customFieldDefinitions.orgId, orgId),
            and(
              isNull(customFieldDefinitions.orgId),
              eq(customFieldDefinitions.partnerId, org.partnerId),
            ),
          )
        : eq(customFieldDefinitions.orgId, orgId);

      return db
        .select({
          fieldKey: customFieldDefinitions.fieldKey,
          type: customFieldDefinitions.type,
          options: customFieldDefinitions.options,
          deviceTypes: customFieldDefinitions.deviceTypes,
          scriptWrite: customFieldDefinitions.scriptWrite,
        })
        .from(customFieldDefinitions)
        .where(ownerCondition);
    }, 'customFields.scriptWriteBack.definitions'),
  );
}

/**
 * Ambient ORG context. The org predicate is redundant under RLS but pins the
 * write to the exact device the transport authorized — the same
 * defense-in-depth the PATCH endpoint applies
 * (routes/devices/customFieldValues.ts).
 *
 * Callers MUST skip this when the merged object is unchanged: every UPDATE on
 * `devices` that actually changes `custom_fields` fires
 * `breeze_partner_export_z_custom_values_update`, which takes
 * `pg_advisory_xact_lock(1000201, hashtext(org_id))` — an EXCLUSIVE per-org
 * lock held to COMMIT. A fleet-wide script would otherwise serialise every
 * device in the org behind it.
 */
export async function persistDeviceCustomFields(
  deviceId: string,
  orgId: string,
  merged: Record<string, unknown>,
): Promise<boolean> {
  const updated = await db
    .update(devices)
    .set({ customFields: merged, updatedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ id: devices.id });
  return updated.length > 0;
}
