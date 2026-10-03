/**
 * AI Suggested Fixes W2 — what a user may change on the built-in research agent.
 * Kept free of db imports so agentService (and its unit tests) can use it
 * without pulling in the provisioner; re-exported from researchProvisioning.
 */
import { RESEARCH_EDITABLE_LIMIT_KEYS } from '@breeze/shared';

export class ResearchAgentEditError extends Error {
  readonly code = 'research_agent_edit_restricted' as const;
  constructor(readonly fields: string[]) {
    super(`A built-in research agent only allows enabled and research budget/cap changes; refused: ${fields.join(', ')}`);
    this.name = 'ResearchAgentEditError';
  }
}

const ALLOWED_TOP = new Set(['enabled', 'limits', 'name']);
const ALLOWED_LIMITS = new Set<string>(RESEARCH_EDITABLE_LIMIT_KEYS);

/** Spec: "Only enable/disable and budget caps are editable." PATCH-shaped input only. */
export function assertResearchAgentEdit(input: Record<string, unknown>): void {
  const refused: string[] = [];
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) continue;
    if (!ALLOWED_TOP.has(key)) refused.push(key);
  }
  const limits = input.limits;
  if (limits && typeof limits === 'object') {
    for (const key of Object.keys(limits)) {
      if (!ALLOWED_LIMITS.has(key)) refused.push(`limits.${key}`);
    }
  }
  if (refused.length > 0) throw new ResearchAgentEditError(refused);
}
