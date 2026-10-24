/**
 * Recipe Library readiness DTOs (Recipe Library spec §4.1, W06 R1a).
 *
 * `GET /api/v1/ai/operator/workflows` returns one `AiOperatorWorkflowDto` per
 * registered recipe, computed from rows on every call. The two capability
 * lists are kept apart on purpose: `missingCapabilities` is ONLY what this
 * tenant can fix (and is what drives the "setup required" badge), while
 * `alwaysManualCapabilities` is a product gap that degrades to human work and
 * never blocks.
 */

export const AI_OPERATOR_RECIPE_READINESS_STATES = ['ready', 'setup_required', 'unavailable'] as const;
export type AiOperatorRecipeReadinessState = (typeof AI_OPERATOR_RECIPE_READINESS_STATES)[number];

export const AI_OPERATOR_CAPABILITY_KINDS = ['provider_connection', 'permission_grant', 'tool_source', 'agent_tool'] as const;
export type AiOperatorCapabilityKind = (typeof AI_OPERATOR_CAPABILITY_KINDS)[number];

export interface AiOperatorCapabilityActionDto {
  kind: 'reconsent_m365' | 'connect_google' | 'connect_m365' | 'add_agent_tools' | 'none';
  href: string | null;
  toolNames: string[];
  agentId: string | null;
}

export const AI_OPERATOR_CAPABILITY_AVAILABILITIES = ['tenant_fixable', 'always_manual'] as const;
export type AiOperatorCapabilityAvailability = (typeof AI_OPERATOR_CAPABILITY_AVAILABILITIES)[number];

export interface AiOperatorMissingCapabilityDto {
  key: string;
  kind: AiOperatorCapabilityKind;
  provider: 'breeze' | 'm365' | 'google' | null;
  detail: string;
  /**
   * True when the recipe can still run without this capability, because every
   * effect behind it becomes a ticket checklist item with generated
   * instructions (spec §4.1: "Offboarding degrades by provider, not as a
   * whole"; §6.5). False only for a capability whose absence makes the recipe
   * `unavailable` — today, having no provider connection at all.
   *
   * ORTHOGONAL to `availability`: `degradesToHumanWork` says whether the
   * recipe can still run, `availability` says whether anyone can fix it. Every
   * `always_manual` capability degrades; so do most `tenant_fixable` ones.
   */
  degradesToHumanWork: boolean;
  /** `always_manual` never contributes to `setup_required`. */
  availability: AiOperatorCapabilityAvailability;
  action: AiOperatorCapabilityActionDto;
}

export interface AiOperatorWorkflowDto {
  recipeKey: string;
  recipeVersion: number;
  name: string;
  summary: string;
  gateClass: 'deterministic' | 'model_chooses_effect';
  targetKinds: string[];
  readiness: AiOperatorRecipeReadinessState;
  /** ONLY `tenant_fixable` gaps. This is what drives the setup badge. */
  missingCapabilities: AiOperatorMissingCapabilityDto[];
  /** Product gaps — reported separately so they never read as "setup required". */
  alwaysManualCapabilities: AiOperatorMissingCapabilityDto[];
  /** `alwaysManualCapabilities.length`, for the card's "N steps done by hand". */
  manualStepCount: number;
  /** Effect tool names that will be rendered as human work for this org. */
  degradedEffects: string[];
  agentId: string | null;
  agentKind: string | null;
}
