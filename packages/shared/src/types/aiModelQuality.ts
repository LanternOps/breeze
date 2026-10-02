// packages/shared/src/types/aiModelQuality.ts
/**
 * AI model registry W11 (#7609): the model quality view and prompt variants.
 * Request schemas live in ../validators/aiModelRegistryApi.ts.
 */

import type { AiSurface } from '../constants/aiSurfaces';
import type { PromptProfile } from '../validators/aiModelOptions';
import type { AiQualityGroupBy } from '../validators/aiModelRegistryApi';

/**
 * A prompt variant's lifecycle (services/aiModels/promptVariants.ts):
 * staged (offline eval only) → candidate (sticky canary share) → active
 * (every conversation of its surface + profile) → retired (kept for history).
 */
export const AI_PROMPT_VARIANT_STATES = ['staged', 'candidate', 'active', 'retired'] as const;
export type AiPromptVariantState = (typeof AI_PROMPT_VARIANT_STATES)[number];

/**
 * One group's quality metrics. Rates are 0..1; null = not measurable for this
 * group (no denominator) or not recorded on this server (see sources).
 * Attribution: a call counts toward the offering CHOSEN for it (a refusal
 * fallback or a failover hop counts toward the model that was chosen); a
 * conversation's outcome toward the group of its last call; a switch toward
 * the group it left.
 */
export interface AiQualityMetricsDto {
  invocations: number;
  costCents: number;
  refusals: number;
  /** refusals / invocations (declined calls per model call, as on the spend view). */
  refusalRate: number;
  /** Calls served by a failover hop. null: this server does not record failovers yet. */
  failovers: number | null;
  failoverRate: number | null;
  /** Sessions + agent runs whose last call in the range was in this group. */
  conversations: number;
  /** Spend in this group per conversation that used it; null with none. */
  costPerConversationCents: number | null;
  sessions: number;
  /** Sessions a person flagged. */
  flagged: number;
  /** Sessions flagged automatically after a tool error. */
  autoFlagged: number;
  /** flagged / sessions. */
  flagRate: number | null;
  /** Conversations that moved from this group to another model mid-conversation. */
  switchedAway: number;
  /** Sessions continued into a new session; null: this server does not record continuations yet. */
  continued: number | null;
  /** Distinct conversations that switched away from, or were continued from, this group, over the conversations that used it. */
  leftRate: number | null;
  /** Finished sessions (closed, expired, or idle 24 h) not flagged by a person and not continued. */
  resolvedSessions: number;
  /** Median technician messages in resolved sessions, including the sessions they continued from. */
  medianTurnsToResolution: number | null;
  /** Agent runs that reached a terminal status. */
  agentRuns: number;
  agentRunsCompleted: number;
  agentCompletionRate: number | null;
}

export interface AiQualityRowDto extends AiQualityMetricsDto {
  /** groupBy=model: the offering id, or 'unattributed'. surface: the AiSurface. prompt_profile: the profile, or 'unrecorded'. */
  key: string;
  /** groupBy=model only: the offering's display name; null when the offering is gone. Other groupings: null (the client labels keys). */
  label: string | null;
  /** groupBy=model only: the connection name; null = the platform key (or not a model row). */
  connectionName: string | null;
}

/** Which optional ledger sources this server records (they arrive with later model-registry waves). */
export interface AiQualitySourcesDto {
  failovers: boolean;
  continuations: boolean;
}

export interface AiQualityBreakdownDto {
  groupBy: AiQualityGroupBy;
  from: string;
  to: string;
  orgId: string | null;
  rows: AiQualityRowDto[];
  totals: AiQualityMetricsDto;
  sources: AiQualitySourcesDto;
}

export interface AiPromptVariantDto {
  id: string;
  surface: AiSurface;
  profile: PromptProfile;
  version: number;
  state: AiPromptVariantState;
  canaryPercent: number;
  hypothesis: string;
}

export interface AiPromptVariantReportRowDto {
  /** A variant id, or `${surface}/${profile}@base` for the base prompt. */
  key: string;
  surface: AiSurface;
  profile: PromptProfile;
  /** null = the base prompt. */
  variant: AiPromptVariantDto | null;
  metrics: AiQualityMetricsDto;
  /** Fewer than minConversations conversations: too few to compare. */
  lowSample: boolean;
  /**
   * The arm a candidate competes with: the active variant of this surface +
   * profile, or the base prompt when none is active. Once a variant is active
   * no conversation gets the base prompt, so a later candidate is compared with
   * the active variant, never with base.
   */
  incumbent: boolean;
}

export interface AiPromptVariantReportDto {
  from: string;
  to: string;
  minConversations: number;
  rows: AiPromptVariantReportRowDto[];
  sources: AiQualitySourcesDto;
}
