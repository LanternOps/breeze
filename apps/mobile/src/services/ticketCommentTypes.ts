/**
 * The ticket-comment kind vocabulary, split out as a leaf module.
 *
 * **This module imports nothing — not react-native, not `./api` — and must stay
 * that way.** Its sibling `tickets.ts` imports `coreRequest` from `./api`, which
 * transitively loads `expo-secure-store` and `react-native`'s Flow-typed source;
 * Vitest cannot parse that, which is why `tickets.test.ts` has to `vi.mock('./api')`
 * before it can touch a single constant. Screens' pure copy/logic modules
 * (`screens/tickets/ticketCopy.ts`) must be node-testable WITHOUT that mock, so
 * they need a value import that costs them no module graph. Same reasoning, and
 * the same shape, as `ticketAttachmentContract.ts`.
 *
 * Before this split the set was duplicated into `ticketCopy.ts` with a
 * "keep in sync" comment. That is precisely the kind of drift that silently
 * reintroduces a fixed bug: `TicketDetailScreen` decides whether a row IS a
 * system entry from this set, while the visibility predicate used its copy, so
 * a fifth kind added here would render as a system row but be classified as a
 * person comment — resurrecting the blank-activity-row and the miscounted
 * ACTIVITY header. One definition, imported by both, makes that unrepresentable.
 */

export type TicketCommentType =
  | 'comment'
  | 'internal'
  | 'status_change'
  | 'assignment'
  | 'time_entry'
  | 'system';

/** Entry kinds the API emits as activity rather than a person's comment. */
export const SYSTEM_COMMENT_TYPES: ReadonlySet<TicketCommentType> = new Set([
  'status_change',
  'assignment',
  'time_entry',
  'system',
]);
