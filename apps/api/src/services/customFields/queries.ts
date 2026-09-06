import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema/customFields';
import { deviceCustomFieldValues, devices, organizations } from '../../db/schema';

export interface WriteBackDevice {
  id: string;
  orgId: string;
  osType: string | null;
  hostname: string | null;
  displayName: string | null;
  customFields: unknown;
}

export interface VisibleCustomFieldDefinition {
  id: string;
  fieldKey: string;
  name: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: unknown;
  deviceTypes: string[] | null;
  required: boolean;
  scriptWrite: boolean;
  orgId: string | null;
  partnerId: string | null;
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
 * `custom_field_definitions` is dual-axis (org OR partner). Every caller of
 * this function — the script write-back path's `runWithAgentOrgDbAccess`
 * context, and the two device-PATCH write paths' ordinary org-scoped request
 * context — sets accessiblePartnerIds: [] and currentPartnerId: null, so
 * `breeze_has_partner_access(partner_id)` is false and every partner-wide
 * definition (org_id IS NULL) is INVISIBLE from there. A partner that defines
 * one field for all its orgs would silently have no fields visible from any
 * of these paths. See CLAUDE.md, Partner-Wide First §3.
 *
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` is the only form
 * that genuinely opens a second context — a bare nested
 * `withSystemDbAccessContext` early-returns and runs under the ORG context
 * instead. The scope is app-layer: an explicit org/partner predicate, kept
 * narrow, and the context is released immediately (it holds a second pooled
 * connection for its duration — #1105). This now runs on every custom-field
 * PATCH, not just script write-back — if this becomes a per-request cost
 * worth caring about, cache the definition set per org/request rather than
 * re-querying it per PATCH.
 */
export async function loadVisibleCustomFieldDefinitions(
  orgId: string,
): Promise<VisibleCustomFieldDefinition[]> {
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
          id: customFieldDefinitions.id,
          fieldKey: customFieldDefinitions.fieldKey,
          name: customFieldDefinitions.name,
          type: customFieldDefinitions.type,
          options: customFieldDefinitions.options,
          deviceTypes: customFieldDefinitions.deviceTypes,
          required: customFieldDefinitions.required,
          scriptWrite: customFieldDefinitions.scriptWrite,
          orgId: customFieldDefinitions.orgId,
          partnerId: customFieldDefinitions.partnerId,
        })
        .from(customFieldDefinitions)
        .where(ownerCondition);
    }, 'customFields.loadVisibleCustomFieldDefinitions'),
  );
}

/**
 * The script write-back loader, kept as a named alias so callers that only
 * care about script-writable fields keep reading as they did. The script_write
 * gate itself stays where it is — applied per field by scriptWriteBack.ts, so
 * a field that exists but is not writable is REJECTED with
 * 'not_script_writable' rather than reported as 'unknown_field'.
 */
export const loadScriptWritableDefinitions = loadVisibleCustomFieldDefinitions;

/*
 * `persistDeviceCustomFields(deviceId, orgId, merged)` — which wrote the whole
 * `devices.custom_fields` jsonb in one UPDATE — was REMOVED by #3257 W05 rather
 * than deprecated. Since the projection trigger rebuilds that column from
 * `device_custom_field_values`, any direct write to it is reverted by the next
 * value write and bypasses both the composite device/org FK and the definition
 * coherence trigger. Leaving it exported would have been a live footgun with a
 * silent failure mode. Use `persistDeviceCustomFieldValues` below.
 */

/** One resolved custom-field write, ready for the normalized table. */
export interface CustomFieldValueWrite {
  definitionId: string;
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  value: string | number | boolean | null;
}

/**
 * Whatever issues the upsert: the ambient `db` proxy by default, or a nested
 * transaction handle for a caller that needs per-row failure isolation. See the
 * `executor` note on `persistDeviceCustomFieldValues`.
 */
export type CustomFieldValueExecutor = Pick<typeof db, 'insert'>;

/** The four typed columns; exactly one non-null, or all null for a clear. */
export interface CustomFieldValueColumns {
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: string | null;
}

/**
 * Map a validated value onto exactly one typed column.
 *
 * Takes the value AS ALREADY COERCED by `validateCustomFieldValue`, which is
 * the only thing allowed to decide whether a value is acceptable for its type —
 * this function must never widen or narrow that decision, only place it. `null`
 * is a legal, first-class value: an explicitly cleared field stores as all-NULL
 * (`customFieldValueSchema` has always accepted `z.null()`), which stays
 * distinguishable from an absent row.
 */
export function valueColumnsFor(
  type: CustomFieldValueWrite['type'],
  value: string | number | boolean | null,
): CustomFieldValueColumns {
  const empty: CustomFieldValueColumns = {
    valueText: null, valueNumber: null, valueBool: null, valueDate: null,
  };
  if (value === null) return empty;
  switch (type) {
    case 'number':
      return { ...empty, valueNumber: typeof value === 'number' ? value : Number(value) };
    case 'boolean':
      return { ...empty, valueBool: typeof value === 'boolean' ? value : value === 'true' };
    case 'date':
      return { ...empty, valueDate: String(value).slice(0, 10) };
    case 'text':
    case 'dropdown':
    default:
      return { ...empty, valueText: String(value) };
  }
}

/**
 * Upsert device custom-field values into `device_custom_field_values`
 * (#3257 W05). Returns the field keys that ACTUALLY changed.
 *
 * `devices.custom_fields` is no longer written by any caller — it is rebuilt by
 * `breeze_device_custom_field_project()` from this table. Writing it directly
 * would be overwritten by the next value write, and would bypass both the
 * composite device/org FK and the definition coherence trigger.
 *
 * Ambient ORG context. `org_id` pins the write to the org the transport
 * authorized (RLS enforces it too — the predicate is defense in depth, the same
 * shape `routes/devices/customFieldValues.ts` already applies).
 *
 * THE COMPARE-BEFORE-WRITE IS NOT COSMETIC, and it moved here from
 * `scriptWriteBack.ts` so all three write paths get it. An UPDATE that actually
 * changes a value propagates through the projection trigger to an UPDATE on
 * `devices`, which fires `breeze_partner_export_z_custom_values_update` and
 * takes `pg_advisory_xact_lock(1000201, hashtext(org_id))` — an EXCLUSIVE
 * per-org lock held to COMMIT. A fleet-wide script re-writing unchanged values
 * would serialise every device in the org behind it. `setWhere` makes Postgres
 * skip the UPDATE entirely (no RETURNING row, no WAL, no trigger) rather than
 * making us read-then-write.
 *
 * `source` is deliberately NOT part of that predicate, so re-asserting the same
 * value from a different writer leaves the original `source` in place. That is a
 * conscious trade: adding it would make provenance track the last writer, but it
 * would also mean a fleet-wide script re-asserting unchanged values updates
 * every row again — WAL and a row lock per device — which is the exact cost this
 * comparison exists to avoid. Provenance is informational; the write amplification
 * is not. Do not "fix" this without that trade in front of you.
 *
 * `executor` defaults to the ambient `db` proxy, which is what every request
 * path wants. The RMM value importer (#3257 W08) passes the handle of its
 * PER-ROW nested transaction instead: a statement issued on the ambient proxy
 * from inside a nested transaction still resolves to the OUTER request
 * transaction, so a failure is recorded against the outer postgres.js scope and
 * poisons the whole request instead of rolling back to that row's savepoint
 * (`dbSavepointErrorIsolation.integration.test.ts` is the proof). The parameter
 * exists so the importer gets per-row failure isolation WITHOUT forking this
 * upsert — the compare-before-write `setWhere` below is subtle and load-bearing,
 * and a second copy of it would drift.
 */
export async function persistDeviceCustomFieldValues(
  deviceId: string,
  orgId: string,
  writes: CustomFieldValueWrite[],
  source: 'manual' | 'api' | 'script' | 'import',
  executor: CustomFieldValueExecutor = db,
): Promise<string[]> {
  if (writes.length === 0) return [];
  const changed: string[] = [];
  for (const write of writes) {
    const columns = valueColumnsFor(write.type, write.value);
    const updated = await executor
      .insert(deviceCustomFieldValues)
      .values({
        deviceId,
        orgId,
        definitionId: write.definitionId,
        fieldKey: write.fieldKey,
        source,
        ...columns,
      })
      .onConflictDoUpdate({
        target: [deviceCustomFieldValues.deviceId, deviceCustomFieldValues.definitionId],
        set: { ...columns, source, updatedAt: new Date() },
        setWhere: sql`
             ${deviceCustomFieldValues.valueText} IS DISTINCT FROM ${columns.valueText}
          OR ${deviceCustomFieldValues.valueNumber} IS DISTINCT FROM ${columns.valueNumber}
          OR ${deviceCustomFieldValues.valueBool} IS DISTINCT FROM ${columns.valueBool}
          OR ${deviceCustomFieldValues.valueDate}::text IS DISTINCT FROM ${columns.valueDate}`,
      })
      .returning({ fieldKey: deviceCustomFieldValues.fieldKey });
    if (updated.length > 0) changed.push(write.fieldKey);
  }
  return changed;
}
