/**
 * AI Suggested Fixes W2 — turn a research run's ACCEPTED items into
 * remediation_suggestions rows (origin 'ai_research', linked to the run).
 * Confidence is dropped (no invented percentage); rationale is the model's
 * reasoning. Idempotent: (agent_run_id, research_ordinal) is unique, and a
 * script already suggested for this source (memory/legacy) wins on the
 * per-source script unique index — the memory row is never overwritten.
 * Runs in the finalizer's system context.
 */
import type { ResearchOutcome, ResearchSuggestionItem } from '@breeze/shared';
import { db } from '../../db';
import { remediationSuggestions } from '../../db/schema';
import type { ResearchRunContext } from '../aiAgents/researchContext';
import { researchItemParameters } from './researchParameters';

export interface PersistResearchInput { runId: string; orgId: string; research: ResearchRunContext; outcome: ResearchOutcome }

type Insert = typeof remediationSuggestions.$inferInsert;

function sourceColumns(r: ResearchRunContext): Pick<Insert, 'sourceType' | 'sourceId' | 'alertId' | 'anomalyId' | 'correlationGroupId'> {
  const { sourceType, sourceId } = r.source;
  return {
    sourceType, sourceId,
    alertId: sourceType === 'alert' ? sourceId : null,
    anomalyId: sourceType === 'anomaly' ? sourceId : null,
    correlationGroupId: sourceType === 'correlation' ? sourceId : null,
  };
}

export function suggestionValuesFor(input: PersistResearchInput, item: ResearchSuggestionItem, ordinal: number): Insert {
  const common: Insert = {
    orgId: input.orgId,
    ...sourceColumns(input.research),
    deviceId: input.research.device.id,
    targetDeviceIds: [input.research.device.id],
    title: item.title.slice(0, 255),
    rationale: item.reasoning,
    riskTier: item.riskTier,
    status: 'suggested',
    confidence: null,
    origin: 'ai_research',
    agentRunId: input.runId,
    researchOrdinal: ordinal,
    evidence: { origin: 'ai_research', runId: input.runId, depth: input.research.depth },
    parameters: researchItemParameters(item),
    targetType: 'diagnostic',
    expectedAction: '',
  };
  switch (item.kind) {
    case 'catalog': {
      if (item.ref.type === 'playbook') {
        return { ...common, targetType: 'playbook', playbookId: item.ref.id, expectedAction: 'Run the playbook through the existing playbook flow.' };
      }
      const name = input.research.catalog.scripts.find((s) => s.id === item.ref.id)?.name ?? item.title;
      return { ...common, targetType: 'script', scriptId: item.ref.id, expectedAction: `Run script "${name}" through the existing script execution flow.` };
    }
    case 'builtin_action':
      return {
        ...common, targetType: 'builtin_action', builtinAction: item.action,
        expectedAction: `Run the built-in ${item.action.replace('_', ' ')} action on this device.`,
      };
    case 'manual_steps':
      return {
        ...common, targetType: 'manual_steps',
        evidence: { ...(common.evidence as Record<string, unknown>), aiWritten: true },
        expectedAction: item.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      };
    case 'draft_request':
      return {
        ...common, targetType: 'script_draft',
        expectedAction: 'Open the script builder with this brief; a technician writes and reviews the script.',
      };
  }
}

/**
 * MUST run inside ONE caller-owned transaction (the finalizer's system DB
 * context): items are inserted one by one, and the spec forbids partial rows,
 * so a mid-batch failure has to roll back every earlier insert. Calling it
 * outside a transaction would commit items individually.
 */
export async function persistResearchSuggestions(input: PersistResearchInput): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const [ordinal, item] of input.outcome.items.entries()) {
    const rows = await db.insert(remediationSuggestions).values(suggestionValuesFor(input, item, ordinal))
      .onConflictDoNothing().returning({ id: remediationSuggestions.id });
    inserted += rows.length;
  }
  return { inserted };
}
