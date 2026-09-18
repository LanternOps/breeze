/**
 * AI Scorecard W04 (#5761, refs #4182) — authorization and orchestration for the
 * MEASURED impact band on `/ai-agents/impact`.
 *
 * ## The band's authorization is a NEW decision, not an inheritance
 *
 * `GET /ai/agents/impact` requires `ai_agents:read`. That is the gate to *enter*
 * the page; it is NOT a licence to publish everything the measured band could
 * compute. Three extra rules are enforced here as **omissions**, never as 403s —
 * a partner admin should see two of three signals, not an error page:
 *
 * 1. **Site scope must be unrestricted.** Existing impact filtering is purely
 *    organizational, but run visibility treats site authority as an additional
 *    boundary (`services/aiAgentRunSiteScope.ts`). Rather than invent scoped
 *    aggregation under time pressure, the first release omits the whole measured
 *    band for a site-restricted caller (`site_restricted`).
 * 2. **Technician minutes need the time-entry permission AND partner scope.**
 *    `time_entries` deliberately requires partner or system scope plus a
 *    `time_entries` permission (`routes/timeEntries/timeEntries.ts`), and an
 *    ordinary standalone read is limited to the caller's own entries. Publishing
 *    org-wide labour comparisons on the impact page is therefore a new decision.
 *    A caller who lacks either gets `insufficient_authority` on **that arm
 *    alone**; the other two signals still render.
 * 3. **Never reach for a system context to get around (2).**
 *    `runOutsideDbContext(() => withSystemDbAccessContext(...))` here would
 *    bypass RLS entirely — exactly the anti-pattern that shipped a cross-tenant
 *    hole in #2417 — and would double-hold a pooled connection under the
 *    request's own transaction. The correct answer to "the caller cannot see
 *    time entries" is to omit the arm. A test in `impactMeasured.test.ts` reads
 *    this file and fails if either symbol ever appears.
 *
 * The band is **correlational**: AI-touched versus untouched work of the same
 * kind, in the same window. It is never a before/after comparison and never a
 * causal claim.
 */

import {
  AI_AGENT_IMPACT_WINDOWS,
  type AiAgentImpactMeasuredDto,
  type AiAgentImpactWindow,
  type MeasuredOmissionReason,
  type MeasuredSignal,
  type MeasuredTechnicianMinutes,
} from '@breeze/shared';

import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../permissions';
import { lastCompleteUtcDay, shiftUtcDay } from './impactRollup';
import {
  loadAlertResolutionSignal,
  loadTechnicianMinutes,
  loadTicketFirstResponseSignal,
  type MeasuredWindow,
} from './impactMeasuredSignals';
import {
  ALERT_EXPOSURE_AGE_MINUTES,
  ALERT_OUTCOME_HORIZON_HOURS,
  TICKET_EXPOSURE_AGE_MINUTES,
  TICKET_RESPONSE_HORIZON_HOURS,
} from '@breeze/shared';

export class MeasuredImpactOrgAccessDeniedError extends Error {
  constructor() {
    super('Access to this organization denied');
    this.name = 'MeasuredImpactOrgAccessDeniedError';
  }
}

export interface MeasuredImpactInput {
  window: AiAgentImpactWindow;
  orgId?: string;
}

const omittedSignal = (
  reason: MeasuredOmissionReason,
  exposureAgeMinutes: number,
  horizonHours: number,
): MeasuredSignal => ({ cohorts: [], omitted: reason, exposureAgeMinutes, horizonHours });

/**
 * Whether this caller may be shown org-wide recorded-labour comparisons.
 *
 * Both halves are required. The permission alone is not enough: an org-scope
 * context cannot read the partner-axis `time_entries` table anyway, so claiming
 * otherwise would produce a silently-empty arm indistinguishable from "no labour
 * was logged".
 */
function canReadTechnicianMinutes(auth: AuthContext, permissions: UserPermissions | undefined): boolean {
  // Fails CLOSED on an unresolved permission set: an arm whose authority we
  // could not establish is omitted, never published.
  if (permissions === undefined) return false;
  if (auth.scope !== 'partner' && auth.scope !== 'system') return false;
  return hasPermission(
    permissions,
    PERMISSIONS.TIME_ENTRIES_READ.resource,
    PERMISSIONS.TIME_ENTRIES_READ.action,
  );
}

/**
 * Assemble the measured DTO. Runs under the CALLER's request DB context; each
 * loader additionally carries `auth.orgCondition(...)` on top of RLS.
 */
export async function loadMeasuredImpact(
  auth: AuthContext,
  permissions: UserPermissions | undefined,
  input: MeasuredImpactInput,
): Promise<AiAgentImpactMeasuredDto> {
  if (!AI_AGENT_IMPACT_WINDOWS.includes(input.window)) {
    // The route's Zod schema is the primary gate; this is the defensive second
    // one so a future non-route caller cannot widen past the 90-day cap.
    throw new Error(`loadMeasuredImpact: unsupported window ${String(input.window)}`);
  }

  if (input.orgId !== undefined) {
    if (!auth.canAccessOrg(input.orgId)) throw new MeasuredImpactOrgAccessDeniedError();
  } else if (auth.scope === 'system') {
    throw new Error(
      'loadMeasuredImpact: a system-scoped query requires input.orgId (the route enforces this as a 400 before calling in)',
    );
  }

  const through = lastCompleteUtcDay();
  const from = shiftUtcDay(through, -(input.window - 1));

  const siteRestricted = auth.allowedSiteIds !== undefined;
  if (siteRestricted) {
    // Whole band, not just one signal: every cohort here aggregates across a
    // whole org, and there is no honest way to present an org-wide comparison to
    // a caller who may only see part of that org.
    return {
      schemaVersion: 1,
      window: input.window,
      from,
      through,
      alertResolution: omittedSignal('site_restricted', ALERT_EXPOSURE_AGE_MINUTES, ALERT_OUTCOME_HORIZON_HOURS),
      ticketFirstResponse: omittedSignal('site_restricted', TICKET_EXPOSURE_AGE_MINUTES, TICKET_RESPONSE_HORIZON_HOURS),
      technicianMinutes: { omitted: 'site_restricted' },
    };
  }

  const orgIds: readonly string[] = input.orgId !== undefined
    ? [input.orgId]
    : (auth.accessibleOrgIds ?? []);
  const window: MeasuredWindow = { orgIds, from, through, windowDays: input.window };

  const technicianAuthorized = canReadTechnicianMinutes(auth, permissions);

  const [alertResolution, ticketFirstResponse, technicianRaw] = await Promise.all([
    loadAlertResolutionSignal(auth, window),
    loadTicketFirstResponseSignal(auth, window),
    technicianAuthorized ? loadTechnicianMinutes(auth, window) : Promise.resolve(null),
  ]);

  // An empty cohort list is not "nothing to omit" -- it's the same
  // not-enough-comparable-work story the other two signals tell explicitly
  // (#5879). Reporting `omitted: null` here left the band rendering a heading
  // plus "0% logged" over zero rows, which reads as data rather than as absence.
  const technicianMinutes: MeasuredTechnicianMinutes = technicianRaw === null
    ? { omitted: 'insufficient_authority' }
    : technicianRaw.cohorts.length === 0
      ? { omitted: 'insufficient_data' }
      : {
          omitted: null,
          cohorts: technicianRaw.cohorts,
          loggingCoverage: technicianRaw.loggingCoverage,
        };

  return {
    schemaVersion: 1,
    window: input.window,
    from,
    through,
    alertResolution,
    ticketFirstResponse,
    technicianMinutes,
  };
}
