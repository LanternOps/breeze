/**
 * Response DTOs for /ai/models (AI model registry W04, #7602). The API builds
 * them in services/aiModels/registryView.ts and usageQueries.ts; the web reads
 * them unchanged. Never add key material, fingerprints or raw provider config.
 */
import type { AiSurface } from '../constants/aiSurfaces';
import type { EffortLevel, ModelLifecycle, ModelRates, OfferingOptions, OptionSupport } from '../validators/aiModelOptions';
import type { AiAssignmentWriteRole, AiUsageGroupBy } from '../validators/aiModelRegistryApi';

export type AiConnectionKind = 'platform' | 'anthropic_byok' | 'catalog' | 'openai_compatible';

export interface AiConnectionDto {
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
}

export interface AiAssignmentRowDto {
  surface: AiSurface;
  role: AiAssignmentWriteRole;
  defaultOfferingId: string | null;
  permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null;
  options: OfferingOptions | null;
  updatedAt: string | null;
}

export interface AiSurfaceDefaultsDto {
  surface: AiSurface;
  requiresTools: boolean;
  partner: AiAssignmentRowDto | null;
  /** Count of org overrides for this surface (link to orgs, not edited here). */
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
  requiresTools: boolean;
  /** The partner row's values = what an all-blank org row inherits. */
  inherited: { defaultOfferingId: string | null; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions };
  org: AiAssignmentRowDto | null;
  effective: { defaultOfferingId: string | null; defaultSource: 'org' | 'partner' | 'none'; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions };
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
