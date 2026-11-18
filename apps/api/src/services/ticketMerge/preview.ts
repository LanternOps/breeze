/**
 * Merge preview (#8972, spec §3.4). Read-only: counts what a merge would move,
 * which links it would drop and which external refs would stay behind, with
 * every eligibility refusal. No lock is taken and nothing is written — the
 * merge itself revalidates everything under its locks, so the preview is
 * advisory only. All reads run on the caller's connection (Gate B1).
 */
import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../ticketRowLock';
import { checkMergeEligibility, type MergeEligibilityContext, type MergeTicketRow } from './eligibility';
import type { MergeRefusal } from './errors';
import { requestersDiffer } from './execute';
import { emptyMergeCounts, loadOrgLinks, planLinkRepoint, type DroppedLink, type MergeCounts } from './repoint';

export interface MergePreview {
  eligible: boolean;
  refusals: MergeRefusal[];
  counts: MergeCounts;
  droppedLinks: DroppedLink[];
  retainedExternalRefs: Array<{ id: string; principalName: string | null }>;
  deviceDifference: { source: string | null; survivor: string | null; result: string | null };
  requestersDiffer: boolean;
  /** D1(b): the source's requester gains public read + reply on the survivor in the portal. */
  sourceRequesterGainsAccess: boolean;
  /** D5: the older ticket (its clock and number are the ones the customer has watched). */
  suggestedSurvivorId: string;
}

/** The older of the two (ties: the lower id), the default survivor (D5). */
export function suggestSurvivor(a: Pick<MergeTicketRow, 'id' | 'createdAt'>, b: Pick<MergeTicketRow, 'id' | 'createdAt'>): string {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta < tb ? a.id : b.id;
  return a.id < b.id ? a.id : b.id;
}

type Exec = Pick<DbExecutor, 'execute' | 'select' | 'selectDistinct'>;

async function count(exec: Exec, q: ReturnType<typeof sql>): Promise<number> {
  const rows = (await exec.execute(q)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export async function previewMerge(
  exec: Exec,
  src: MergeTicketRow,
  dst: MergeTicketRow,
  ctx: MergeEligibilityContext = {},
): Promise<MergePreview> {
  const refusals = await checkMergeEligibility(exec as DbExecutor, src, dst, ctx);
  const base = {
    deviceDifference: { source: src.deviceId, survivor: dst.deviceId, result: dst.deviceId ?? src.deviceId },
    requestersDiffer: requestersDiffer(src, dst),
    sourceRequesterGainsAccess: requestersDiffer(src, dst) && !!(src.submittedBy || src.requesterContactId),
    suggestedSurvivorId: suggestSurvivor(src, dst),
  };
  // Same ticket / cross org: nothing meaningful to count.
  if (src.id === dst.id || src.orgId !== dst.orgId) {
    return { eligible: false, refusals, counts: emptyMergeCounts(), droppedLinks: [], retainedExternalRefs: [], ...base };
  }
  const s = src.id;
  const d = dst.id;
  const counts = emptyMergeCounts();
  counts.ticket_comments = await count(exec, sql`SELECT count(*)::int AS n FROM ticket_comments WHERE ticket_id = ${s}::uuid`);
  counts.time_entries = await count(exec, sql`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = ${s}::uuid`);
  counts.ticket_parts = await count(exec, sql`SELECT count(*)::int AS n FROM ticket_parts WHERE ticket_id = ${s}::uuid`);
  counts.ticket_alert_links = await count(exec, sql`
    SELECT count(*)::int AS n FROM ticket_alert_links a
     WHERE a.ticket_id = ${s}::uuid
       AND NOT EXISTS (SELECT 1 FROM ticket_alert_links b WHERE b.ticket_id = ${d}::uuid AND b.alert_id = a.alert_id)`);
  counts.ticket_attachments = await count(exec, sql`SELECT count(*)::int AS n FROM ticket_attachments WHERE ticket_id = ${s}::uuid`);
  counts.ticket_email_links = await count(exec, sql`SELECT count(*)::int AS n FROM ticket_email_links WHERE ticket_id = ${s}::uuid`);
  counts.ticket_checklist_items = await count(exec, sql`SELECT count(*)::int AS n FROM ticket_checklist_items WHERE ticket_id = ${s}::uuid`);
  counts.ticket_external_refs = await count(exec, sql`
    SELECT count(*)::int AS n FROM ticket_external_refs r
     WHERE r.ticket_id = ${s}::uuid
       AND NOT EXISTS (SELECT 1 FROM ticket_external_refs o
                        WHERE o.ticket_id = ${d}::uuid AND o.partner_service_principal_id = r.partner_service_principal_id)`);
  counts.device_vulnerabilities = await count(exec, sql`SELECT count(*)::int AS n FROM device_vulnerabilities WHERE ticket_id = ${s}::uuid`);
  counts.organization_key_dates = await count(exec, sql`SELECT count(*)::int AS n FROM organization_key_dates WHERE reminder_ticket_id = ${s}::uuid`);
  counts.service_deliverable_occurrences = await count(exec, sql`SELECT count(*)::int AS n FROM service_deliverable_occurrences WHERE ticket_id = ${s}::uuid`);
  counts.ai_operator_task_targets = await count(exec, sql`SELECT count(*)::int AS n FROM ai_operator_task_targets WHERE ticket_id = ${s}::uuid`);
  counts.ticket_drafts = await count(exec, sql`SELECT count(*)::int AS n FROM ticket_drafts WHERE ticket_id = ${s}::uuid`);
  const plan = planLinkRepoint(await loadOrgLinks(exec, src.orgId), s, d);
  counts.ticket_links = plan.moves.length;

  // A principal the caller cannot read (partner row under an org-scope
  // context) is listed by id with no name.
  const retained = (await exec.execute(sql`
    SELECT r.id, p.name AS "principalName"
      FROM ticket_external_refs r
      LEFT JOIN partner_service_principals p ON p.id = r.partner_service_principal_id
     WHERE r.ticket_id = ${s}::uuid
       AND EXISTS (SELECT 1 FROM ticket_external_refs o
                    WHERE o.ticket_id = ${d}::uuid AND o.partner_service_principal_id = r.partner_service_principal_id)
     ORDER BY r.id`)) as unknown as Array<{ id: string; principalName: string | null }>;

  return {
    eligible: refusals.length === 0,
    refusals,
    counts,
    droppedLinks: plan.dropped,
    retainedExternalRefs: retained.map((r) => ({ id: r.id, principalName: r.principalName ?? null })),
    ...base,
  };
}
