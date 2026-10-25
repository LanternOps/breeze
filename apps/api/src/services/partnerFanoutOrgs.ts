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

/** The live-org predicate over `organizations` (no partner axis). */
export function partnerFanoutOrgCondition(): SQL {
  return and(
    ne(organizations.type, 'quick_support'),
    notHoldingOrgCondition(),
    isNull(organizations.deletedAt),
    inArray(organizations.status, [...PARTNER_FANOUT_ORG_STATUSES]),
  )!;
}
