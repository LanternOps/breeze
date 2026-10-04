/**
 * AI Suggested Fixes W2 — what a user may change on the built-in research agent.
 * Kept free of db imports so agentService (and its unit tests) can use it
 * without pulling in the provisioner; re-exported from researchProvisioning.
 */
import {
  AI_AGENT_LIMIT_DEFAULTS,
  aiAgentActAssetsSchema,
  aiAgentProtectedResourcesSchema,
  aiAgentRecipientsSchema,
  aiAgentTriggersSchema,
  RESEARCH_EDITABLE_LIMIT_KEYS,
  type CreateAiAgentInput,
} from '@breeze/shared';

export class ResearchAgentEditError extends Error {
  readonly code = 'research_agent_edit_restricted' as const;
  constructor(readonly fields: string[]) {
    super(fields.length === 1 && fields[0] === 'ownerScope'
      ? 'A partner-level research agent is provisioned by the system and cannot be created; only organization overrides can be created'
      : `A built-in research agent only allows enabled and research budget/cap changes; refused: ${fields.join(', ')}`);
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

/**
 * A research row is never authored by a user: on create (an org override) every
 * field except name, enabled and the editable research caps is pinned to what
 * the provisioned baseline carries. The PATCH guard forbids editing those
 * fields later, and `instructions` reaches the run's system prompt, so a
 * user-authored value would be both permanent and injected.
 */
export function pinResearchCreateInput(input: CreateAiAgentInput): CreateAiAgentInput {
  const limits: Record<string, number> = { ...AI_AGENT_LIMIT_DEFAULTS };
  const supplied = input.limits as unknown as Record<string, number>;
  for (const key of RESEARCH_EDITABLE_LIMIT_KEYS) {
    if (typeof supplied[key] === 'number') limits[key] = supplied[key];
  }
  return {
    ...input,
    mode: 'act',
    toolAllowlist: [],
    instructions: null,
    // Model binding is not PATCH-editable for research, so it must not be user-chosen at create.
    offeringId: null,
    cooldownSeconds: 900,
    protectedResources: aiAgentProtectedResourcesSchema.parse({}),
    triggers: aiAgentTriggersSchema.parse({}),
    recipients: aiAgentRecipientsSchema.parse({}),
    actAssets: aiAgentActAssetsSchema.parse({}),
    limits: limits as unknown as CreateAiAgentInput['limits'],
  };
}
