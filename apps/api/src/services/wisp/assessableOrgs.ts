/**
 * Wisp W05b — which orgs of a grant ceiling an assessment may run in.
 * Pure, and kept out of assessment.ts so the wake coordinator (which must not
 * pull the run-admission graph into the event-subscriber closure) can use it.
 */
import type { GrantCeiling } from './grantAuthority';

/**
 * w00 A33: onboarding assesses at most this many orgs at once; the rest reach
 * the floor tick. Lives here (pure) so the chat seed (#10391) can state it
 * without importing the wake queue; wake.ts re-exports it.
 */
export const ONBOARDING_ORG_LIMIT = 10;

/**
 * The ceiling orgs an assessment may run in: those the grant reaches WHOLE.
 * The digest reads are org-wide (alerts, tickets, incidents, runs, intents of
 * the org), so an org the grantor reaches only through a site restriction —
 * ceiling-wide (`siteIds`) or from their membership (`orgTerms[org].siteIds`)
 * — is never assessed, the same rule W05a's concern reads apply. Exported for
 * the wake coordinator's candidate selection.
 */
export function assessableOrgIds(ceiling: GrantCeiling): Set<string> {
  if (ceiling.siteIds !== null) return new Set();
  return new Set([...ceiling.orgIds].filter((id) => (ceiling.orgTerms.get(id)?.siteIds ?? null) === null));
}
