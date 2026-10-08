/**
 * #4247: the owner columns a new `report_runs` row must carry — copied
 * verbatim from the parent definition it belongs to (org_id XOR partner_id).
 *
 * Deliberately non-throwing: the scheduler records a denial run before the
 * owner axis is resolved, and the database (`report_runs_one_owner_chk` plus
 * the composite FKs to `reports(id, org_id)` / `reports(id, partner_id)`) is
 * the authority on whether the pair is valid.
 */
export function reportRunOwnerColumns(report: {
  orgId: string | null;
  partnerId: string | null;
}): { orgId: string | null; partnerId: string | null } {
  return { orgId: report.orgId ?? null, partnerId: report.partnerId ?? null };
}
