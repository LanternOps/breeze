/**
 * Registry of every writer of a ticket child row (#8972 W0, spec §3.5).
 *
 * Invariant: a writer of a child row locks the ticket row FIRST
 * (`lockTicketForWrite` / `lockTicketsForWrite`, ./ticketRowLock.ts), then
 * locks or writes the child. A writer whose answer depends on what it read
 * unlocked (the ticket's existence, org, deleted state, SLA clock) re-checks
 * it on the locked row; one handed an already-authorized ticket by its caller
 * may rely on the insert's own FK / RLS answer instead. See
 * ticketRowLock.ts for why, and for the global lock order.
 *
 * ticketChildWriters.contract.test.ts scans every function in
 * apps/api/src/**\/*.ts (non-test) for a write to a table in
 * TICKET_CHILD_TABLES and fails until the function is registered here. For a
 * `ticket-first` writer it also checks that a ticket lock call comes before the
 * child write. The scan proves registration and CALL ORDER only; lock order
 * between two transactions is proven by
 * src/__tests__/integration/ticketChildLockOrder.integration.test.ts.
 *
 * Classes:
 * - `ticket-first`     takes the ticket row lock before the child write. With
 *                      `lockHeldByCaller`, the helper itself does not lock:
 *                      every call site must take the lock first (the contract
 *                      checks each one).
 * - `pre-ticket-child` writes `ticket_drafts`, which the #3778 global order
 *                      places BEFORE `tickets`: the draft is locked first.
 * - `mover`            re-stamps a ticket's children for an org move or org
 *                      merge; locks the ticket (or the whole org set) first
 *                      under its own documented order.
 * - `cascade`          org / partner erasure: one table per transaction, never
 *                      holds two of these locks at once.
 * - `maintenance`      a background or exceptional writer that takes no ticket
 *                      lock at all, with the reason it cannot form a cycle.
 *
 * Tombstones (#8972 W1, spec §3.2, Gate B10): a merged ticket is read-only.
 * Every `ticket-first` / `pre-ticket-child` writer has `tombstoneGuard: true`
 * and checks `assertTicketNotMerged` (or, for a sweep or a mover's side note
 * that must skip rather than fail its batch, `isMergedTombstone`) on the row
 * its ticket lock returned, before its first child write — directly, through
 * a TICKET_GUARDING_LOCK_WRAPPERS wrapper, or (`lockHeldByCaller` /
 * `guardHeldByCaller`) at every call site. The few that must not refuse a
 * tombstone carry `tombstoneExempt` with the reason instead. The guard runs
 * under the lock because the merge transaction holds the same row lock: an
 * unlocked pre-check races with a merge. Movers carry tombstones with their
 * survivor (T1.9) and are not guarded here.
 */

export const TICKET_CHILD_TABLES = [
  'ticket_comments',
  'ticket_attachments',
  'time_entries',
  'ticket_parts',
  'ticket_checklist_items',
  'ticket_alert_links',
  'ticket_email_links',
  'ticket_external_refs',
  'ticket_links',
  'ticket_drafts',
] as const;

export type TicketChildTable = (typeof TICKET_CHILD_TABLES)[number];

export type TicketChildWriterClass = 'ticket-first' | 'pre-ticket-child' | 'mover' | 'cascade' | 'maintenance';

export interface TicketChildWriter {
  tables: readonly TicketChildTable[];
  lock: TicketChildWriterClass;
  tombstoneGuard: boolean;
  /** `ticket-first` only: the ticket lock is taken by every caller, not by this helper. */
  lockHeldByCaller?: true;
  /** Required for `mover`, `cascade` and `maintenance`: why this writer does not take the ticket lock itself first. */
  reason?: string;
  /** The writer addresses child tables through a table list, so the literal scan cannot see it; it must still exist. */
  dynamicTables?: true;
  /** `tombstoneGuard` only: the guard is checked by every caller (a helper run under its caller's lock). */
  guardHeldByCaller?: true;
  /** A `ticket-first` / `pre-ticket-child` writer that must NOT refuse a tombstone, and why. */
  tombstoneExempt?: string;
}

/** The tombstone guards (services/ticketMerge/errors.ts). */
export const TICKET_TOMBSTONE_GUARDS = ['assertTicketNotMerged', 'assertTicketsNotMerged', 'isMergedTombstone'] as const;

/** The functions that take the ticket row lock. */
export const TICKET_LOCK_PRIMITIVES = ['lockTicketForWrite', 'lockTicketsForWrite'] as const;

/**
 * Functions that take the ticket lock on their caller's behalf. The contract
 * checks each one calls a primitive (or another wrapper) itself, so naming a
 * wrapper here can never stand in for a lock.
 */
export const TICKET_LOCK_WRAPPERS: Record<string, string> = {
  'services/ticketApproval/decisions.ts::lockRequestScope':
    '#4617 approval decision order: org SHARE, the ticket via lockTicketForWrite (SKIP LOCKED for the sweep), then the request',
  'services/ticketChecklistService.ts::lockItemTicket':
    'item-addressed checklist writers: the item\'s ticket via lockTicketForWrite, read unlocked first',
  'services/ticketLinkService.ts::lockTickets':
    'link add / remove: both tickets via lockTicketsForWrite (ascending id), after the per-org links lock',
  'services/ticketService.ts::lockTicketOrThrow':
    'lockTicketForWrite with getTicketOrThrow\'s 404, for the ticketService writers',
  'services/ticketService.ts::lockCommentForWrite':
    'comment edit / delete: lockTicketForWrite, then the comment FOR UPDATE, then the re-checks',
  'services/timeEntryService.ts::lockPartForWrite':
    'part edit / delete: the part\'s ticket via lockTicketRow, then the part FOR UPDATE and the re-check',
  'services/invoiceService.ts::lockInvoiceSourceTickets':
    'invoice issue / void: the time / part sources\' tickets via lockTicketsForWrite, after the contracts and before the sources',
  'routes/tickets/attachments.ts::lockTicketForAttach':
    'attachment upload / from-artifact: lockTicketForWrite, then the 404 / 409 re-check against the unlocked read',
  'services/contractHourBlockClose.ts::lockHourBlockSourceTickets':
    'hour-block close: every closable period\'s entries\' tickets, one ascending lockTicketsForWrite batch, after the contract row',
  'services/ticketService.ts::lockCallerVerificationTarget':
    '#8972 W1 Gate B6: exactly ONE ticket via lockTicketForWrite — the snapshotted ticket, or its survivor when merged '
    + '(pointer re-checked under the lock inside a savepoint)',
  'services/timeEntryService.ts::lockTicketRow':
    'the time-entry 404 mapping around lockTicketForWrite',
  'services/timeEntryService.ts::lockTicketsInOrder':
    '#4617 two-ticket barrier: org SHAREs, then lockTicketRow per ticket in ascending id order',
  'services/timeEntryService.ts::resolveAndLockTicketLink':
    'creation barrier (#3778): org SHARE, then lockTicketRow / lockTicketsInOrder',
  'services/timeEntryService.ts::lockEntryForWrite':
    '#4617 edit order: ticket(s) via resolveAndLockTicketLink / lockTicketsInOrder, then the entry FOR UPDATE',
  'services/timeEntryService.ts::stopRunningEntry':
    '#4617 stop: the running timer\'s ticket via lockTicketsInOrder, then the entry FOR UPDATE (a ticketless or '
    + 'no-longer-visible timer goes through stopUnlinkedEntry and has no ticket to lock)',
};

/**
 * Functions that write no child row themselves but sit between a ticket lock
 * and a `lockHeldByCaller` writer: they run only under their caller's ticket
 * lock. The contract checks every call site, exactly as for the writers.
 */
export const TICKET_LOCK_HELD_FUNCTIONS: Record<string, string> = {
  'services/ticketApproval/writerGate.ts::settleGatedWrite':
    'the approval gate\'s post-write step; every time-entry writer calls it after resolveAndLockTicketLink / lockEntryForWrite',
  'services/ticketApproval/writerGate.ts::settleRemovedEntry':
    'settles a deleted entry\'s request; deleteTimeEntry calls it after lockEntryForWrite',
  'services/timeEntryService.ts::settleAndEmit':
    'runs settleGatedWrite after a time-entry write; its callers hold the ticket lock',
  'services/ticketApproval/requests.ts::afterEntryLeftRequest':
    'settles a request after one of its entries left it; called by the time-entry writers under their ticket lock',
  'services/contractHourBlockClose.ts::closeHourBlockPeriods':
    'runs closeOne per period; the billing run and the close-out sweep call it after lockHourBlockSourceTickets',
};

/**
 * Lock wrappers that also check the tombstone guard on the row they lock
 * (each must be a TICKET_LOCK_WRAPPERS entry; the contract checks the guard
 * follows the lock in its body). A writer that locks through one of these is
 * guarded.
 */
export const TICKET_GUARDING_LOCK_WRAPPERS: Record<string, string> = {
  'services/ticketService.ts::lockTicketOrThrow': 'assertTicketNotMerged on the locked row (every ticketService writer that locks through it)',
  'services/ticketService.ts::lockCommentForWrite': 'assertTicketNotMerged before the comment row lock (a merge note on a tombstone is read-only)',
  'services/ticketChecklistService.ts::lockItemTicket': 'assertTicketNotMerged on the item\'s ticket',
  'services/ticketLinkService.ts::lockTickets': 'assertTicketsNotMerged on both link ends',
  'services/ticketApproval/decisions.ts::lockRequestScope': 'assertTicketNotMerged on the request\'s ticket (unreachable: D3 refuses merging a ticket with requests)',
  'routes/tickets/attachments.ts::lockTicketForAttach': 'isMergedTombstone → 409 TICKET_MERGED, bytes discarded by the caller',
  'services/timeEntryService.ts::lockTicketRow': 'assertTicketNotMerged; every time-entry and part lock below funnels through it',
  'services/timeEntryService.ts::lockTicketsInOrder': 'through lockTicketRow',
  'services/timeEntryService.ts::resolveAndLockTicketLink': 'through lockTicketRow / lockTicketsInOrder',
  'services/timeEntryService.ts::lockEntryForWrite': 'through resolveAndLockTicketLink / lockTicketsInOrder',
  'services/timeEntryService.ts::stopRunningEntry': 'through lockTicketsInOrder (a ticketless timer has no ticket to guard)',
  'services/timeEntryService.ts::lockPartForWrite': 'through lockTicketRow',
};

/**
 * Ticket-ROW writers that write no child row (so the scan above cannot find
 * them) but must refuse a tombstone all the same (spec §3.2 list).
 */
export const TICKET_ROW_GUARDED_WRITERS: Record<string, string> = {
  'services/ticketService.ts::applyAiFieldUpdates': 'AI category / priority CAS update',
  'services/ticketService.ts::restoreTicket': 'a tombstone cannot be restored (spec §3.2)',
  'services/ticketApproval/decisions.ts::createStaffApprovalRequest': 'approval request create',
};

const BILLING_TOMBSTONE_EXEMPT =
  'Billing stamper: locks the tickets its source rows point at now (merge re-points time and parts to the survivor, '
  + 'never to a tombstone) and flips billing state by row id; refusing would fail an invoice or a contract close over '
  + 'a ticket it no longer touches.';

const TF = (tables: readonly TicketChildTable[], extra: Partial<TicketChildWriter> = {}): TicketChildWriter => ({
  tables, lock: 'ticket-first', tombstoneGuard: true, ...extra,
});
const PRE = (tables: readonly TicketChildTable[], extra: Partial<TicketChildWriter> = {}): TicketChildWriter => ({
  tables, lock: 'pre-ticket-child', tombstoneGuard: true, ...extra,
});

export const TICKET_CHILD_WRITERS: Record<string, TicketChildWriter> = {
  // ── Comments (services/ticketService.ts) ────────────────────────────────
  'services/ticketService.ts::addTicketComment': TF(['ticket_comments', 'ticket_attachments']),
  'services/ticketService.ts::editTicketComment': TF(['ticket_comments']),
  'services/ticketService.ts::deleteTicketComment': TF(['ticket_comments']),
  'services/ticketService.ts::addAiTriageNote': TF(['ticket_comments']),
  'services/ticketService.ts::postProposalNote': TF(['ticket_comments']),
  'services/ticketService.ts::addCallerVerificationSystemComment': TF(['ticket_comments'], {
    tombstoneGuard: false,
    tombstoneExempt:
      'Gate B6: a verification effect after a merge redirects its note to the SURVIVOR (lockCallerVerificationTarget '
      + 'locks only that one row) and never throws TICKET_MERGED: a merge must never roll back a security decision.',
  }),
  // Ticket-row writers that also write a feed comment.
  'services/ticketService.ts::changeTicketStatus': TF(['ticket_comments']),
  'services/ticketService.ts::updateTicketFields': TF(['ticket_comments']),
  'services/ticketService.ts::assignTicket': TF(['ticket_comments']),
  'services/ticketService.ts::revalidateTicketAssignee': TF(['ticket_comments']),
  'services/ticketService.ts::linkAlertToTicket': TF(['ticket_alert_links', 'ticket_comments']),
  'services/ticketService.ts::unlinkAlertFromTicket': TF(['ticket_alert_links', 'ticket_comments']),
  // Direct comment / attachment writers outside ticketService.
  'routes/portal/tickets.ts::POST /tickets/:id/comments': TF(['ticket_comments']),
  'services/inboundEmail/emailComments.ts::insertEmailAuthoredComment': TF(['ticket_comments']),
  'services/inboundEmail/inboundAttachments.ts::persistInboundAttachments': TF(['ticket_attachments']),
  'routes/tickets/attachments.ts::POST /:id/attachments': TF(['ticket_attachments']),
  'routes/tickets/attachments.ts::POST /:id/attachments/from-artifact': TF(['ticket_attachments']),
  'routes/tickets/attachments.ts::DELETE /:id/attachments/:attachmentId': TF(['ticket_attachments'], {
    tombstoneGuard: false,
    tombstoneExempt:
      'Refuses a tombstone BEFORE the object delete (unlocked read); after the bytes are gone the row must go too, '
      + 'so the locked step cannot refuse. A merge moves attachments by row id, so the delete stays correct.',
  }),
  'services/ticketLinkMoveNotes.ts::noteTicketLinksRemovedByOrgMove': TF(['ticket_comments']),
  'services/deliverableAutoEvidence.ts::recordRefusal': TF(['ticket_comments']),
  'services/deliverableAutoEvidence.ts::finishRun': TF(['ticket_comments']),
  'services/aiOperator/humanWorkService.ts::sendHumanWorkReminders': TF(['ticket_comments']),
  'services/aiOperator/completionRecord.ts::postCompletionRecord': TF(['ticket_comments']),
  'services/serviceDeliverableService.ts::applyTicketStatusChange': TF(['ticket_comments']),
  'services/serviceDeliverableService.ts::openOneOccurrence': TF(['ticket_checklist_items', 'ticket_comments']),

  // ── Checklist ───────────────────────────────────────────────────────────
  'services/ticketChecklistService.ts::addChecklistItem': TF(['ticket_checklist_items']),
  'services/ticketChecklistService.ts::patchChecklistItem': TF(['ticket_checklist_items']),
  'services/ticketChecklistService.ts::reorderChecklist': TF(['ticket_checklist_items']),
  'services/ticketChecklistService.ts::deleteChecklistItem': TF(['ticket_checklist_items']),
  'services/ticketChecklistTemplateService.ts::applyChecklistTemplateToTicket': TF(['ticket_checklist_items']),
  'services/aiOperator/humanWorkService.ts::openHumanWorkStep': TF(['ticket_checklist_items']),
  'services/aiOperator/manualWork.ts::ensureManualWorkItems': TF(['ticket_checklist_items']),
  'services/aiOperator/manualWork.ts::attachHumanWorkStep': TF(['ticket_checklist_items'], { lockHeldByCaller: true }),

  // ── Links, external refs, email links ───────────────────────────────────
  'services/ticketLinkService.ts::addTicketLink': TF(['ticket_links', 'ticket_comments']),
  'services/ticketLinkService.ts::removeTicketLink': TF(['ticket_links', 'ticket_comments']),
  'services/ticketExternalRefs.ts::upsertTicketExternalRef': TF(['ticket_external_refs']),
  'services/ticketExternalRefs.ts::clearTicketExternalRef': TF(['ticket_external_refs']),
  'services/ticketEmailLinks.ts::claimMessageLink': TF(['ticket_email_links']),

  // ── Time entries and parts (services/timeEntryService.ts, #4617) ────────
  'services/timeEntryService.ts::createTimeEntry': TF(['time_entries']),
  'services/timeEntryService.ts::updateTimeEntry': TF(['time_entries']),
  'services/timeEntryService.ts::deleteTimeEntry': TF(['time_entries']),
  'services/timeEntryService.ts::approveTimeEntries': TF(['time_entries']),
  'services/timeEntryService.ts::addTicketPart': TF(['ticket_parts']),
  'services/timeEntryService.ts::updateTicketPart': TF(['ticket_parts']),
  'services/timeEntryService.ts::deleteTicketPart': TF(['ticket_parts']),
  'services/timeEntryService.ts::attempt': TF(['time_entries'], { lockHeldByCaller: true }),
  'services/timeEntryService.ts::stopLockedTicketEntry': TF(['time_entries'], { lockHeldByCaller: true }),
  'services/timeEntryService.ts::insertTimeEntryFeedComment': TF(['ticket_comments'], { lockHeldByCaller: true }),
  'services/timeEntryService.ts::stopUnlinkedEntry': {
    tables: ['time_entries'],
    lock: 'maintenance',
    tombstoneGuard: false,
    reason:
      'Ungated single-statement CAS stop for a timer with NO ticket (ticket_id IS NULL: not a ticket child) or whose '
      + 'ticket the technician can no longer see (RLS hides the ticket, so it cannot be locked; #4617 keeps that stop '
      + 'ungated rather than wedging every future start). It takes no ticket lock at all, so it can never hold an entry '
      + 'while waiting on a ticket.',
  },

  // ── Customer approval gate (services/ticketApproval, #4617) ─────────────
  'services/ticketApproval/decisions.ts::reaskApprovalRequest': TF(['time_entries']),
  'services/ticketApproval/decisions.ts::writeOffHeldEntry': TF(['time_entries']),
  'services/ticketApproval/decisions.ts::regateHeldEntries': TF(['time_entries'], { lockHeldByCaller: true }),
  'services/ticketApproval/requests.ts::holdEntryOnRequest': TF(['time_entries'], { lockHeldByCaller: true }),
  'services/ticketApproval/requests.ts::insertApprovalComment': TF(['ticket_comments'], { lockHeldByCaller: true }),

  // ── Billing stampers: several tickets per write, ascending, after the contract rows ──
  // #8972 W1: exempt from the tombstone guard (BILLING_TOMBSTONE_EXEMPT).
  'services/invoiceService.ts::issueTx': TF(['time_entries', 'ticket_parts'], { tombstoneGuard: false, tombstoneExempt: BILLING_TOMBSTONE_EXEMPT }),
  'services/invoiceService.ts::voidInvoice': TF(['time_entries', 'ticket_parts'], { tombstoneGuard: false, tombstoneExempt: BILLING_TOMBSTONE_EXEMPT }),
  'services/contractHourBlockClose.ts::closeOne': TF(['time_entries'], { lockHeldByCaller: true, tombstoneGuard: false, tombstoneExempt: BILLING_TOMBSTONE_EXEMPT }),

  // ── Drafts: pre-ticket children (#3778 order: ticket_drafts before tickets) ──
  'services/ticketService.ts::sendTicketDraft': PRE(['ticket_drafts', 'ticket_comments']),
  'services/ticketService.ts::discardTicketDraft': PRE(['ticket_drafts']),
  'services/ticketService.ts::consumeResolutionDraft': PRE(['ticket_drafts'], { guardHeldByCaller: true }),
  'services/aiToolsTicketing.ts::insertDraft': PRE(['ticket_drafts']),

  // ── Movers ──────────────────────────────────────────────────────────────
  'services/ticketService.ts::moveTicketOrg': {
    tables: ['ticket_drafts', 'ticket_comments', 'ticket_links', 'time_entries', 'ticket_parts', 'ticket_alert_links',
      'ticket_attachments', 'ticket_email_links', 'ticket_checklist_items', 'ticket_external_refs'],
    lock: 'mover',
    tombstoneGuard: false,
    dynamicTables: true,
    reason:
      'Ticket org move: links lock, org SHAREs, pre-ticket children, UPDATE tickets, then the children in '
      + 'TICKET_CHILD_ORG_REWRITE_LOCK_ORDER (#3778 comment in the function). The UPDATE of the ticket row is the '
      + 'ticket lock and precedes every child write except the pre-ticket ticket_drafts delete.',
  },
  'services/deviceOrgMove/moveDeviceOrgInTransaction.ts::moveDeviceOrgInTransaction': {
    tables: ['ticket_comments', 'ticket_external_refs', 'ticket_links', 'time_entries', 'ticket_parts',
      'ticket_alert_links', 'ticket_attachments', 'ticket_email_links', 'ticket_checklist_items'],
    lock: 'mover',
    tombstoneGuard: false,
    reason:
      'Device org move: re-stamps the device tickets (UPDATE tickets) before their children, in the shared '
      + 'TICKET_CHILD_ORG_REWRITE_LOCK_ORDER (ticketOrgMoveLockOrder.ts, pinned by moveOrg.test.ts).',
  },
  'services/orgMerge.ts::runPolicy': {
    tables: ['ticket_comments', 'ticket_attachments', 'time_entries', 'ticket_parts', 'ticket_checklist_items',
      'ticket_alert_links', 'ticket_email_links', 'ticket_external_refs', 'ticket_links', 'ticket_drafts'],
    lock: 'mover',
    tombstoneGuard: false,
    dynamicTables: true,
    reason:
      'Org merge repoint: one transaction walking topologicalCascadeOrder() reversed, routed through '
      + 'applyTicketChildLockOrder so ticket children lock in the movers\' order; the loser org is fenced '
      + '(status merging) and its rows move wholesale by org_id, not per ticket.',
  },
  'services/orgMergeCustomExecutors.ts::resolveTicketDrafts': {
    tables: ['ticket_drafts'],
    lock: 'mover',
    tombstoneGuard: false,
    reason:
      'Org merge custom executor: drops the loser org\'s ticket_drafts (run-pinned, cannot be repointed); '
      + 'ticket_drafts is a pre-ticket table in the #3778 order, and the merge holds the fenced org set.',
  },

  // ── Ticket merge (#8972 W1, spec §3.5) ──────────────────────────────────
  'services/ticketMerge/execute.ts::mergeInTx': {
    tables: ['ticket_comments', 'ticket_drafts'],
    lock: 'mover',
    tombstoneGuard: false,
    reason:
      'Ticket merge: per-org links lock (exclusive), org SHARE, the source\'s drafts and Operator targets, then '
      + 'source + survivor + every ticket merged into the source in ONE ascending lockTicketsForWrite batch, then '
      + 'the children (repoint.ts). Writes the two merge notes after every lock is held; eligibility (incl. '
      + 'already-merged) is re-checked on the locked rows.',
  },
  'services/ticketMerge/repoint.ts::repointTicketChildren': {
    tables: ['ticket_comments', 'time_entries', 'ticket_parts', 'ticket_alert_links', 'ticket_attachments',
      'ticket_email_links', 'ticket_checklist_items', 'ticket_external_refs', 'ticket_drafts'],
    lock: 'mover',
    tombstoneGuard: false,
    reason:
      'Ticket merge re-point: runs only inside mergeInTx after the ticket locks, one statement per table in '
      + 'ticket_comments → TICKET_CHILD_ORG_REWRITE_LOCK_ORDER; same-org, ticket_id only (billing fields untouched).',
  },
  'services/ticketMerge/movers.ts::carryMergedTombstonesInTx': {
    tables: ['ticket_drafts', 'ticket_comments', 'ticket_links', 'time_entries', 'ticket_parts', 'ticket_alert_links',
      'ticket_attachments', 'ticket_email_links', 'ticket_checklist_items', 'ticket_external_refs'],
    lock: 'mover',
    tombstoneGuard: false,
    dynamicTables: true,
    reason:
      'Org movers carry merged tombstones (spec §3.9): called by moveTicketOrg and the device mover after the '
      + 'survivor(s) and their children are re-stamped; locks the tombstones in one ascending batch, then the '
      + 'ticket-axis per-ticket routine. A tombstone is read-only (every writer refuses it under its lock without '
      + 'touching a child) and merge serializes with both movers on the per-org links lock, so it cannot cycle.',
  },
  'services/ticketMerge/repoint.ts::repointTicketLinks': {
    tables: ['ticket_links'],
    lock: 'mover',
    tombstoneGuard: false,
    reason:
      'Ticket merge link re-point: the ticket_links slot of the canonical order, under mergeInTx\'s exclusive '
      + 'per-org links lock and ticket locks; drops what would break a link rule.',
  },

  // ── Cascades (erasure) ──────────────────────────────────────────────────
  'services/tenantCascade.ts::deleteOrgRows': {
    tables: ['ticket_comments', 'ticket_attachments', 'time_entries', 'ticket_parts', 'ticket_checklist_items',
      'ticket_alert_links', 'ticket_email_links', 'ticket_external_refs', 'ticket_links', 'ticket_drafts'],
    lock: 'cascade',
    tombstoneGuard: false,
    dynamicTables: true,
    reason:
      'Org erasure deletes each table in its OWN system-context transaction (cascadeDeleteOrg), so it never holds '
      + 'two of these locks at once and cannot form a cycle (ticketOrgMoveLockOrder.ts SCOPE note).',
  },
  'services/tenantCascade.ts::cascadeDeletePartner': {
    tables: ['ticket_comments', 'ticket_attachments', 'time_entries', 'ticket_parts', 'ticket_checklist_items',
      'ticket_alert_links', 'ticket_email_links', 'ticket_external_refs', 'ticket_links', 'ticket_drafts'],
    lock: 'cascade',
    tombstoneGuard: false,
    dynamicTables: true,
    reason:
      'Partner purge sweep: one table per system-context transaction, after every org of the partner is erased; '
      + 'never holds two of these locks at once.',
  },

  // ── Maintenance ─────────────────────────────────────────────────────────
  'jobs/ticketAttachmentReaper.ts::reapPendingAttachments': {
    tables: ['ticket_attachments'],
    lock: 'maintenance',
    tombstoneGuard: false,
    reason:
      'Reaper: deletes never-claimed staging uploads (comment_id IS NULL, past their TTL) with FOR UPDATE SKIP LOCKED '
      + 'in one statement; it takes no ticket lock and never waits on a row another writer holds.',
  },
};
