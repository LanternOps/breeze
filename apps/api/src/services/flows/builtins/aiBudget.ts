/**
 * Tool Catalog W05 (#5220), plan Decision 13 — spec §6.7 "a flow with an `ai`
 * step cannot be enabled if the owner has no budget". Only a PERMANENT denial
 * (`plan_gate`, `ai_disabled`) refuses the enable: a daily/monthly cap clears
 * by itself, and the run-time check refuses those runs anyway. A partner-wide
 * flow is checked per run org at run time (it has no single org here).
 */
import { checkBudgetDetailed } from '../../aiCostTracker';
import { resolveModel } from '../../aiModels/resolveModel';
import { captureException } from '../../sentry';

export interface AiStepBudgetDenial {
  reason: string;
  message: string;
}

export async function aiStepPermanentBudgetDenial(orgId: string, partnerId: string): Promise<AiStepBudgetDenial | null> {
  try {
    const resolved = await resolveModel({ partnerId, orgId, surface: 'ai_agents' });
    // No model right now is not a budget answer; the run decides (ai_budget_exhausted).
    if (!resolved.ok) return null;
    const denial = await checkBudgetDetailed(orgId, resolved.funding);
    return denial?.permanent ? { reason: denial.reason, message: denial.message } : null;
  } catch (err) {
    // An infrastructure failure is never a reason to refuse an enable; every
    // run re-checks the budget before its first model call.
    console.warn(`[flows] ai step budget check failed at enable (org=${orgId})`, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined,
      { org_id: orgId, flow_site: 'flows.enable.aiBudget' }, { fingerprint: ['flow', 'flows.enable.aiBudget'] });
    return null;
  }
}
