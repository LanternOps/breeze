/**
 * Tool Catalog W06 (#5221) Task B1 — the small read and reset helpers of the
 * conversion ledger (`flow_automation_conversions`) that other modules call:
 * the automation read surfaces (routes/automations.ts, `breeze://automations`,
 * the Partner API export, `manage_automations`), the automation PUT/PATCH and
 * the flow draft save. Kept apart from service.ts so those callers do not load
 * the converter, the draft service or the context loader.
 *
 * Everything here runs in the CALLER's DB context: RLS decides which ledger
 * rows a read sees and which a reset can update. A reset is only ever issued
 * right after a write the caller was already authorized for (the automation
 * update or the draft update, both of which gate partner-wide rows on
 * canManagePartnerWidePolicies), and it writes only the shadow counters of
 * that same Job's or flow's own generation.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { FlowConversionState } from '@breeze/shared';
import { db } from '../../../db';
import { automations, flowAutomationConversions, flows } from '../../../db/schema';
import { canonicalizeArguments } from '../../actionIntents/canonicalize';
import { automationSourceDigest } from './convertAutomation';

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type AutomationRow = typeof automations.$inferSelect;
type SourceFields = Pick<AutomationRow, 'trigger' | 'conditions' | 'actions' | 'onFailure' | 'notificationTargets'>;

/** The additive `conversion` field of every automation read surface (plan Decision 9). */
export interface AutomationConversionSummary {
  id: string;
  state: FlowConversionState;
  flowId: string;
}

/**
 * The digest of a flow's draft document, as stored in the ledger's
 * `document_digest`. Computed over the SAVED definition (the validator's
 * normalised document), so a draft save and the switch compare like with like.
 */
export function flowDocumentDigest(definition: unknown): string {
  const doc = definition !== null && typeof definition === 'object' && !Array.isArray(definition)
    ? (definition as Record<string, unknown>)
    : {};
  return createHash('sha256').update(canonicalizeArguments(doc)).digest('hex');
}

/**
 * The newest generation of each automation (the live one when there is one —
 * a newer generation exists only after the previous was reverted), keyed by
 * automation id. Automations with no generation are absent.
 */
export async function conversionSummariesFor(automationIds: readonly string[]): Promise<Map<string, AutomationConversionSummary>> {
  const ids = [...new Set(automationIds)];
  const out = new Map<string, AutomationConversionSummary>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectDistinctOn([flowAutomationConversions.automationId], {
      automationId: flowAutomationConversions.automationId,
      id: flowAutomationConversions.id,
      state: flowAutomationConversions.state,
      flowId: flowAutomationConversions.flowId,
    })
    .from(flowAutomationConversions)
    .where(inArray(flowAutomationConversions.automationId, ids))
    .orderBy(flowAutomationConversions.automationId, desc(flowAutomationConversions.createdAt), desc(flowAutomationConversions.id));
  for (const r of rows) out.set(r.automationId, { id: r.id, state: r.state, flowId: r.flowId });
  return out;
}

/**
 * The same summary as a correlated scalar subquery (jsonb or NULL), for a
 * projection that selects automations in one statement (`breeze://automations`).
 */
export function conversionSummarySql(automationId: AnyColumn | SQL): SQL<AutomationConversionSummary | null> {
  return sql<AutomationConversionSummary | null>`(
    SELECT jsonb_build_object('id', fac.id, 'state', fac.state, 'flowId', fac.flow_id)
    FROM flow_automation_conversions fac
    WHERE fac.automation_id = ${automationId}
    ORDER BY fac.created_at DESC, fac.id DESC
    LIMIT 1
  )`;
}

export type ShadowResetTarget =
  /** After an automation update: `previous` is the row as it was before the UPDATE. */
  | { automationId: string; previous: SourceFields }
  /** After a draft save of the flow. */
  | { flowId: string };

/** Counters, start and last divergence back to a fresh shadow. Legal under the immutability trigger. */
function freshShadow(): Partial<typeof flowAutomationConversions.$inferInsert> {
  return {
    shadowRuns: 0,
    shadowDivergences: 0,
    shadowStartedAt: sql`now()` as unknown as Date,
    shadowLastAt: null,
    shadowLastDivergence: null,
    updatedAt: sql`now()` as unknown as Date,
  };
}

/**
 * Plan Decision 3: a shadow's counters reset whenever the Job's source digest
 * or the draft's document digest changes. Only a `shadow` generation resets.
 *
 *  - automation: the source fields before and after the edit are compared
 *    (the ledger's `source_digest` is the immutable conversion-time digest, so
 *    it cannot be the "previous" side); a rename or an enable toggle is no
 *    change.
 *  - flow: the saved draft's digest is compared with the ledger's
 *    `document_digest`, which then follows the draft.
 *
 * Returns whether a generation was reset.
 */
export async function resetShadowIfChanged(tx: DbExecutor, target: ShadowResetTarget): Promise<boolean> {
  if ('automationId' in target) {
    const [now] = await tx
      .select({
        trigger: automations.trigger,
        conditions: automations.conditions,
        actions: automations.actions,
        onFailure: automations.onFailure,
        notificationTargets: automations.notificationTargets,
      })
      .from(automations)
      .where(eq(automations.id, target.automationId))
      .limit(1);
    if (!now) return false;
    if (automationSourceDigest(now) === automationSourceDigest(target.previous)) return false;
    const reset = await tx
      .update(flowAutomationConversions)
      .set(freshShadow())
      .where(and(eq(flowAutomationConversions.automationId, target.automationId), eq(flowAutomationConversions.state, 'shadow')))
      .returning({ id: flowAutomationConversions.id });
    return reset.length > 0;
  }

  const [generation] = await tx
    .select({ id: flowAutomationConversions.id, documentDigest: flowAutomationConversions.documentDigest })
    .from(flowAutomationConversions)
    .where(and(eq(flowAutomationConversions.flowId, target.flowId), eq(flowAutomationConversions.state, 'shadow')))
    .limit(1);
  if (!generation) return false;
  const [flow] = await tx.select({ definition: flows.definition }).from(flows).where(eq(flows.id, target.flowId)).limit(1);
  if (!flow) return false;
  const digest = flowDocumentDigest(flow.definition);
  if (digest === generation.documentDigest) return false;
  const reset = await tx
    .update(flowAutomationConversions)
    .set({ ...freshShadow(), documentDigest: digest })
    .where(and(eq(flowAutomationConversions.id, generation.id), eq(flowAutomationConversions.state, 'shadow')))
    .returning({ id: flowAutomationConversions.id });
  return reset.length > 0;
}
