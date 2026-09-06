/**
 * Audit trail for definition-import writes (#3257 W07).
 *
 * WHY THIS IS A SHARED HELPER, mirroring `services/contacts/audit.ts`:
 * `commitCustomFieldDefinitionImport` has no Hono context, so it cannot
 * attribute a write to an actor, IP or user agent. The audit loop therefore
 * lives at the route — and a second caller that forgets it writes custom-field
 * definitions with no trail at all. Keeping the event shape here means every
 * caller emits the identical one.
 *
 * WHAT THE EVENT HAS TO CARRY, and why: after a migration off Datto RMM the
 * question that gets asked is "where did this field come from, and who let it
 * in?". `sourceLabel` — the incumbent's own name for the field, e.g. `udf7` —
 * is the only thing that answers the first half, and it is deliberately NOT
 * stored on the definition row (there is no column for it, and inventing one
 * would make one importer's provenance a permanent part of the table's shape).
 * The audit event is therefore its ONLY durable home.
 *
 * Skipped rows are deliberately not audited: they are the rows the commit left
 * untouched, and one event per unchanged row would bury the real writes on
 * every re-import of an unchanged file.
 */

import { writeRouteAudit, type AuthContext as AuditRouteContext } from '../../auditEvents';
import type {
  CustomFieldDefinitionImportRow,
  DefinitionImportSummary,
  ValueImportSummary,
} from './types';

export interface DefinitionImportAuditInput {
  summary: DefinitionImportSummary;
  /**
   * The rows as submitted, indexed the same way the summary is, so each created
   * definition can be attributed to the source field it came from.
   */
  rows: readonly CustomFieldDefinitionImportRow[];
  /** Which RMM the file was exported from, e.g. `datto_rmm`. */
  externalSystem: string;
}

/** One event per definition the import created. */
export function writeCustomFieldDefinitionImportAudits(
  c: AuditRouteContext,
  { summary, rows, externalSystem }: DefinitionImportAuditInput,
): void {
  const rowCount = rows.length;

  for (const entry of summary.created) {
    const row = rows[entry.index];
    writeRouteAudit(c, {
      orgId: entry.organizationId,
      action: 'custom_field.create',
      resourceType: 'custom_field',
      resourceId: entry.definitionId,
      resourceName: row?.name ?? entry.fieldKey,
      details: {
        source: 'custom_field_definition_import',
        externalSystem,
        ...(row?.sourceLabel ? { sourceLabel: row.sourceLabel } : {}),
        fieldKey: entry.fieldKey,
        ownerScope: entry.ownerScope,
        rowCount,
      },
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * W08 — the VALUES half (#4776)
 *
 * Same reason for living here as the definitions half above:
 * `commitDeviceCustomFieldImport` has no Hono context, so the route fans the
 * events out from the returned summary.
 *
 * WHAT THIS ONE HAS TO CARRY, and why: after a migration off Datto RMM the
 * question is "where did this asset tag come from, and how did the importer
 * decide it belonged to THIS device?". The answer is the resolution METHOD —
 * an exact `id`/`link` match and a fuzzy `hostname` match are very different
 * grounds for a value an MSP may later bill or act on — together with the
 * system the file came from and the row count of the batch it arrived in.
 *
 * Field KEYS only, never values: a custom-field value can be anything the
 * incumbent held, and `customFieldValues.ts` and `scriptWriteBack.ts` already
 * apply the same rule on their own write paths.
 *
 * Rows where nothing was applied are deliberately not audited. They are the
 * rows the commit left untouched — a re-import of an unchanged file is entirely
 * such rows, and one event each would bury the real writes.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ValueImportAuditInput {
  summary: ValueImportSummary;
  /** Rows SUBMITTED, not rows written — the batch an operator would recognise. */
  rowCount: number;
  /** The batch-level system, used when a row did not name its own. */
  externalSystem: string;
}

/** One event per device the import actually backfilled. */
export function writeCustomFieldValueImportAudits(
  c: AuditRouteContext,
  { summary, rowCount, externalSystem }: ValueImportAuditInput,
): void {
  for (const row of summary.rows) {
    if (row.applied === 0) continue;

    writeRouteAudit(c, {
      orgId: row.organizationId,
      action: 'device.custom_field.import',
      resourceType: 'device',
      resourceId: row.deviceId,
      details: {
        source: 'device_custom_field_import',
        externalSystem: row.externalSystem ?? externalSystem,
        resolutionMethod: row.method,
        changedFields: row.appliedFieldKeys,
        warranty: row.warranty,
        linkCreated: row.linkCreated,
        rowCount,
      },
    });
  }
}
