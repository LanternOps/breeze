export const AI_AGENT_KINDS = ['triage', 'patch', 'helpdesk'] as const;
export type AiAgentKind = (typeof AI_AGENT_KINDS)[number];

export const AI_AGENT_MODES = ['off', 'shadow', 'act'] as const;
export type AiAgentMode = (typeof AI_AGENT_MODES)[number];

/** Ladder used by the tighten-only merge: lower rank = stricter. */
export const AI_AGENT_MODE_RANK: Readonly<Record<AiAgentMode, number>> = Object.freeze({ off: 0, shadow: 1, act: 2 });

export function minAgentMode(a: AiAgentMode, b: AiAgentMode): AiAgentMode {
  return AI_AGENT_MODE_RANK[a] <= AI_AGENT_MODE_RANK[b] ? a : b;
}

export const AI_AGENT_RUN_STATUSES = [
  'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped',
] as const;
export type AiAgentRunStatus = (typeof AI_AGENT_RUN_STATUSES)[number];

export const AI_AGENT_TRIGGER_KINDS = ['alert', 'manual', 'schedule', 'ticket'] as const;
export type AiAgentTriggerKind = (typeof AI_AGENT_TRIGGER_KINDS)[number];

export interface AiAgentLimits {
  maxDevicesPerRun: number;
  maxConcurrentRuns: number;
  maxRunsPerHour: number;
  maxTurnsPerRun: number;
  maxBudgetCentsPerRun: number;
  maxBudgetCentsPerDay: number;
  wallClockSeconds: number;
  maxFleetPercentPerDay: number;
}

export const AI_AGENT_LIMIT_DEFAULTS: Readonly<AiAgentLimits> = Object.freeze({
  maxDevicesPerRun: 1,
  maxConcurrentRuns: 1,
  maxRunsPerHour: 20,
  maxTurnsPerRun: 25,
  maxBudgetCentsPerRun: 50,
  maxBudgetCentsPerDay: 1000,
  wallClockSeconds: 600,
  maxFleetPercentPerDay: 5,
});

export interface AiAgentTriggers {
  alertSeverities: Array<'critical' | 'high' | 'medium' | 'low' | 'info'>;
  alertRuleIds?: string[];
  siteIds?: string[];
  deviceGroupIds?: string[];
  deviceTags?: string[];
  respectMaintenanceWindows: boolean;
}

export interface AiAgentRecipients {
  userIds: string[];
  /**
   * Role IDs, not role names. `roles` is a tenant-scoped table with custom
   * names and an `isSystem` flag (apps/api/src/db/schema/users.ts) — there is
   * no fixed owner/admin/technician union in this product, so matching by name
   * would silently miss renamed or partner-defined roles.
   */
  roleIds: string[];
}

export interface AiAgentProtectedResources {
  services: string[];
  paths: string[];
  registryKeys: string[];
  deviceTags: string[];
}

/** The policy fields that the resolver merges (everything on ai_agents that governs a run). */
export interface AiAgentPolicy {
  enabled: boolean;
  mode: AiAgentMode;
  model: string | null;
  toolAllowlist: string[];
  protectedResources: AiAgentProtectedResources;
  limits: AiAgentLimits;
  triggers: AiAgentTriggers;
  recipients: AiAgentRecipients;
  instructions: string | null;
  cooldownSeconds: number;
}

export type AiAgentPolicyProvenance = Record<keyof AiAgentPolicy, 'partner' | 'org' | 'merged'>;

/**
 * Bumped whenever the shape of `effective` changes. ai_agent_runs.policy_snapshot
 * is append-only ledger data that outlives this type, so a v1 row must stay
 * distinguishable from a v2 row — there is no backfill for a run that already
 * happened.
 */
export const AI_AGENT_POLICY_SNAPSHOT_VERSION = 1 as const;

export interface AiAgentPolicySnapshot {
  schemaVersion: number;
  agentId: string;
  kind: AiAgentKind;
  effective: AiAgentPolicy;
  provenance: AiAgentPolicyProvenance;
  resolvedAt: string;
}
