import {
  SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS,
  type M365SyncAction,
  type M365SyncActionResponse,
} from '@breeze/shared/m365';
import { GraphClientError, type GraphSyncPageSet } from './graphClient';

/**
 * #5784 W05. The paged /auditLogs/signIns reader.
 *
 * Deliberately NOT a widening of the interactive `m365.signins.list` action:
 * that one is capped at sinceHours ≤ 168 over at most two pages (100 rows, no
 * continuation) and stays exactly that way. A monthly identity review needs 30
 * days and a quarterly one 90, so pagination and a per-run item budget belong
 * in a sync action, not in a technician-facing read.
 *
 * Interactive sign-ins only: `signInEventTypes/any(t: t eq 'interactiveUser')`.
 * Non-interactive, service-principal and managed-identity sign-ins are out of
 * the first cut.
 *
 * Ordered by createdDateTime ASCENDING so a continuation resumes
 * deterministically, and bounded by a half-open [since, until) window so two
 * adjacent runs cannot both claim an event on the boundary.
 *
 * Its own token bucket (`signinEventsLimiter`), NOT signinLimiter's:
 * /users?$select=signInActivity is a different Graph surface with a different
 * app-wide limit, and sharing one bucket would starve both. `tryTake` never
 * blocks — an empty bucket ends the walk with a continuation.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const SIGNIN_EVENTS_PATH = '/auditLogs/signIns';

/** Graph's own event-type discriminator for a human, interactive sign-in. */
export const SIGNIN_EVENTS_INTERACTIVE_FILTER = "signInEventTypes/any(t: t eq 'interactiveUser')";

export interface SigninEventsWindow {
  since: string;
  until: string;
}

/**
 * The window actually queried. A call with no window is still BOUNDED — the
 * cold-start pull — rather than an unfiltered tenant-wide scan.
 */
export function resolveSigninEventsWindow(
  action: Extract<M365SyncAction, { type: 'm365.sync.signin_events' }>,
  fetchedAt: Date,
): SigninEventsWindow {
  const until = action.until ?? fetchedAt.toISOString();
  const since = action.since
    ?? new Date(Date.parse(until) - SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS * MS_PER_DAY).toISOString();
  return { since, until };
}

export function signinEventsFilter(window: SigninEventsWindow): string {
  // Both bounds are ISO instants produced by Zod's `.datetime()` validation on
  // the way in (or by toISOString here), so there is nothing quote-shaped to
  // escape — Graph takes bare timestamps in $filter.
  return [
    `createdDateTime ge ${window.since}`,
    `createdDateTime lt ${window.until}`,
    SIGNIN_EVENTS_INTERACTIVE_FILTER,
  ].join(' and ');
}

/**
 * A 403 on this endpoint means the tenant has no Entra ID P1 — the same
 * "complete, zero-item success" signin_activity already reports for its own
 * sibling, not a failure to retry.
 */
export function isUnlicensedSigninEventsError(error: unknown): boolean {
  return error instanceof GraphClientError
    && (error.code === 'graph_permission_missing' || error.code === 'graph_license_required');
}

/** `truncated` is the item cap specifically; a page cap is paging, not loss. */
export function signinEventsTruncated(pageSet: GraphSyncPageSet): boolean {
  return pageSet.stopReason === 'max_items';
}

export type SigninEventsResponse = M365SyncActionResponse;
