/**
 * Org scoping for psa_ticket_mappings reads (epic #2135; PR #3308 review).
 *
 * Deliberately a dependency-free leaf module — schema types only, no `../db`
 * import — so it can be unit-tested by rendering it through the real Postgres
 * dialect. routes/psa.ts mocks the whole db layer in its own tests, which makes
 * malformed SQL invisible there; that is exactly how an `= ANY(${array})` bug
 * reached CI (`cannot cast type record to uuid[]`).
 */
import { sql, type SQL } from 'drizzle-orm';
import { psaTicketMappings } from '../../db/schema';

/**
 * WHERE fragment restricting psa_ticket_mappings rows to `accessibleOrgIds`,
 * via the mapping's OWN org anchors. Returns `undefined` for system scope.
 *
 * This is the tenancy boundary for ticket DATA, and it is deliberately separate
 * from the connection-visibility condition, which governs CONFIG. Conflating
 * them leaked data: a psa_connections row is partner-owned CONFIG, correctly
 * visible to any partner-scope caller of that partner, but the mappings hanging
 * off it name a specific org's device, alert and external ticket. A
 * `partner_user` with org_access='selected' scoped to org A could read org B's
 * external ticket ids and URLs through the shared partner-wide connection.
 *
 * Every anchor that is SET must be accessible (AND, not OR): a row is withheld
 * if EITHER its device or its alert belongs to an unreachable org. A row with
 * neither anchor references no org at all, so connection access governs it and
 * it passes this filter.
 *
 * NOT redundant with RLS. `breeze_has_org_access` does respect the caller's
 * accessible-org list, but the psa_ticket_mappings policy's connection arm
 * passes for ANY partner-scope caller of the owning partner — necessarily so,
 * since an unanchored row has no org for Postgres to check. Postgres cannot
 * express `partner_users.org_access='selected'`; this condition is the
 * enforcement point for that refinement and must not be removed as "the policy
 * already covers it".
 */
export function psaTicketMappingOrgCondition(
  accessibleOrgIds: string[] | null
): SQL | undefined {
  if (accessibleOrgIds === null) return undefined; // system scope — unrestricted
  if (accessibleOrgIds.length === 0) return sql`false`;

  // Bind each id as its OWN parameter. Interpolating the array directly
  // (`= ANY(${orgIds}::uuid[])`) does not work: drizzle expands a JS array in a
  // sql template into a comma-separated parameter list, so Postgres sees a
  // record and rejects it with `cannot cast type record to uuid[]` (or
  // `malformed array literal` when the list has exactly one element).
  const orgList = sql.join(accessibleOrgIds.map((id) => sql`${id}::uuid`), sql`, `);

  return sql`(
    (${psaTicketMappings.deviceId} IS NULL OR EXISTS (
      SELECT 1 FROM devices d
       WHERE d.id = ${psaTicketMappings.deviceId}
         AND d.org_id IN (${orgList})
    ))
    AND (${psaTicketMappings.alertId} IS NULL OR EXISTS (
      SELECT 1 FROM alerts a
       WHERE a.id = ${psaTicketMappings.alertId}
         AND a.org_id IN (${orgList})
    ))
  )`;
}
