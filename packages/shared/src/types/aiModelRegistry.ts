/**
 * Response DTOs for /ai/models (AI model registry W04, #7602). The API builds
 * them in services/aiModels/registryView.ts and usageQueries.ts; the web reads
 * them unchanged. Never add key material, fingerprints or raw provider config.
 */
import type { AiConnectionEnvFields, AiConnectionKind } from '../constants/aiConnectionKinds';
import type { AiSurface, TOOL_REQUIRING_SURFACES } from '../constants/aiSurfaces';
import type { EffortLevel, ModelLifecycle, ModelRates, OfferingOptions, OptionSupport } from '../validators/aiModelOptions';
import type { AiAssignmentWriteRole, AiToolAllowlist, AiToolProfile, AiUsageGroupBy } from '../validators/aiModelRegistryApi';

export interface AiConnectionDto extends AiConnectionEnvFields {
  /** null for the implicit platform connection. */
  id: string | null;
  kind: AiConnectionKind;
  name: string;
  status: 'active' | 'error' | 'platform';
  lastError: string | null;
  keyLast4: string | null;
  /** The connection's own setting (null = inherit). */
  inferenceGeo: string | null;
  /** What W03 actually sends: own → platform setting (AI_PLATFORM_INFERENCE_GEO) → provider default. */
  effectiveInferenceGeo: string | null;
  inferenceGeoSource: 'connection' | 'platform' | 'provider_default';
  /** Geos the connection's models can honour (union of their option_support.inferenceGeo). */
  supportedInferenceGeos: string[];
  catalogEntryId: string | null;
  catalogName: string | null;
  configVersion: number | null;
  verifiedAt: string | null;
  lastDiscoveredAt: string | null;
  discoveryError: string | null;
  funding: 'platform' | 'partner_key';
  /** openai_compatible only (W06). Never contains credentials. */
  baseUrl: string | null;
}

/** Why the enable switch is disabled (the subset of ResolveFailureReason the enable gate can return). */
export type OfferingEnableBlocker =
  | 'model_unavailable'
  | 'unpriced'
  | 'plan_required'
  | 'connection_unavailable'
  /** A platform offering the configured platform inference geography cannot serve (W03 platform-geo rule). */
  | 'residency_unavailable';

export interface AiOfferingDto {
  /** null for a platform model the partner has not added yet (row is synthesized). */
  id: string | null;
  platformModelId: string | null;
  connectionId: string | null;
  source: 'platform' | 'discovered' | 'manual' | 'catalog';
  modelId: string;
  displayName: string;
  displayNameOverride: string | null;
  enabled: boolean;
  lifecycle: ModelLifecycle;
  funding: 'platform' | 'partner_key';
  /** The rate the resolver would bill, per spec §8 precedence; null = unpriced. */
  rates: ModelRates | null;
  fastRates: ModelRates | null;
  priceSource: 'platform' | 'offering' | 'catalog' | 'linked_platform' | null;
  /** Own prices (discovered/manual only), for the drawer. */
  ownPrices: ModelRates | null;
  pricesEditable: boolean;
  thinkingMode: 'adaptive' | 'budget' | 'none' | 'unknown';
  supportsTools: boolean;
  contextTokens: number | null;
  optionSupport: OptionSupport;
  defaultOptions: OfferingOptions | null;
  allowedOptions: { effort?: EffortLevel[]; thinkingDisplay?: OptionSupport['thinkingDisplay']; speed?: OptionSupport['speed'] } | null;
  requiredPermission: string | null;
  refusalFallbackOfferingId: string | null;
  /** null = can be enabled; otherwise why not. */
  enableBlocker: OfferingEnableBlocker | null;
  /** Surfaces (partner or org rows) that use this offering as their default. */
  defaultFor: Array<{ surface: AiSurface; level: 'partner' | 'org'; orgId: string | null }>;
  updatedAt: string | null;
  /** Gateway-connection offerings only; null for platform / anthropic_byok / catalog. */
  verification: AiOfferingVerificationDto | null;
  /**
   * #11396: what is known about the model's context window, and what `auto`
   * uses. Gateway-connection offerings only (the only ones a window can
   * narrow); null for platform / anthropic_byok / catalog.
   */
  contextWindow: AiOfferingContextWindowDto | null;
  /**
   * #11398: the tool profile set on this model (partner level; organizations
   * choose models, they cannot override it) and what each surface resolves
   * to now. Every offering carries it; a synthesized platform row is `auto`.
   */
  toolProfile: AiOfferingToolProfileDto;
}

/** #11398: the surfaces a tool profile narrows. */
export const AI_TOOL_PROFILED_SURFACES = ['chat', 'helper', 'script_builder', 'ai_agents', 'office_chat'] as const;
export type AiToolProfiledSurface = (typeof AI_TOOL_PROFILED_SURFACES)[number];

/**
 * #11398: why a surface resolves to its profile.
 *  - `explicit`: the partner chose a profile other than `auto`;
 *  - `auto_window`: `auto` picked from the known context window (see `contextWindow.source`);
 *  - `auto_unknown_window`: `auto` with no known window stays `full`;
 *  - `auto_unmeasured`: `auto` on a surface whose prompt size is not measured stays `full`.
 */
export type AiToolProfileReason = 'explicit' | 'auto_window' | 'auto_unknown_window' | 'auto_unmeasured';

export interface AiOfferingToolSurfaceDto {
  surface: AiToolProfiledSurface;
  /** The profile the surface applies now; `too_small` = no profile fits the window, so sessions refuse. */
  resolved: 'full' | 'standard' | 'minimal' | 'custom' | 'too_small';
  reason: AiToolProfileReason;
  /** What `auto` would pick here at the known window (null = window unknown), so an explicit profile too large for the window shows. */
  autoProfile: 'full' | 'standard' | 'minimal' | 'too_small' | null;
  /**
   * Tools the surface requires that the resolved profile drops; the surface
   * refuses (`tool_profile_underpowered`) while this is non-empty. For
   * `ai_agents` it is the device-troubleshooting run's floor (other runs keep
   * their outcome tools under every profile).
   */
  missingRequired: string[];
}

export interface AiOfferingToolProfileDto {
  profile: AiToolProfile;
  allowlist: AiToolAllowlist | null;
  surfaces: AiOfferingToolSurfaceDto[];
  /** Stored `custom` tool names no surface declares any more (ignored at runtime). */
  droppedCustomNames: string[];
  /** A context window override applies to BYO OpenAI-compatible endpoint models only. */
  windowOverrideSupported: boolean;
}

/**
 * #11396: the evidence behind an offering's effective context window. The
 * override is kept apart from what was discovered or observed, so clearing it
 * restores the evidence underneath. A stale or re-versioned observation is
 * still shown (`fresh: false`) but no longer constrains.
 */
export interface AiOfferingContextWindowDto {
  /** The window `auto` and the gateway use; null = unknown (`auto` stays full). */
  effective: number | null;
  source: 'override' | 'discovered' | 'observed' | 'unknown';
  override: number | null;
  /** Stated by the endpoint's model listing on the last discovery sync that listed the model. */
  discovered: number | null;
  /** Stated by the endpoint in a context-length rejection. */
  observed: { value: number; at: string; fresh: boolean } | null;
}

export type OfferingVerificationState = 'unverified' | 'verified' | 'failed' | 'stale';

/** #11397: a surface that needs tools (and so can carry a verify `surface_turn` verdict). */
export type AiToolSurface = (typeof TOOL_REQUIRING_SURFACES)[number];
/**
 * #11397: one surface's verify round trip, judged against the CURRENT endpoint
 * and the tool profile the surface resolves to now. Only `failed` refuses the
 * surface; `inconclusive` (the endpoint failed, not the model), `stale` and
 * `absent` (never run, e.g. records from before W04, or Office) refuse nothing.
 */
export type AiSurfaceReadinessState = 'passed' | 'failed' | 'inconclusive' | 'stale' | 'absent';
export interface AiSurfaceReadinessDto {
  state: AiSurfaceReadinessState;
  at: string | null;
  /** The resolved profile the turn ran under. */
  profile: 'full' | 'standard' | 'minimal' | 'custom' | null;
  /** The turn's first-request prompt tokens (cache reads/writes included), as the endpoint reported them. */
  promptTokens: number | null;
  cachedTokens: number | null;
  /** Short, scrubbed reason when not passed (≤ 200 chars). */
  summary: string | null;
}

export interface AiOfferingVerificationDto {
  state: OfferingVerificationState;
  at: string | null;
  harnessVersion: string | null;
  /** Short, scrubbed reason for 'failed' (≤ 200 chars). */
  summary: string | null;
  /** #11397: per tool surface; every surface `absent` until a verify runs a surface turn on it. */
  surfaces: Record<AiToolSurface, AiSurfaceReadinessDto>;
}

export interface AiAssignmentRowDto {
  surface: AiSurface;
  role: AiAssignmentWriteRole;
  defaultOfferingId: string | null;
  permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null;
  options: OfferingOptions | null;
  /** W09: ordered failover list (null = none on this row). */
  fallbackOfferingIds: string[] | null;
  /** W09: null on an org row = inherit. */
  fallbackMayCrossFunding: boolean | null;
  updatedAt: string | null;
}

export interface AiSurfaceDefaultsDto {
  surface: AiSurface;
  /** W09: one entry per (surface, role); `default` first. */
  role: string;
  requiresTools: boolean;
  partner: AiAssignmentRowDto | null;
  /** Count of org overrides for this (surface, role) (link to orgs, not edited here). */
  orgOverrideCount: number;
}

export interface AiModelsSnapshotDto {
  partner: { residencyRequired: boolean; plan: string; hosted: boolean };
  connections: AiConnectionDto[];
  offerings: AiOfferingDto[];
  defaults: AiSurfaceDefaultsDto[];
  catalog: Array<{ entryId: string; slug: string; name: string; dataNote: string | null; models: string[] }>;
  catalogEnabled: boolean;
}

export interface AiOrgSurfaceDefaultsDto {
  surface: AiSurface;
  role: string;
  requiresTools: boolean;
  /** The partner row's values = what an all-blank org row inherits. */
  inherited: { defaultOfferingId: string | null; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions; fallbackOfferingIds: string[]; fallbackMayCrossFunding: boolean };
  org: AiAssignmentRowDto | null;
  effective: { defaultOfferingId: string | null; defaultSource: 'org' | 'partner' | 'none'; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions; fallbackOfferingIds: string[]; fallbackMayCrossFunding: boolean };
}

export interface AiOrgModelDefaultsDto {
  orgId: string;
  /** Enabled offerings of the org's partner (what an override may choose from). */
  offerings: Array<Pick<AiOfferingDto, 'id' | 'displayName' | 'funding' | 'supportsTools' | 'optionSupport' | 'rates' | 'requiredPermission'>>;
  surfaces: AiOrgSurfaceDefaultsDto[];
  canEdit: boolean;
  canEditReviewer: boolean;
}

export interface AiResidencyImpactDto {
  /** Surfaces whose PARTNER default becomes ineligible when residency is required. */
  unavailableSurfaces: AiSurface[];
  /** Org overrides whose own default becomes ineligible (Codex review finding 12). */
  affectedOrgOverrides: Array<{ orgId: string; orgName: string | null; surface: AiSurface }>;
}

export interface AiUsageRowDto {
  key: string;
  label: string;
  invocations: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  refusals: number;
  /** refusals / invocations, 0..1; 0 when invocations = 0. */
  refusalRate: number;
  fallbacks: number;
  /** W09: rows served by a failover hop (failover_hop > 0). */
  failovers: number;
  /**
   * groupBy=model only (absent otherwise): the connection that served these
   * calls has since been disconnected (W03 soft-disconnect keeps it as ledger
   * provenance). Always false for platform-funded rows.
   */
  connectionDisconnected?: boolean;
}

export interface AiUsageBreakdownDto {
  groupBy: AiUsageGroupBy;
  from: string;
  to: string;
  orgId: string | null;
  rows: AiUsageRowDto[];
  totals: Omit<AiUsageRowDto, 'key' | 'label' | 'connectionDisconnected'>;
}
