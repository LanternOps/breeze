/**
 * AI model registry (#7598): the features that call a model (spec §4). The
 * W02 `ai_model_assignments.surface` / `role` CHECKs mirror these. Leaf module.
 */
export const AI_SURFACES = [
  'chat',
  'helper',
  'script_builder',
  'script_reviewer',
  'office_chat',
  'office_ticket',
  'ai_agents',
  'catalog_enrichment',
  'extension_content',
  'patch_test',
] as const;
export type AiSurface = (typeof AI_SURFACES)[number];

/** Every surface resolves `default`. `ai_agents` also has the W09 escalation stages. */
export const AI_SURFACE_ROLES: Readonly<Record<AiSurface, readonly string[]>> = Object.freeze({
  chat: ['default'],
  helper: ['default'],
  script_builder: ['default'],
  script_reviewer: ['default'],
  office_chat: ['default'],
  office_ticket: ['default'],
  ai_agents: ['default', 'triage', 'analysis', 'remediation'],
  catalog_enrichment: ['default'],
  extension_content: ['default'],
  patch_test: ['default'],
});

/** An offering without verified tool support can't be assigned or permitted here (spec §7). */
export const TOOL_REQUIRING_SURFACES = [
  'chat',
  'helper',
  'script_builder',
  'ai_agents',
  'office_chat',
] as const satisfies readonly AiSurface[];

/**
 * AI chargeback (#7608, spec §8): surfaces whose usage an MSP may rebill to the
 * client org. The rest is the MSP's own tooling (catalog copy, workspace
 * enrichment, patch tests) and is never chargeable. Open question 2 in the W10
 * plan; changing this list changes only future stamps (snapshot rule).
 */
export const AI_CHARGEBACK_ELIGIBLE_SURFACES = [
  'chat',
  'helper',
  'script_builder',
  'script_reviewer',
  'office_chat',
  'office_ticket',
  'ai_agents',
] as const satisfies readonly AiSurface[];
