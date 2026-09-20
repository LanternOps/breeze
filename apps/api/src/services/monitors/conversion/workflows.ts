import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolveAutomationAssignmentForDevice } from '../../featureConfigResolver';
import type { AuthContext } from '../../../middleware/auth';
import type { DbExecutor } from '../monitorCompiler';
import { automations, monitorConversions, type configPolicyAutomations } from '../../../db/schema';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import {
  normalizeAutomationActions, resolveAutomationReferencesForOwner, replaceAutomationResourceBindings,
} from '../../automationRuntime';

/** Shared by the rolled-back equivalence proposal and the committing converter. */
export async function rehomePolicyWorkflow(
  tx: DbExecutor,
  source: typeof configPolicyAutomations.$inferSelect,
  policy: { id: string; orgId: string | null; partnerId: string | null },
  auth: AuthContext,
): Promise<string> {
  if (policy.orgId ? !auth.canAccessOrg(policy.orgId)
    : (!canManagePartnerWidePolicies(auth) || (auth.scope !== 'system' && auth.partnerId !== policy.partnerId))) {
    throw new Error('Workflow owner access denied');
  }
  // Resource bindings and workflow creation must share the caller's transaction.
  if (!('rollback' in tx)) throw new Error('Workflow requires a transaction');
  const actions = normalizeAutomationActions(source.actions);
  const owner = { orgId: policy.orgId, partnerId: policy.partnerId };
  const references = await resolveAutomationReferencesForOwner(tx, owner, actions);
  const [created] = await tx.insert(automations).values({
    ...owner, name: source.name, enabled: source.enabled, actions, onFailure: source.onFailure,
    createdBy: auth.scope === 'system' ? null : auth.user.id,
    trigger: { type: 'event', eventType: 'alert.triggered', filter: {
      _policyWorkflow: { policyId: policy.id, sourceId: source.id },
    } },
  }).returning();
  if (!created) throw new Error('Workflow creation failed');
  await replaceAutomationResourceBindings(tx, created.id, owner, references);
  return created.id;
}

export async function policyWorkflowApplies(automation: typeof automations.$inferSelect, deviceId: string, tx: DbExecutor): Promise<boolean> {
  const meta = (automation.trigger as { filter?: { _policyWorkflow?: { policyId: string; sourceId: string } } }).filter?._policyWorkflow;
  if (!meta) return true;
  const [ledger] = await tx.select().from(monitorConversions).where(and(
    eq(monitorConversions.sourceTable, 'config_policy_automations'), eq(monitorConversions.sourceId, meta.sourceId),
    isNull(monitorConversions.revertedAt), sql`${monitorConversions.sourceState}->>'workflowId' = ${automation.id}`)).limit(1);
  if (!ledger || ledger.policyId !== meta.policyId) return false;
  const winner = await resolveAutomationAssignmentForDevice(deviceId, tx);
  return winner?.automations.some((source) => source.id === meta.sourceId) ?? false;
}
