/**
 * Org movers carry merged tombstones (#8972, spec §3.9).
 *
 * A tombstone points at its survivor through the composite same-org FK
 * `tickets_merged_into_org_fk`, so whenever a survivor changes org every
 * tombstone merged into it must change with it, in the same transaction, or
 * the FK fails at commit (both movers name it in SET CONSTRAINTS … DEFERRED).
 * `moveTicketOrg` and the device mover call this after re-stamping the
 * survivor(s). A tombstone's own device_id is NULL (§3.3), so the device
 * mover's `tickets.device_id = D` join never reaches it — only this does.
 *
 * Each tombstone gets the per-ticket move routine the ticket axis applies
 * (intents, drafts, agent runs, Operator targets, findings, the ticket row,
 * comment run pointers, every TICKET_ORG_DENORMALIZED_TABLES child — outbox,
 * attachments, email links, external refs, idempotency keys, … — and links).
 * Most of those are empty on a tombstone (merge moved them to the survivor),
 * but what stays on it (outbox history, a colliding external ref, idempotency
 * keys, the merge note) must follow.
 *
 * Lock order: the caller already holds the survivor(s) and their children.
 * The tombstones are locked here in one ascending batch. This is the one
 * place their pre-ticket children are touched after a ticket lock; it cannot
 * cycle, because a tombstone is read-only: every writer that locks one
 * refuses it immediately (TICKET_MERGED) without touching a child or waiting
 * on another lock, caller verification (Gate B6) only ever holds ONE ticket
 * row, and a merge serializes with both movers on the per-org ticket_links
 * lock.
 */
import { sql } from 'drizzle-orm';
import { lockTicketsForWrite, type DbExecutor } from '../ticketRowLock';
import { TICKET_ORG_DENORMALIZED_TABLES } from '../ticketOrgMoveLockOrder';
import { reresolveMovedTicketCalendars } from '../businessCalendars/reresolve';

type Tx = Pick<DbExecutor, 'execute' | 'select' | 'update'>;

const ids = (list: readonly string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * Re-stamp every tombstone merged into one of `survivorIds` into
 * `targetOrgId`. Returns the tombstone ids moved.
 */
export async function carryMergedTombstonesInTx(
  tx: Tx,
  survivorIds: readonly string[],
  targetOrgId: string,
): Promise<string[]> {
  if (survivorIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT id FROM tickets
     WHERE merged_into_ticket_id IN (${ids(survivorIds)}) AND org_id IS DISTINCT FROM ${targetOrgId}::uuid
     ORDER BY id`)) as unknown as Array<{ id: string }>;
  const tombs = rows.map((r) => r.id);
  if (tombs.length === 0) return [];
  await lockTicketsForWrite(tx as DbExecutor, tombs);
  const list = ids(tombs);
  const targetPartner = sql`(SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)`;

  // Composite (x, org_id) → tickets FKs that are IMMEDIATE on both movers: cleared first.
  await tx.execute(sql`UPDATE action_intents SET scope_ticket_id = NULL WHERE scope_ticket_id IN (${list})`);
  await tx.execute(sql`DELETE FROM ticket_drafts WHERE ticket_id IN (${list})`);
  // Plain pointers that would name a ticket in another tenant (ticket-axis twins).
  await tx.execute(sql`UPDATE ai_agent_runs SET ticket_id = NULL WHERE ticket_id IN (${list})`);
  await tx.execute(sql`
    UPDATE ai_operator_task_targets
       SET ticket_id = NULL,
           detached_at = COALESCE(detached_at, now()),
           detached_reason = COALESCE(detached_reason, 'scope_invalidated'),
           state = 'detached',
           updated_at = now()
     WHERE ticket_id IN (${list})`);
  await tx.execute(sql`
    UPDATE device_vulnerabilities SET ticket_id = NULL
     WHERE ticket_id IN (${list}) AND org_id IS DISTINCT FROM ${targetOrgId}::uuid`);

  await tx.execute(sql`
    UPDATE tickets
       SET org_id = ${targetOrgId}::uuid, partner_id = ${targetPartner},
           device_id = NULL, requester_contact_id = NULL,
           -- An assignee never crosses partners (a system-scope device move can):
           -- the tombstone keeps it as history only inside its own partner.
           assigned_to = CASE WHEN partner_id IS DISTINCT FROM ${targetPartner} THEN NULL ELSE assigned_to END,
           updated_at = now()
     WHERE id IN (${list})`);
  // #8973 W4 (spec §4.3 "Move-org"): like every moved ticket, a tombstone
  // re-resolves its business calendar for the org it now belongs to, so a
  // source-org calendar is never left referenced. Rows already locked above.
  await reresolveMovedTicketCalendars(tx, tombs);
  await tx.execute(sql`
    UPDATE ticket_comments SET agent_run_id = NULL, proposed_by_run_id = NULL
     WHERE ticket_id IN (${list}) AND (agent_run_id IS NOT NULL OR proposed_by_run_id IS NOT NULL)`);

  // A principal-pinned row cannot cross partners (device mover precedent).
  await tx.execute(sql`
    DELETE FROM ticket_external_refs WHERE ticket_id IN (${list}) AND partner_id IS DISTINCT FROM ${targetPartner}`);
  await tx.execute(sql`
    DELETE FROM partner_api_idempotency_keys WHERE ticket_id IN (${list}) AND partner_id IS DISTINCT FROM ${targetPartner}`);
  for (const table of TICKET_ORG_DENORMALIZED_TABLES) {
    await tx.execute(table === 'time_entries'
      ? sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid, site_id = NULL WHERE ticket_id IN (${list})`
      : sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (${list})`);
  }
  await tx.execute(sql`DELETE FROM ticket_links WHERE source_ticket_id IN (${list}) OR target_ticket_id IN (${list})`);
  return tombs;
}
