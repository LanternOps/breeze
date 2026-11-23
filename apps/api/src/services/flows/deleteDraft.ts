/**
 * Flows completion W01b (#12435): delete a never-published draft
 * (DELETE /flows/:id).
 *
 * Every child table cascades from `flows` (publications, runs, webhook
 * deliveries, usage counters, the conversion ledger), so a delete is offered
 * only for a flow with nothing to lose: status `draft`, never published, never
 * converted, never run. Anything else is `flow_has_history`, and the answer is
 * disable.
 *
 * All in the caller's transaction and RLS context:
 *  1. `SELECT … FOR UPDATE`. Under RLS it matches only a row the caller may
 *     update, and it serializes against enable, which takes the same lock
 *     (versions.ts enableFlow): a delete queued behind an enable sees its
 *     commit and answers `flow_has_history`.
 *  2. The partner-wide reach rule: an org token on a partner-wide row is
 *     `flow_not_found` (never 403, so writability is not disclosed).
 *  3. `canManagePartnerWidePolicies` for a partner-wide row.
 *  4. `expectedVersion`, then the history checks, then a DELETE whose WHERE
 *     repeats the status, version and publication guards.
 *  5. Audit `flow.draft.delete`, never the definition.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { flowAutomationConversions, flowRuns, flows, flowVersions, type FlowRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { captureException } from '../sentry';
import { partnerWideReach } from './versions';

export type DeleteDraftFlowResult =
  | { ok: true }
  | { ok: false; error: 'flow_not_found' | 'partner_wide_forbidden' | 'version_conflict' }
  | { ok: false; error: 'flow_has_history'; conversionId?: string; automationId?: string };

export async function deleteDraftFlow(auth: AuthContext, flowId: string, expectedVersion: number): Promise<DeleteDraftFlowResult> {
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).for('update').limit(1);
  if (!row) return { ok: false, error: 'flow_not_found' };
  if (partnerWideReach(row, auth) === 'not_found') return { ok: false, error: 'flow_not_found' };
  // Named here as well as in partnerWideReach: this file deletes from a
  // partner-axis table (partner-wide-write-coverage.test.ts).
  if (!row.orgId && !canManagePartnerWidePolicies(auth)) return { ok: false, error: 'partner_wide_forbidden' };
  if (row.definitionVersion !== expectedVersion) return { ok: false, error: 'version_conflict' };

  if (row.status !== 'draft' || row.enabledPublicationSeq !== null) return { ok: false, error: 'flow_has_history' };
  const [publications] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId));
  if (Number(publications?.n ?? 0) > 0) return { ok: false, error: 'flow_has_history' };
  // A conversion of any state (shadow, switched, reverted): the web links /jobs#convert-<automationId>.
  const [conversion] = await db
    .select({ id: flowAutomationConversions.id, automationId: flowAutomationConversions.automationId })
    .from(flowAutomationConversions)
    .where(eq(flowAutomationConversions.flowId, flowId))
    .orderBy(desc(flowAutomationConversions.createdAt))
    .limit(1);
  if (conversion) return { ok: false, error: 'flow_has_history', conversionId: conversion.id, automationId: conversion.automationId };
  const [runs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flowRuns)
    .where(eq(flowRuns.flowId, flowId));
  if (Number(runs?.n ?? 0) > 0) return { ok: false, error: 'flow_has_history' };

  const deleted = await db
    .delete(flows)
    .where(and(
      eq(flows.id, flowId),
      eq(flows.status, 'draft'),
      eq(flows.definitionVersion, expectedVersion),
      isNull(flows.enabledPublicationSeq),
    ))
    .returning({ id: flows.id });
  // Unreachable while the lock is held; never report a delete that did not happen.
  if (deleted.length !== 1) return { ok: false, error: 'flow_not_found' };

  auditDraftDelete(auth, row);
  return { ok: true };
}

function auditDraftDelete(auth: AuthContext, row: FlowRow): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      ...(row.orgId ? {} : { partnerId: row.partnerId }),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'flow.draft.delete',
      resourceType: 'flow',
      resourceId: row.id,
      resourceName: row.name,
      result: 'success',
      // Never the definition: it can carry ids and free text.
      details: {
        definitionVersion: row.definitionVersion,
        ownerScope: row.orgId ? 'organization' : 'partner',
      },
    });
  } catch (err) {
    console.error('[flows] audit write failed', err);
    captureException(
      err,
      undefined,
      { ...(row.orgId ? { org_id: row.orgId } : {}), flow_id: row.id, flow_site: 'service.draft_delete_audit' },
      { fingerprint: ['flow', 'service.draft_delete_audit'] },
    );
  }
}
