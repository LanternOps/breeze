/**
 * The ONE definition of "an org a partner-wide automation may act in":
 * the partner's live customer/internal tenants. Shared by the AI-agent sweep
 * fan-out (jobs/aiAgentSweepScheduler.ts `loadPartnerOrgIds`, which partner-
 * wide flow schedules also use) and the partner-wide branch of the flow event
 * trigger (services/flows/eventTrigger.ts), so an org a schedule would skip
 * can never start a partner-wide run through an event either.
 *
 * Excluded:
 *  - `quick_support` — the partner's hidden holder for ephemeral support
 *    enrolments, which no partner-wide automation may touch;
 *  - the holding (`unassigned_pool`) org — devices not yet assigned;
 *  - soft-deleted orgs;
 *  - any status outside PARTNER_FANOUT_ORG_STATUSES.
 *
 * A leaf: drizzle + the organizations table + the holding-org predicate.
 * The partner predicate is the caller's (an `eq` on organizations.partner_id,
 * or the event's own org).
 *
 * Two layers (#5219 review): `liveOrgCondition()` — status active/trial and
 * not soft-deleted — is the liveness EVERY flow trigger applies to the org it
 * would run in, an org-owned flow's own org included (a suspended, churned or
 * deleted tenant's schedules and events stop with it). The org-TYPE
 * exclusions (quick_support, the holding org) apply only to partner-wide
 * fan-out: an org-owned flow was authored in that org on purpose and runs
 * only there, so its org type does not stop it.
 */
import { and, inArray, isNull, ne, type SQL } from 'drizzle-orm';
import { organizations } from '../db/schema/orgs';
import { notHoldingOrgCondition } from './unassignedPool/selectorPredicate';

/**
 * Statuses a partner-wide automation may run against — the SAME live-org
 * definition `middleware/auth.ts`'s partner-scope org resolution uses.
 * Everything else (`suspended`, `churned`, `offboarding`, `merging`,
 * `archived`, `purging`) is a tenant in a terminal or frozen lifecycle state;
 * `archived` is what an archived_at org carries.
 */
export const PARTNER_FANOUT_ORG_STATUSES = ['active', 'trial'] as const;

/** Liveness alone (status active/trial, not soft-deleted): every flow trigger's org gate. */
export function liveOrgCondition(): SQL {
  return and(
    isNull(organizations.deletedAt),
    inArray(organizations.status, [...PARTNER_FANOUT_ORG_STATUSES]),
  )!;
}

/** The partner-wide fan-out predicate over `organizations` (no partner axis): liveness plus the org-type exclusions. */
export function partnerFanoutOrgCondition(): SQL {
  return and(
    ne(organizations.type, 'quick_support'),
    notHoldingOrgCondition(),
    liveOrgCondition(),
  )!;
}
