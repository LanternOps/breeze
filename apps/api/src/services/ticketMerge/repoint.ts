/**
 * Ticket merge re-point engine (#8972, spec §3.3).
 *
 * Moves the SOURCE ticket's children onto the SURVIVOR inside the merge
 * transaction (services/ticketMerge/execute.ts), which already holds, in the
 * global order (#3778, spec §3.5): the per-org ticket_links lock (exclusive),
 * the org SHARE, the source's drafts and AI Operator targets, then source,
 * survivor and every ticket merged into the source FOR UPDATE (ascending id).
 *
 * Statements run in the canonical child order — `ticket_comments`, then
 * TICKET_CHILD_ORG_REWRITE_LOCK_ORDER (ticketOrgMoveLockOrder.ts) — so a merge
 * never takes two child tables in the opposite order of the movers or of a
 * ticket-first writer. Merge is same-org: every row keeps its own `org_id`.
 *
 * Billing rows (§3.3): `time_entries` and `ticket_parts` move by `ticket_id`
 * ONLY — billing status, rate, amount, contract line and block draw are
 * untouched, and no invoice, contract or charge row is read or locked (W0's
 * billing lock order is not entered). `invoice_lines` keep `ticket_id =
 * source` and their frozen labels: issued history is unchanged.
 */
import { sql } from 'drizzle-orm';
import { ticketLinkLabel, type TicketLinkType } from '@breeze/shared';
import type { DbExecutor } from '../ticketRowLock';
import { TICKET_LINK_LIMIT } from '../ticketLinkService';

/** Tables whose rows a merge moves (or, for drafts, deletes). */
export const MERGED_TABLES = [
  'ticket_comments',
  'time_entries',
  'ticket_parts',
  'ticket_alert_links',
  'ticket_attachments',
  'ticket_email_links',
  'ticket_checklist_items',
  'ticket_external_refs',
  'ticket_links',
  'device_vulnerabilities',
  'organization_key_dates',
  'service_deliverable_occurrences',
  'ai_operator_task_targets',
  'ticket_drafts',
] as const;
export type MergedTable = (typeof MERGED_TABLES)[number];
export type MergeCounts = Record<MergedTable, number>;

export type DroppedLinkReason = 'between_pair' | 'pair_unique' | 'self' | 'canonical_duplicate' | 'cycle' | 'limit';

export interface DroppedLink {
  linkId: string;
  linkType: TicketLinkType;
  otherTicketId: string;
  reason: DroppedLinkReason;
}

export interface RepointResult {
  counts: MergeCounts;
  droppedLinks: DroppedLink[];
  /** How each dropped link read from the source (for the merge comment). */
  droppedLinkDirections: Map<string, 'outgoing' | 'incoming'>;
  /** External refs left on the tombstone (same-principal collision with the survivor). */
  retainedExternalRefIds: string[];
}

export function emptyMergeCounts(): MergeCounts {
  return Object.fromEntries(MERGED_TABLES.map((t) => [t, 0])) as MergeCounts;
}

type Exec = Pick<DbExecutor, 'execute'>;

async function rows<T>(tx: Exec, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)) as unknown as T[];
}

/** Row count of an UPDATE / DELETE … RETURNING 1. */
async function affected(tx: Exec, q: ReturnType<typeof sql>): Promise<number> {
  return (await rows<unknown>(tx, q)).length;
}

/**
 * Re-point every child of `srcId` to `dstId` (§3.3). The caller holds the
 * locks listed in the file header and has re-validated eligibility under them.
 */
export async function repointTicketChildren(
  tx: Exec,
  srcId: string,
  dstId: string,
  orgId: string,
): Promise<RepointResult> {
  const counts = emptyMergeCounts();

  // ticket_comments — interleave on the survivor by created_at. The origin is
  // set only when null, so a comment merged twice keeps its EARLIEST origin.
  // Neither column is in breeze_ticket_comments_touch_parent_feed's column
  // list, so moved comments do not touch either ticket's feed stamp.
  counts.ticket_comments = await affected(tx, sql`
    UPDATE ticket_comments
       SET ticket_id = ${dstId}::uuid,
           merged_from_ticket_id = COALESCE(merged_from_ticket_id, ${srcId}::uuid)
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // TICKET_CHILD_ORG_REWRITE_LOCK_ORDER from here on.
  counts.time_entries = await affected(tx, sql`
    UPDATE time_entries SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);
  counts.ticket_parts = await affected(tx, sql`
    UPDATE ticket_parts SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // UNIQUE (ticket_id, alert_id): where both link the same alert, the
  // survivor's row wins and the source's goes.
  await tx.execute(sql`
    DELETE FROM ticket_alert_links s
     WHERE s.ticket_id = ${srcId}::uuid
       AND EXISTS (SELECT 1 FROM ticket_alert_links d WHERE d.ticket_id = ${dstId}::uuid AND d.alert_id = s.alert_id)`);
  counts.ticket_alert_links = await affected(tx, sql`
    UPDATE ticket_alert_links SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // ticket_outbox stays on the tombstone (history).

  // comment_id follows its (already moved) comment.
  counts.ticket_attachments = await affected(tx, sql`
    UPDATE ticket_attachments SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // Every link row moves. The source's own email_message_id / email_thread_key
  // live on the tickets row and stay on the tombstone (§3.8).
  counts.ticket_email_links = await affected(tx, sql`
    UPDATE ticket_email_links SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // Appended after the survivor's last item, keeping the source's own order.
  counts.ticket_checklist_items = await affected(tx, sql`
    UPDATE ticket_checklist_items
       SET ticket_id = ${dstId}::uuid,
           position = position + 1 + COALESCE(
             (SELECT max(d.position) FROM ticket_checklist_items d WHERE d.ticket_id = ${dstId}::uuid), -1)
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // UNIQUE (principal, ticket_id): a ref whose principal already has one on
  // the survivor STAYS on the tombstone, so a Partner API read of that
  // external id returns the tombstone with mergedIntoTicketId (§3.7).
  counts.ticket_external_refs = await affected(tx, sql`
    UPDATE ticket_external_refs s SET ticket_id = ${dstId}::uuid
     WHERE s.ticket_id = ${srcId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM ticket_external_refs d
          WHERE d.ticket_id = ${dstId}::uuid AND d.partner_service_principal_id = s.partner_service_principal_id)
    RETURNING 1`);
  const retained = await rows<{ id: string }>(tx, sql`
    SELECT id FROM ticket_external_refs WHERE ticket_id = ${srcId}::uuid ORDER BY id`);

  // partner_api_idempotency_keys stay (replay resolves the tombstone, §3.3);
  // ticket_approval_requests cannot exist (MERGE_APPROVAL_STATE, D3).

  const links = await repointTicketLinks(tx, srcId, dstId);
  counts.ticket_links = links.moved;

  // Live work pointers outside the child order (§3.3).
  counts.device_vulnerabilities = await affected(tx, sql`
    UPDATE device_vulnerabilities SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);
  counts.organization_key_dates = await affected(tx, sql`
    UPDATE organization_key_dates SET reminder_ticket_id = ${dstId}::uuid
     WHERE reminder_ticket_id = ${srcId}::uuid
    RETURNING 1`);
  // Unreachable in practice (a pinned source is refused, MERGE_DELIVERABLE_PINNED);
  // kept so a pointer can never be left on a tombstone.
  counts.service_deliverable_occurrences = await affected(tx, sql`
    UPDATE service_deliverable_occurrences SET ticket_id = ${dstId}::uuid
     WHERE ticket_id = ${srcId}::uuid AND org_id = ${orgId}::uuid
    RETURNING 1`);
  // Locked by the caller before the tickets (a pre-ticket child, #3778).
  counts.ai_operator_task_targets = await affected(tx, sql`
    UPDATE ai_operator_task_targets SET ticket_id = ${dstId}::uuid, updated_at = now()
     WHERE ticket_id = ${srcId}::uuid
    RETURNING 1`);

  // The source's drafts (locked by the caller before the tickets) are
  // deleted, as on an org move.
  counts.ticket_drafts = await affected(tx, sql`
    DELETE FROM ticket_drafts WHERE ticket_id = ${srcId}::uuid RETURNING 1`);

  return {
    counts,
    droppedLinks: links.dropped,
    droppedLinkDirections: links.directions,
    retainedExternalRefIds: retained.map((r) => r.id),
  };
}

interface LinkRow { id: string; source_ticket_id: string; target_ticket_id: string; link_type: TicketLinkType }

function canonical(sourceId: string, targetId: string, linkType: TicketLinkType): [string, string] {
  return linkType === 'related' && sourceId > targetId ? [targetId, sourceId] : [sourceId, targetId];
}

/**
 * Re-point both legs of the source's links (§3.3), one link at a time in
 * creation order, re-checking each against the state the earlier ones left:
 *   - a link between source and survivor is deleted (`between_pair`);
 *   - `related` is re-canonicalised (source < target);
 *   - a link that would break pair-uniqueness, the self-link CHECK, the single
 *     canonical `duplicate_of`, the duplicate depth rules, the cycle rule or
 *     TICKET_LINK_LIMIT is dropped, and returned for the merge comment.
 * The caller holds the org's exclusive ticket_links lock, so nothing else
 * writes a link of this org meanwhile.
 */
export async function repointTicketLinks(
  tx: Exec,
  srcId: string,
  dstId: string,
): Promise<{ moved: number; dropped: DroppedLink[]; directions: Map<string, 'outgoing' | 'incoming'> }> {
  const links = await rows<LinkRow>(tx, sql`
    SELECT id, source_ticket_id, target_ticket_id, link_type FROM ticket_links
     WHERE source_ticket_id = ${srcId}::uuid OR target_ticket_id = ${srcId}::uuid
     ORDER BY created_at, id`);
  const dropped: DroppedLink[] = [];
  const directions = new Map<string, 'outgoing' | 'incoming'>();
  let moved = 0;
  for (const link of links) {
    directions.set(link.id, link.source_ticket_id === srcId ? 'outgoing' : 'incoming');
    const other = link.source_ticket_id === srcId ? link.target_ticket_id : link.source_ticket_id;
    const reason = await linkDropReason(tx, link, srcId, dstId, other);
    if (reason) {
      await tx.execute(sql`DELETE FROM ticket_links WHERE id = ${link.id}::uuid`);
      dropped.push({ linkId: link.id, linkType: link.link_type, otherTicketId: other, reason });
      continue;
    }
    const [s, t] = canonical(
      link.source_ticket_id === srcId ? dstId : link.source_ticket_id,
      link.target_ticket_id === srcId ? dstId : link.target_ticket_id,
      link.link_type,
    );
    await tx.execute(sql`
      UPDATE ticket_links SET source_ticket_id = ${s}::uuid, target_ticket_id = ${t}::uuid
       WHERE id = ${link.id}::uuid`);
    moved++;
  }
  return { moved, dropped, directions };
}

async function linkDropReason(
  tx: Exec,
  link: LinkRow,
  srcId: string,
  dstId: string,
  other: string,
): Promise<DroppedLinkReason | null> {
  if (other === dstId) return 'between_pair';
  const [s, t] = canonical(
    link.source_ticket_id === srcId ? dstId : link.source_ticket_id,
    link.target_ticket_id === srcId ? dstId : link.target_ticket_id,
    link.link_type,
  );
  if (s === t) return 'self';
  const [dup] = await rows<{ n: number }>(tx, sql`
    SELECT count(*)::int AS n FROM ticket_links
     WHERE source_ticket_id = ${s}::uuid AND target_ticket_id = ${t}::uuid
       AND link_type = ${link.link_type}::ticket_link_type AND id <> ${link.id}::uuid`);
  if ((dup?.n ?? 0) > 0) return 'pair_unique';
  if (link.link_type === 'duplicate_of') {
    // ticketLinkService.assertDuplicateRules, against the re-pointed edge:
    // one canonical per duplicate, no duplicate of a duplicate, and a ticket
    // with duplicates cannot itself be one.
    const [hit] = await rows<{ n: number }>(tx, sql`
      SELECT count(*)::int AS n FROM ticket_links
       WHERE link_type = 'duplicate_of' AND id <> ${link.id}::uuid
         AND (source_ticket_id = ${s}::uuid OR source_ticket_id = ${t}::uuid OR target_ticket_id = ${s}::uuid)`);
    if ((hit?.n ?? 0) > 0) return 'canonical_duplicate';
  }
  if (link.link_type === 'caused_by' || link.link_type === 'resolves') {
    // Is `s` reachable from `t` along this type, ignoring this link itself
    // (it still has its source leg)?
    // Source and survivor are one node by now: edges not yet re-pointed still
    // name the source, so the walk reads every edge with source → survivor.
    const reach = await rows<{ hit: number }>(tx, sql`
      WITH RECURSIVE edges(src, dst) AS (
        SELECT CASE WHEN source_ticket_id = ${srcId}::uuid THEN ${dstId}::uuid ELSE source_ticket_id END,
               CASE WHEN target_ticket_id = ${srcId}::uuid THEN ${dstId}::uuid ELSE target_ticket_id END
          FROM ticket_links
         WHERE link_type = ${link.link_type}::ticket_link_type AND id <> ${link.id}::uuid
      ), reach(id) AS (
        SELECT dst FROM edges WHERE src = ${t}::uuid
        UNION
        SELECT e.dst FROM edges e JOIN reach r ON e.src = r.id
      )
      SELECT 1 AS hit FROM reach WHERE id = ${s}::uuid LIMIT 1`);
    if (reach.length > 0) return 'cycle';
  }
  // The counterpart's count is unchanged (its link moves legs); the survivor
  // gains one.
  const [cap] = await rows<{ n: number }>(tx, sql`
    SELECT count(*)::int AS n FROM ticket_links
     WHERE (source_ticket_id = ${dstId}::uuid OR target_ticket_id = ${dstId}::uuid) AND id <> ${link.id}::uuid`);
  if ((cap?.n ?? 0) >= TICKET_LINK_LIMIT) return 'limit';
  return null;
}

/** "related T-2026-0007 (dropped: already linked)" lines for the merge comment. */
export function describeDroppedLinks(
  dropped: readonly DroppedLink[],
  numberOf: (ticketId: string) => string,
  directions: ReadonlyMap<string, 'outgoing' | 'incoming'>,
): string[] {
  const why: Record<DroppedLinkReason, string> = {
    between_pair: 'it linked the two merged tickets',
    pair_unique: 'the survivor already had that link',
    self: 'it would link the ticket to itself',
    canonical_duplicate: 'it broke the duplicate rules',
    cycle: 'it would create a cycle',
    limit: `the survivor reached ${TICKET_LINK_LIMIT} links`,
  };
  return dropped.map((d) => {
    const direction = directions.get(d.linkId) ?? 'outgoing';
    return `${ticketLinkLabel(d.linkType, direction).replace(/_/g, ' ')} ${numberOf(d.otherTicketId)} (dropped: ${why[d.reason]})`;
  });
}
