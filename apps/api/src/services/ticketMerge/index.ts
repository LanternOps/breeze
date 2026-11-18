/**
 * Ticket merge (#8972). A merged source stays as a read-only tombstone that
 * points at its survivor (one hop); its children move to the survivor.
 * See execute.ts for the transaction, repoint.ts for what moves, eligibility.ts
 * for the refusals, preview.ts for the read-only dry run.
 */
export {
  mergeTickets,
  requestersDiffer,
  requesterKey,
  displayTicketNumber,
  type MergeTicketsInput,
  type MergeTicketsResult,
} from './execute';
export {
  checkMergeEligibility,
  assertMergeEligible,
  loadMergeTicketRows,
  type MergeEligibilityContext,
  type MergeTicketRow,
} from './eligibility';
export {
  MERGED_TABLES,
  type DroppedLink,
  type DroppedLinkReason,
  type MergeCounts,
  type MergedTable,
} from './repoint';
export {
  TicketMergedError,
  MergeRefusedError,
  assertTicketNotMerged,
  isMergedTombstone,
  TICKET_MERGED_CODE,
  type MergeRefusal,
  type MergeRefusalCode,
} from './errors';
