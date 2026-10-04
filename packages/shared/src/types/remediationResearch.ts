// packages/shared/src/types/remediationResearch.ts
/**
 * AI Suggested Fixes W2 — the `remediation_research` profile's contract.
 * Leaf module (types + literals only); the zod schema lives in
 * validators/remediationResearch.ts. No Node imports (browser barrel).
 */
import type { AiAgentLimits } from './aiAgents';

export const RESEARCH_DEPTHS = ['quick', 'deep'] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

/** Spec "submit_suggestions": the ONLY built-in actions research may suggest. */
export const RESEARCH_BUILTIN_ACTIONS = ['reboot', 'restart_service', 'kill_process', 'disk_cleanup'] as const;
export type ResearchBuiltinAction = (typeof RESEARCH_BUILTIN_ACTIONS)[number];

export const RESEARCH_AGENT_NAME = 'Fix research (built-in)' as const;
export const RESEARCH_PROVISIONER = 'system:remediation_research' as const;
export const RESEARCH_MAX_ITEMS = 6;
export const RESEARCH_MAX_STEPS = 12;

/** Spec: only enable/disable and budget caps are editable on a research agent. */
export const RESEARCH_EDITABLE_LIMIT_KEYS = [
  'maxConcurrentResearchRuns', 'maxResearchRunsPerHour', 'maxAutoResearchRunsPerHour',
  'researchQuickBudgetCentsPerRun', 'researchDeepBudgetCentsPerRun', 'maxBudgetCentsPerDay',
] as const satisfies readonly (keyof AiAgentLimits)[];

export type ResearchRiskTier = 'low' | 'medium' | 'high' | 'critical';

interface ItemBase { title: string; reasoning: string; riskTier: ResearchRiskTier }
export type ResearchSuggestionItem =
  | (ItemBase & { kind: 'catalog'; ref: { type: 'script' | 'playbook'; id: string } })
  | (ItemBase & { kind: 'builtin_action'; action: 'reboot'; params: Record<string, never> })
  | (ItemBase & { kind: 'builtin_action'; action: 'restart_service'; params: { serviceName: string } })
  | (ItemBase & { kind: 'builtin_action'; action: 'kill_process'; params: { processName: string } })
  | (ItemBase & { kind: 'builtin_action'; action: 'disk_cleanup'; params: { actionIds: string[] } })
  | (ItemBase & { kind: 'manual_steps'; steps: string[] })
  | (ItemBase & { kind: 'draft_request'; brief: string; language: 'powershell' | 'bash' | 'python' | 'cmd' });

export interface ResearchSubmission { summary: string; items: ResearchSuggestionItem[] }

export const RESEARCH_REJECTION_REASONS = [
  'script_not_visible', 'script_os_incompatible', 'playbook_not_visible', 'cleanup_action_not_allowed',
  'draft_language_os_incompatible', 'item_too_large', 'item_invalid_text',
] as const;
export type ResearchRejectionReason = (typeof RESEARCH_REJECTION_REASONS)[number];
export interface ResearchRejection { index: number; reason: ResearchRejectionReason }

/** What the run outcome stores: only ACCEPTED items; rejections for the trace. */
export interface ResearchOutcome {
  summary: string;
  items: ResearchSuggestionItem[];
  rejected: ResearchRejection[];
  noSafeFix: boolean;
}
