/**
 * The shared lock order for the two ORG-MOVE paths that re-stamp the
 * ticket-linked child tables denormalizing `org_id`, plus the ticket-axis
 * table list that must respect it.
 *
 * Two independent transactions re-stamp these rows and can contend for the
 * SAME row, so they must take the locks in the SAME order or Postgres kills
 * one with 40P01:
 *
 *   - Ticket axis — `moveTicketOrg` (services/ticketService.ts), driven by
 *     {@link TICKET_ORG_DENORMALIZED_TABLES} below, `WHERE ticket_id = X`.
 *   - Device axis — `POST /devices/:id/move-org` (routes/devices/moveOrg.ts),
 *     driven by `CUSTOM_ORG_REWRITE_TABLES` (routes/devices/core.ts), one
 *     hand-written UPDATE per table because none of them has a `device_id`
 *     column to key on.
 *
 * The overlap is real, not theoretical (#4657): a `ticket_alert_links` row
 * joining ticket X to an alert raised on device D is selected by BOTH a
 * device-move of D (`alert_id IN (SELECT id FROM alerts WHERE device_id = D)`)
 * and a concurrent `moveTicketOrg(X, …)` (`ticket_id = X`). Before #4657 the
 * device axis took `ticket_alert_links` BEFORE `time_entries`/`ticket_parts`
 * while the ticket axis took it AFTER — a live AB-BA that surfaced as a 500 on
 * an admin action. Neither ordering was more correct; having two was the bug.
 *
 * This module exists so the order is stated ONCE. Before #4657 each path
 * carried its own locally-reasoned comment, and the two reached opposite
 * conclusions without either being wrong on its own terms.
 *
 * SCOPE — one other walker touches these tables and is now governed here too:
 *
 *   - Org erasure (`cascadeDeleteOrg`, services/tenantCascade.ts) is NOT a
 *     hazard: it gives each table its OWN system-context transaction, so it
 *     never holds two of these locks at once and cannot form a cycle with
 *     either mover.
 *   - Org MERGE (services/orgMerge.ts) is a genuine third walker — the whole
 *     merge runs in ONE transaction over `topologicalCascadeOrder()` reversed,
 *     which ties on alphabetical order for tables with no FK between them
 *     (see the FK note below) — exactly the six tables here. Left alone, that
 *     tie-break disagrees with the order below (#4748: for six siblings it
 *     yields time_entries -> ticket_parts -> ticket_outbox ->
 *     ticket_email_links -> ticket_attachments -> ticket_alert_links, not a
 *     single trailing-pair swap). `fenceLoser()` stamps the loser org
 *     `status='merging'` before the merge transaction opens and the
 *     device/ticket move routes refuse a fenced org, but that fence is
 *     app-layer — it does not close the window for a move already in flight
 *     when the fence lands. `applyTicketChildLockOrder` below is the fix:
 *     `orgMerge.ts` routes both of its walk-order computations through it so
 *     the merge's ticket-child slots always read out in the SAME relative
 *     order as the movers, closing the AB-BA window rather than merely
 *     documenting it.
 *
 * Contract enforced by ticketOrgMoveLockOrder.test.ts (both lists agree with
 * this order) and by moveOrg.test.ts (the device path's actual statement
 * sequence equals `CUSTOM_ORG_REWRITE_TABLES`). The ticket path needs no
 * separate statement check — its loop iterates the array literally.
 *
 * FK note: all six are children of `tickets` and none references another, so
 * children-before-parents does not constrain their relative order. `tickets`
 * itself is locked before all of them on both axes.
 */
export const TICKET_CHILD_ORG_REWRITE_LOCK_ORDER = [
  // time_entries and ticket_parts lead because the shared currency guard
  // (services/ticketMoveCurrencyGuard.ts) takes them `FOR UPDATE`, in this
  // order, on BOTH axes before either path rewrites anything. That guard runs
  // after `UPDATE tickets` and cannot move, so the canonical order is anchored
  // to it rather than chosen freely.
  'time_entries',
  'ticket_parts',
  'ticket_alert_links',
  // ticket_outbox (#4743) joined the device axis alongside ticket_alert_links
  // and ticket_attachments — it is no longer ticket-axis-only, so it is now
  // governed by this shared order too. Placed AFTER ticket_alert_links and
  // BEFORE ticket_attachments to match where it already sat in
  // TICKET_ORG_DENORMALIZED_TABLES.
  'ticket_outbox',
  'ticket_attachments',
  // ticket_email_links (#4643) closes the gap called out below: it now joins
  // BOTH axes, appended last after ticket_attachments on each.
  'ticket_email_links',
] as const;

/**
 * Tables `moveTicketOrg` re-stamps in this order, `WHERE ticket_id = <ticket>`.
 *
 * Ordering is NOT free: the entries shared with the device axis must appear in
 * {@link TICKET_CHILD_ORG_REWRITE_LOCK_ORDER}'s relative order (#4657), which
 * as of #4643 is every entry in this list — the device axis now reaches all
 * six.
 *
 * ticket_comments is deliberately absent: it has no `org_id` (child-via-parent
 * tenancy), so a moved ticket carries its comments implicitly.
 *
 * invoice_lines is deliberately excluded: issued billing history must stay
 * stamped with the org that was billed (the device path excludes it for the
 * same reason). Its `ticket_id` FK is ON DELETE SET NULL, so moves never
 * orphan it.
 *
 * ticket_attachments (W08 #3902): comment photo/PDF metadata rows denormalize
 * org_id from their ticket (shape 1) and have no `device_id`. Ordered last on
 * both axes. Its S3 objects are keyed by attachment id only (spec D8) and are
 * NOT touched by a move — only the metadata row's org_id is re-stamped.
 *
 * ticket_outbox (#3828 wave-6-3 review fix) carries both `ticket_id` and a
 * denormalized `org_id` (2026-09-19-ai-agents-ticket-shadow.sql). An
 * unpublished row left on the source org would publish under the old org's
 * routing, resolving the wrong org's helpdesk agents and letting the context
 * assembler load the moved ticket's content into a run scoped to an org that
 * no longer owns it. The mover holds access to both orgs (same-partner
 * constraint), so RLS USING/WITH CHECK both pass.
 *
 * ticket_email_links (#4643) closes the gap left by the #4524 fix: it
 * denormalizes org_id from its ticket (shape 1, FORCE RLS) and has no
 * `device_id`, same shape as ticket_attachments. It is now rewritten on BOTH
 * axes, appended last after ticket_attachments so the two movers keep
 * touching the ticket-linked child tables in the same relative order.
 */
export const TICKET_ORG_DENORMALIZED_TABLES = [
  'time_entries',
  'ticket_parts',
  'ticket_alert_links',
  'ticket_outbox',
  'ticket_attachments',
  'ticket_email_links',
] as const;

/**
 * Reorders a merge-style table walk (e.g. a reversed
 * `topologicalCascadeOrder()`) so the six tables in
 * {@link TICKET_CHILD_ORG_REWRITE_LOCK_ORDER} occupy their SAME index
 * positions but in canonical relative order — every other table's position
 * is left untouched.
 *
 * Exists for org merge (#4748): `orgMerge.ts` derives its walk order from
 * `topologicalCascadeOrder()`, which ties on alphabetical order for tables
 * with no FK between them. The six ticket child tables are exactly such a
 * set (see the FK note above — none of the six references another, so
 * children-before-parents never constrains their relative order), so it is
 * always safe to permute them into the canonical order without disturbing
 * FK-safety: we never move a table INTO or OUT OF the slots it already
 * occupies, only change which of the six values lands in each slot.
 *
 * `walkOrder` may contain any subset of the six (a caller doesn't have to
 * pass all of them) — the ones present are placed in canonical relative
 * order among themselves; anything absent is simply skipped.
 */
export function applyTicketChildLockOrder(walkOrder: readonly string[]): string[] {
  const canonicalSet = new Set<string>(TICKET_CHILD_ORG_REWRITE_LOCK_ORDER);
  const slotIndices: number[] = [];
  walkOrder.forEach((table, index) => {
    if (canonicalSet.has(table)) slotIndices.push(index);
  });
  const present = TICKET_CHILD_ORG_REWRITE_LOCK_ORDER.filter((table) => walkOrder.includes(table));
  if (slotIndices.length !== present.length) {
    // Only reachable if walkOrder has a duplicate ticket-child entry — every
    // real caller (topologicalCascadeOrder() reversed) lists each table
    // exactly once, so this guards a contract violation rather than a
    // reachable runtime state.
    throw new Error(
      `[ticketOrgMoveLockOrder] applyTicketChildLockOrder: walkOrder contains a duplicate ` +
        `ticket child-table entry (found ${slotIndices.length} slots for ${present.length} ` +
        `distinct tables)`,
    );
  }
  const result = [...walkOrder];
  slotIndices.forEach((index, i) => {
    // Safe: the length check above guarantees `present` has exactly one
    // entry per `slotIndices` position.
    result[index] = present[i] as string;
  });
  return result;
}
