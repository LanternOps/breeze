/**
 * Tool Catalog W06 (#5221) Task B4 — reverting a switched conversion (plan
 * Decision 7): the Job goes back to the legacy engine and the converted flow
 * stops ADMITTING, while what it already admitted keeps its EXECUTION
 * authority.
 *
 * ONE transaction, the caller's (a savepoint of the request transaction), as
 * the interactive user, with the switch's permission rules (automations.write
 * + MFA + an interactive session at the route; canManagePartnerWidePolicies
 * for a partner-wide Job; a site-limited token or membership is refused):
 *
 *  1. Locks in the order every writer of these rows uses (switch.ts): the Job
 *     `FOR UPDATE`, then the flow, then the ledger row; re-reads all three.
 *  2. The ledger becomes `reverted` with `revert_at = now()` (the immutability
 *     trigger admits only switched → reverted; switch_at stays).
 *  3. The Job is re-enabled exactly as the switch found it: `enabled = true`,
 *     `retired_at` / `retired_reason` / `converted_to_flow_id` NULL. The Job
 *     could not be edited while switched, so its source is the converted one.
 *
 * The flow is NOT disabled and nothing is cancelled. From the commit on,
 * `flowPrefers` is false for its generation, so createFlowRun admits nothing
 * new (occurrence-carrying runs: `not_enabled`; every other run:
 * `flow_conversion_reverted`), and B2's legacy loader treats the Job as an
 * ordinary enabled row. Runs and intents already admitted, parked or approved
 * finish on the pinned publication. The reconciler disables the flow once the
 * generation is older than LEGACY_DRAIN_MIN_MS and the flow has drained
 * (jobs/flowRunReconciler.ts, clause f).
 *
 * The audit (`flow.conversion.reverted`) is written only after the request
 * transaction commits.
 */
import { and, eq } from 'drizzle-orm';
import type { FlowConversionDto } from '@breeze/shared';
import { db, runAfterDbContextCommit, withDbTransaction } from '../../../db';
import { automations, flowAutomationConversions, flows, type FlowAutomationConversionRow } from '../../../db/schema';
import { isInteractiveUserSession, type AuthContext } from '../../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../../auditEvents';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { getUserPermissions } from '../../permissions';
import { captureException } from '../../sentry';
import { hasSiteCeiling } from '../../siteCeilingAccess';
import { ownerForFlowRow } from '../repository';
import { ceilingAllowsDelegation, permissionContextFor } from '../versions';
import { automationSourceDigest } from './convertAutomation';
import { conversionReachCondition, readReachableAutomation, toConversionDto } from './service';

/**
 * Whether revert is closed on this installation. PR E (R3, roadmap #10336)
 * sets it from the retirement census; in W06 revert is always open.
 */
export const REVERT_CLOSED = false;

export type RevertConversionResult =
  | { ok: true; conversion: FlowConversionDto }
  | {
      ok: false;
      error: 'conversion_not_found' | 'interactive_session_required' | 'partner_wide_forbidden' | 'delegation_scope_restricted'
        | 'not_switched' | 'revert_closed';
    };

type RevertRefusal = Extract<RevertConversionResult, { ok: false }>;

/** Unwinds the revert's savepoint with a refusal. */
class RevertRefused extends Error {
  constructor(readonly result: RevertRefusal) {
    super(result.error);
  }
}
const refuse = (result: RevertRefusal): never => {
  throw new RevertRefused(result);
};

function auditReverted(
  auth: AuthContext,
  conversion: FlowAutomationConversionRow,
  job: { id: string; name: string; orgId: string | null; partnerId: string | null },
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: job.orgId,
      ...(job.orgId ? {} : { partnerId: job.partnerId }),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'flow.conversion.reverted',
      resourceType: 'flow_automation_conversion',
      resourceId: conversion.id,
      resourceName: job.name,
      result: 'success',
      details: {
        automationId: job.id,
        flowId: conversion.flowId,
        ownerScope: job.orgId ? 'organization' : 'partner',
        switchAt: conversion.switchAt ? new Date(conversion.switchAt).toISOString() : null,
        revertAt: conversion.revertAt ? new Date(conversion.revertAt).toISOString() : null,
      },
    });
  } catch (err) {
    console.error('[flows] conversion revert audit write failed', err);
    captureException(
      err,
      undefined,
      { ...(job.orgId ? { org_id: job.orgId } : {}), flow_site: 'conversion.revert_audit' },
      { fingerprint: ['flow', 'conversion.revert_audit'] },
    );
  }
}

export async function revertConversion(auth: AuthContext, conversionId: string): Promise<RevertConversionResult> {
  if (!isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_session_required' };
  if (REVERT_CLOSED) return { ok: false, error: 'revert_closed' };
  // As the switch: a site-limited token never moves a Job between engines.
  if (hasSiteCeiling(auth)) return { ok: false, error: 'delegation_scope_restricted' };

  // ── unlocked pre-reads: visibility, the owner, the caller's membership ────
  const reach = conversionReachCondition(auth);
  const byId = eq(flowAutomationConversions.id, conversionId);
  const [pre] = await db.select().from(flowAutomationConversions).where(reach ? and(byId, reach) : byId).limit(1);
  if (!pre) return { ok: false, error: 'conversion_not_found' };
  const preJob = await readReachableAutomation(auth, pre.automationId, false);
  if (!preJob) return { ok: false, error: 'conversion_not_found' };
  if (!preJob.orgId && !canManagePartnerWidePolicies(auth)) return { ok: false, error: 'partner_wide_forbidden' };
  if (pre.state !== 'switched') return { ok: false, error: 'not_switched' };
  const [preFlow] = await db.select().from(flows).where(eq(flows.id, pre.flowId)).limit(1);
  if (!preFlow) return { ok: false, error: 'conversion_not_found' };
  const owner = await ownerForFlowRow(preFlow);
  if (!owner) return { ok: false, error: 'conversion_not_found' };
  const perms = await getUserPermissions(auth.user.id, permissionContextFor(owner));
  if (!ceilingAllowsDelegation(perms, owner) || (!owner.orgId && auth.partnerOrgAccess !== 'all')) {
    return { ok: false, error: 'delegation_scope_restricted' };
  }

  try {
    const outcome = await withDbTransaction(async () => {
      // Job → flow → ledger, each re-read under its lock (switch.ts's order).
      const job = await readReachableAutomation(auth, pre.automationId, true);
      if (!job) return refuse({ ok: false, error: 'conversion_not_found' });
      const [flow] = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, pre.flowId)).for('update').limit(1);
      if (!flow) return refuse({ ok: false, error: 'conversion_not_found' });
      const [ledger] = await db.select().from(flowAutomationConversions).where(byId).for('update').limit(1);
      if (!ledger) return refuse({ ok: false, error: 'conversion_not_found' });
      if (ledger.state !== 'switched') return refuse({ ok: false, error: 'not_switched' });

      const revertedAt = new Date();
      const [reverted] = await db
        .update(flowAutomationConversions)
        .set({ state: 'reverted', revertAt: revertedAt, revertedBy: auth.user.id, updatedAt: revertedAt })
        .where(and(byId, eq(flowAutomationConversions.state, 'switched')))
        .returning();
      if (!reverted) throw new Error('flow conversion moved under the revert lock');
      // Only the row this generation retired (the switch's exact shape).
      const [restored] = await db
        .update(automations)
        .set({ enabled: true, retiredAt: null, retiredReason: null, convertedToFlowId: null, updatedAt: revertedAt })
        .where(and(eq(automations.id, job.id), eq(automations.convertedToFlowId, ledger.flowId)))
        .returning({ id: automations.id });
      if (!restored) throw new Error('the switched automation is not retired to this flow');
      return { conversion: reverted, liveDigest: automationSourceDigest(job) };
    });

    runAfterDbContextCommit('flows.conversion.revert_audit', () => auditReverted(auth, outcome.conversion, preJob));
    return { ok: true, conversion: toConversionDto(outcome.conversion, outcome.liveDigest) };
  } catch (err) {
    if (err instanceof RevertRefused) return err.result;
    throw err;
  }
}
