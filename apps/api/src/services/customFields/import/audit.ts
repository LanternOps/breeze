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
import type { CustomFieldDefinitionImportRow, DefinitionImportSummary } from './types';

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
