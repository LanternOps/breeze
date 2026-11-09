/**
 * #10406 (spec §3 Option C) — the `assessment` specialist: Wisp's own
 * assessment, started from chat (`launch_specialist {kind: 'assessment'}`).
 * Reached only through the coordinator (chat-only: `chatOnly` in the policy
 * table), like every launcher in ../specialistLaunchers.ts, which registers
 * it. It admits nothing itself: it asks the wake coordinator for one
 * on-demand assessment per org (wake.ts `requestAssessment`), and each run's
 * own admission (assessment.ts `enqueueAssessment`) is the real gate and meter.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { organizations } from '../../../db/schema/orgs';
import { captureException } from '../../sentry';
import { assessableOrgIds, ONBOARDING_ORG_LIMIT } from '../assessableOrgs';
import { orgsWithOpenAlerts } from '../openAlertOrgs';
import { chargeableUnderGrant } from '../budget';
import { CeilingViolationError, assertWithinCeiling } from '../grantAuthority';
import { SPECIALIST_KIND_POLICY } from '../specialistPolicy';
import type { LaunchContext, LaunchResult } from '../specialistLaunchers';
import { requestAssessment, type RequestAssessmentResult } from '../wake';

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * #10406: `org` assesses the anchor org; `orgs_with_open_alerts` expands to up
 * to ONBOARDING_ORG_LIMIT assessable ceiling orgs with open alerts, most
 * severe first (launchAssessment).
 */
export const assessmentParamsSchema = z.strictObject({
  scope: z.enum(['org', 'orgs_with_open_alerts']).default('org'),
});

/**
 * #10406 — what an on-demand assessment request did, per org, in the order
 * the orgs were expanded. `queued` / `upgraded` / `coalesced` are the wake
 * coordinator's answers; a `skipped` row always says why (it never reached
 * the coordinator, or its queue failed).
 */
export type AssessmentOrgOutcome = { orgId: string; orgName: string | null } & (
  | { outcome: RequestAssessmentResult }
  | { outcome: 'skipped'; reason: 'not_assessable' | 'permission' | 'queue_failed' }
);
export type AssessmentLaunchReport = { orgs: AssessmentOrgOutcome[] };

/** Tenant-controlled org names in a tool result: one line, bounded (the approval card's rule). */
function oneLineName(name: string | null | undefined): string | null {
  const flat = name?.replace(/\s+/g, ' ').trim() ?? '';
  if (!flat) return null;
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** "Queued Wisp assessments for 3 orgs (A, B, C); 1 already queued (D). Results land in this thread." */
export function assessmentLaunchMessage(report: AssessmentLaunchReport): string {
  const names = (rows: AssessmentOrgOutcome[]) => rows.map((o) => o.orgName ?? 'an unnamed organization').join(', ');
  const started = report.orgs.filter((o) => o.outcome === 'queued' || o.outcome === 'upgraded');
  const already = report.orgs.filter((o) => o.outcome === 'coalesced');
  const failed = report.orgs.filter((o) => o.outcome === 'skipped' && o.reason === 'queue_failed');
  const skipped = report.orgs.filter((o) => o.outcome === 'skipped' && o.reason !== 'queue_failed');
  const parts: string[] = [];
  if (started.length === 1) parts.push(`Queued a Wisp assessment for ${names(started)}`);
  else if (started.length > 1) parts.push(`Queued Wisp assessments for ${started.length} orgs (${names(started)})`);
  if (already.length > 0) parts.push(`${already.length} already queued (${names(already)})`);
  if (failed.length > 0) parts.push(`${failed.length} could not be queued (${names(failed)})`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped, not covered by this grant or your access (${names(skipped)})`);
  return `${parts.join('; ')}. Results land in this thread.`;
}

/**
 * #10406 (spec §3 Option C) — Wisp's own assessment, started from chat. The
 * coordinator already gated the anchor org (`ctx.orgId`) and the person.
 *
 *  - Every org is gated here as well: assessable (no site restriction), each
 *    required permission inside the ceiling in that org's terms, and
 *    reachable by the person asking (quorum: per-org permission re-checks).
 *    The person's own permission keys are user-level, checked once by the
 *    coordinator; their per-org reach is `canAccessOrg`.
 *  - scope `org` covers the anchor org; a gate failure is a `skipped` row and
 *    `admission_skipped` / `no_assessable_orgs`.
 *  - `orgs_with_open_alerts` gates the ceiling orgs BEFORE the alerts read,
 *    so an org outside the grant or the person's reach is never read, never
 *    named in the result and never uses up the limit; it then covers up to
 *    ONBOARDING_ORG_LIMIT of them with open alerts, worst first. Zero →
 *    `admission_skipped` / `no_open_alerts`.
 *  - The grant budget is pre-checked at N x the per-run estimate (it reserves
 *    nothing; each run's own admission is the real meter).
 *  - Then one on-demand `requestAssessment` per org. Results land in the
 *    grant's thread as any assessment's do. One org's queue failure is
 *    reported and captured, and does not stop the others.
 */
export async function launchAssessment(ctx: LaunchContext): Promise<LaunchResult> {
  const { scope } = assessmentParamsSchema.parse(ctx.params);
  const permissions = SPECIALIST_KIND_POLICY.assessment.requiredPermissions;
  const assessable = assessableOrgIds(ctx.ceiling);
  const gate = (orgId: string): 'not_assessable' | 'permission' | null =>
    !assessable.has(orgId) ? 'not_assessable' : orgPassesGates(ctx, orgId, permissions) ? null : 'permission';

  const eligible: Array<{ orgId: string; orgName: string | null }> = [];
  const skipped: AssessmentOrgOutcome[] = [];
  if (scope === 'org') {
    const [org] = await systemRead(() => db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId))
      .limit(1));
    const target = { orgId: ctx.orgId, orgName: oneLineName(org?.name) };
    const reason = gate(ctx.orgId);
    if (reason) skipped.push({ ...target, outcome: 'skipped', reason });
    else eligible.push(target);
  } else {
    const reachable = [...assessable].filter((orgId) => gate(orgId) === null);
    const withAlerts = await orgsWithOpenAlerts(reachable, ONBOARDING_ORG_LIMIT);
    if (withAlerts.length === 0) return { refused: 'admission_skipped', detail: 'no_open_alerts' };
    for (const o of withAlerts) eligible.push({ orgId: o.orgId, orgName: oneLineName(o.orgName) });
  }
  if (eligible.length === 0) return { refused: 'admission_skipped', detail: 'no_assessable_orgs', report: { orgs: skipped } };

  const budget = await chargeableUnderGrant(ctx.grant.grantId, eligible.length * SPECIALIST_KIND_POLICY.assessment.estimateCents);
  if (!budget.ok) return { refused: 'budget_exhausted' };

  const orgs: AssessmentOrgOutcome[] = [];
  for (const target of eligible) {
    try {
      const outcome = await requestAssessment({
        grantId: ctx.grant.grantId,
        orgId: target.orgId,
        reason: { kind: 'on_demand', requestId: ctx.requestId },
      });
      orgs.push({ ...target, outcome });
    } catch (err) {
      // One org's queue failure must not hide the others' outcomes; it is
      // reported to the person and to Sentry.
      orgs.push({ ...target, outcome: 'skipped', reason: 'queue_failed' });
      console.error('[wisp.assessmentLaunch] on-demand assessment could not be queued', { orgId: target.orgId, requestId: ctx.requestId, err });
      captureException(err, undefined, {
        component: 'wisp',
        op: 'wisp.assessment.onDemandRequest',
        grantId: ctx.grant.grantId,
        orgId: target.orgId,
        requestId: ctx.requestId,
      });
    }
  }
  const report: AssessmentLaunchReport = { orgs };
  if (orgs.every((o) => o.outcome === 'skipped')) {
    return { refused: 'admission_skipped', detail: 'queue_unavailable', report };
  }
  return { admitted: true, report, message: assessmentLaunchMessage(report) };
}

/** The kind's permissions inside the ceiling in this org's terms, and the person can reach the org. */
function orgPassesGates(ctx: LaunchContext, orgId: string, permissions: readonly string[]): boolean {
  if (ctx.actorAuth && !ctx.actorAuth.canAccessOrg(orgId)) return false;
  for (const permission of permissions) {
    try {
      assertWithinCeiling(ctx.ceiling, { orgId, permission });
    } catch (err) {
      if (err instanceof CeilingViolationError) return false;
      throw err;
    }
  }
  return true;
}
