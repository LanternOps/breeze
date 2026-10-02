/**
 * Read models for the /ai/models UI (W04, #7602). The DTOs never carry key
 * material, fingerprints or raw provider config. Eligibility facts come from
 * W03's candidate loader, and the enable blocker comes from enableBlockerFor
 * (one rule table). A platform model the partner has not added yet is shown
 * through the loader's own pure helpers (platformCandidateFacts,
 * platformModelView), so it reports the same blocker, tools and geographies
 * the loaded offering will once added (rulings BD-1, BD-4).
 *
 * Reads run in the caller's DB context (partner scope); the candidate loader
 * reads through its own system transaction, pinned to partnerId.
 */
import { eq } from 'drizzle-orm';
import {
  AI_ASSIGNMENT_WRITE_ROLES,
  CONFIGURABLE_AI_SURFACE_ROLES,
  isGatewayConnectionKind,
  TOOL_REQUIRING_SURFACES,
  type AiAssignmentRowDto,
  type AiConnectionDto,
  type AiModelsSnapshotDto,
  type AiOfferingDto,
  type AiOfferingVerificationDto,
  type AiOrgModelDefaultsDto,
  type AiSurface,
  type OfferingOptions,
} from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';
import { isHosted } from '../../config/env';
import { isPlatformLlmConfigured } from '../llm/llmAvailability';
import { isLlmProviderCatalogEnabled } from '../llm/llmConfigResolver';
import { getListedProviders } from '../llmProviderCatalog';
import {
  loadOfferingCandidate,
  loadPartnerFacts,
  platformCandidateFacts,
  platformModelView,
  type LoadedCandidate,
} from './candidateLoader';
import { enableBlockerFor, type EnableEligibilityContext } from './eligibility';
import { getPlatformInferenceGeo, listPlatformModels, type PlatformModel } from './platformModels';
import { listConnections, type PartnerAiConnection } from './connections';
import { listOfferings, type Offering } from './offerings';
import { listAssignmentRows } from './assignmentRows';
import { mergeEffectiveAssignment, selectRoleRows } from './assignments';
import { endpointFingerprint, verifiedGatewayCapabilities } from './gatewayCapabilities';
import { isEnvManaged } from './gatewayConnections';

const TOOL_SURFACES = new Set<string>(TOOL_REQUIRING_SURFACES);

/** Listed catalog entries for the endpoint select — never the raw base URL, auth mode or pricing. */
export async function buildCatalogSummary(): Promise<AiModelsSnapshotDto['catalog']> {
  const providers = await getListedProviders();
  return providers.map((provider) => ({
    entryId: provider.entryId,
    slug: provider.slug,
    name: provider.name,
    dataNote: provider.dataNote,
    // Verified ∩ mapped: a verification recorded against a model no longer in
    // this revision's modelMap must never appear selectable. `Object.hasOwn`,
    // not `in` — `modelMap` is a jsonb round-trip, so `'constructor' in
    // modelMap` is true by inheritance and would offer the UI a model the
    // revision has no wire id or pricing for (#3922 W3 review round 2).
    models: provider.verifiedModels.filter((modelId) => Object.hasOwn(provider.modelMap, modelId)),
  }));
}

/**
 * W06: a gateway offering's verification as the UI shows it, judged against the
 * connection's CURRENT endpoint fingerprint (a base-URL change makes it stale).
 * Only the record's state, time, harness version and scrubbed summary leave —
 * never the tree or the fingerprint. null for every non-gateway offering.
 */
function verificationDto(o: Offering, conn: PartnerAiConnection | undefined): AiOfferingVerificationDto | null {
  if (!conn || !isGatewayConnectionKind(conn.kind)) return null;
  const { state, record } = verifiedGatewayCapabilities(
    o.capabilities,
    endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null }),
  );
  return { state, at: record?.at ?? null, harnessVersion: record?.harnessVersion ?? null, summary: record?.summary ?? null };
}

function offeringDto(
  o: Offering,
  c: LoadedCandidate,
  blocker: AiOfferingDto['enableBlocker'],
  defaultFor: AiOfferingDto['defaultFor'],
  conn: PartnerAiConnection | undefined,
): AiOfferingDto {
  const own = o.priceInputCentsPerM === null || o.priceOutputCentsPerM === null
    || o.priceCacheReadCentsPerM === null || o.priceCacheWriteCentsPerM === null
    ? null
    : {
      inputCentsPerM: o.priceInputCentsPerM,
      outputCentsPerM: o.priceOutputCentsPerM,
      cacheReadCentsPerM: o.priceCacheReadCentsPerM,
      cacheWriteCentsPerM: o.priceCacheWriteCentsPerM,
    };
  return {
    id: o.id,
    platformModelId: o.platformModelId,
    connectionId: o.connectionId,
    source: o.source,
    modelId: c.logicalModel,
    displayName: c.displayName,
    displayNameOverride: o.displayName ?? null,
    enabled: o.enabled,
    lifecycle: o.lifecycle,
    funding: c.funding,
    rates: c.facts.rate?.standard ?? null,
    fastRates: c.optionRates?.['speed:fast'] ?? null,
    priceSource: c.facts.rate?.source ?? null,
    ownPrices: own,
    pricesEditable: o.source === 'discovered' || o.source === 'manual',
    thinkingMode: c.capabilities.thinkingMode,
    supportsTools: c.facts.supportsTools,
    contextTokens: c.limits.maxInputTokens,
    optionSupport: c.optionSupport,
    defaultOptions: (o.defaultOptions ?? null) as OfferingOptions | null,
    allowedOptions: (o.allowedOptions ?? null) as AiOfferingDto['allowedOptions'],
    requiredPermission: o.requiredPermission,
    refusalFallbackOfferingId: o.refusalFallbackOfferingId,
    enableBlocker: blocker,
    defaultFor,
    updatedAt: o.updatedAt.toISOString(),
    verification: verificationDto(o, conn),
  };
}

/** A platform model the partner has not added yet, built from the loader's own pure helpers. */
function synthesizedPlatformOffering(
  partnerId: string,
  pm: PlatformModel,
  platformGeo: string | null,
  ctx: EnableEligibilityContext,
): AiOfferingDto {
  const view = platformModelView(pm);
  return {
    id: null,
    platformModelId: pm.id,
    connectionId: null,
    source: 'platform',
    modelId: pm.modelId,
    displayName: pm.displayName,
    displayNameOverride: null,
    enabled: false,
    lifecycle: pm.lifecycle,
    funding: 'platform',
    rates: pm.rates,
    fastRates: pm.optionRates?.['speed:fast'] ?? null,
    priceSource: pm.rates ? 'platform' : null,
    ownPrices: null,
    pricesEditable: false,
    thinkingMode: view.capabilities.thinkingMode,
    supportsTools: view.capabilities.supportsTools,
    contextTokens: pm.maxInputTokens,
    optionSupport: view.optionSupport,
    defaultOptions: null,
    allowedOptions: null,
    requiredPermission: null,
    refusalFallbackOfferingId: null,
    // The same gate ensurePlatformOffering runs on add-and-enable.
    enableBlocker: enableBlockerFor(platformCandidateFacts(partnerId, pm, platformGeo), ctx),
    defaultFor: [],
    updatedAt: null,
    verification: null,
  };
}

/** Effective geo per W03 (Q15): the connection's own value, else the platform setting, else provider default. */
function effectiveGeo(
  own: string | null,
  platformGeo: string | null,
): Pick<AiConnectionDto, 'effectiveInferenceGeo' | 'inferenceGeoSource'> {
  if (own) return { effectiveInferenceGeo: own, inferenceGeoSource: 'connection' };
  if (platformGeo) return { effectiveInferenceGeo: platformGeo, inferenceGeoSource: 'platform' };
  return { effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default' };
}

function unionGeos(offerings: AiOfferingDto[], connectionId: string | null): string[] {
  return [...new Set(offerings.filter((o) => o.connectionId === connectionId).flatMap((o) => o.optionSupport.inferenceGeo))].sort();
}

type LiveConnection = PartnerAiConnection & { status: Exclude<PartnerAiConnection['status'], 'disconnected'> };

/**
 * W03 soft-disconnect: a disconnected connection is ledger provenance only.
 * listConnections already excludes it; this guard keeps the DTO's status union
 * honest if a reader ever returns one.
 */
function isLiveConnection(c: PartnerAiConnection): c is LiveConnection {
  return c.status !== 'disconnected';
}

/** A role outside the shared write-role list is a programming error, never a DTO. */
function assignmentRowDto(r: AiModelAssignmentRow): AiAssignmentRowDto {
  const role = AI_ASSIGNMENT_WRITE_ROLES.find((known) => known === r.role);
  if (!role) throw new Error(`assignmentRowDto: unexpected assignment role '${r.role}'`);
  return {
    surface: r.surface,
    role,
    defaultOfferingId: r.defaultOfferingId,
    permittedOfferingIds: r.permittedOfferingIds,
    allowUserChoice: r.allowUserChoice,
    options: (r.options ?? null) as OfferingOptions | null,
    fallbackOfferingIds: r.fallbackOfferingIds ?? null,
    fallbackMayCrossFunding: r.fallbackMayCrossFunding ?? null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function buildPartnerModelsSnapshot(partnerId: string): Promise<AiModelsSnapshotDto> {
  const facts = await loadPartnerFacts(partnerId);
  const hosted = isHosted();
  const ctx: EnableEligibilityContext = { partnerId, partnerPlan: facts.plan, hosted };
  const [listedConnections, listedOfferings, platformModels, partnerRows, allRows, platformGeo] = await Promise.all([
    listConnections(partnerId),
    listOfferings(partnerId),
    listPlatformModels(),
    listAssignmentRows({ partnerId }),
    // Every assignment (partner and org level) whose offerings belong to this partner.
    db.select({
      surface: aiModelAssignments.surface,
      role: aiModelAssignments.role,
      orgId: aiModelAssignments.orgId,
      defaultOfferingId: aiModelAssignments.defaultOfferingId,
    })
      .from(aiModelAssignments)
      .where(eq(aiModelAssignments.offeringPartnerId, partnerId)),
    getPlatformInferenceGeo(),
  ]);
  const connections = listedConnections.filter(isLiveConnection);
  // A disconnected connection's offerings stay as provenance (W03) but are
  // never shown: not in the Models card, the defaults pickers or defaultFor.
  const connectionsById = new Map<string, PartnerAiConnection>(connections.map((c) => [c.id, c]));
  const offerings = listedOfferings.filter((o) => o.connectionId === null || connectionsById.has(o.connectionId));

  const offeringDtos: AiOfferingDto[] = [];
  for (const o of offerings) {
    const c = await loadOfferingCandidate(o.id, partnerId);
    if (!c) continue;
    // One entry per (surface, level, org): an offering that is both the ai_agents
    // default and one of its role defaults (W09) is listed once.
    const seen = new Set<string>();
    const defaultFor = allRows
      .filter((r) => r.defaultOfferingId === o.id)
      .map((r) => ({ surface: r.surface as AiSurface, level: r.orgId === null ? 'partner' as const : 'org' as const, orgId: r.orgId }))
      .filter((d) => {
        const k = `${d.surface}/${d.level}/${d.orgId ?? ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const conn = o.connectionId === null ? undefined : connectionsById.get(o.connectionId);
    offeringDtos.push(offeringDto(o, c, enableBlockerFor(c.facts, ctx), defaultFor, conn));
  }
  const added = new Set(offerings.filter((o) => o.connectionId === null).map((o) => o.platformModelId));
  for (const pm of platformModels) {
    if (!pm.platformOffered || pm.lifecycle !== 'available' || added.has(pm.id)) continue;
    offeringDtos.push(synthesizedPlatformOffering(partnerId, pm, platformGeo, ctx));
  }

  const catalogEnabled = isLlmProviderCatalogEnabled();
  const catalog = catalogEnabled ? await buildCatalogSummary() : [];
  const catalogNames = new Map(catalog.map((e) => [e.entryId, e.name]));

  // Anthropic credentials only ('agent_sdk'), exactly as the candidate loader
  // decides it (BD-3): the env OpenAI-compatible chat path is not a platform
  // connection and must never make platform models look dispatchable.
  const platformConfigured = isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk');
  const platformConn: AiConnectionDto = {
    id: null,
    kind: 'platform',
    name: 'Breeze platform',
    status: 'platform',
    lastError: null,
    keyLast4: null,
    // The platform connection has no own setting; it always uses the platform one.
    inferenceGeo: null,
    ...effectiveGeo(null, platformGeo),
    supportedInferenceGeos: unionGeos(offeringDtos, null),
    catalogEntryId: null,
    catalogName: null,
    configVersion: null,
    verifiedAt: null,
    lastDiscoveredAt: null,
    discoveryError: null,
    funding: 'platform',
    baseUrl: null,
    managedBy: null,
  };
  const partnerConns: AiConnectionDto[] = connections.map((c) => {
    const gateway = isGatewayConnectionKind(c.kind);
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      status: c.status,
      lastError: c.lastError,
      keyLast4: c.keyLast4,
      // D7: a BYO endpoint's geography is unverifiable — it never claims, inherits or serves one.
      inferenceGeo: gateway ? null : c.inferenceGeo,
      ...(gateway ? effectiveGeo(null, null) : effectiveGeo(c.inferenceGeo, platformGeo)),
      supportedInferenceGeos: gateway ? [] : unionGeos(offeringDtos, c.id),
      catalogEntryId: c.catalogEntryId,
      catalogName: c.catalogEntryId ? catalogNames.get(c.catalogEntryId) ?? null : null,
      configVersion: c.configVersion,
      verifiedAt: c.verifiedAt?.toISOString() ?? null,
      lastDiscoveredAt: c.lastDiscoveredAt?.toISOString() ?? null,
      discoveryError: c.discoveryError,
      funding: 'partner_key' as const,
      // Gateway kinds only; the base URL never carries credentials (byoBaseUrlSchema / byoEndpointPolicy refuse them).
      baseUrl: gateway ? c.baseUrl : null,
      managedBy: gateway && isEnvManaged(c) ? 'env' as const : null,
    };
  });

  return {
    partner: { residencyRequired: facts.residencyRequired, plan: facts.plan, hosted },
    connections: platformConfigured ? [platformConn, ...partnerConns] : partnerConns,
    offerings: offeringDtos,
    // W09: one entry per (surface, role); a role entry shows the partner's own
    // role row only (null = the role inherits the feature default).
    defaults: CONFIGURABLE_AI_SURFACE_ROLES.map(({ surface, role }) => {
      const p = partnerRows.find((r) => r.surface === surface && r.role === role) ?? null;
      return {
        surface,
        role,
        requiresTools: TOOL_SURFACES.has(surface),
        partner: p && assignmentRowDto(p),
        orgOverrideCount: allRows.filter((r) => r.surface === surface && r.role === role && r.orgId !== null).length,
      };
    }),
    catalog,
    catalogEnabled,
  };
}

export async function buildOrgModelDefaults(input: {
  partnerId: string; orgId: string; canEdit: boolean; canEditReviewer: boolean;
}): Promise<AiOrgModelDefaultsDto> {
  const [enabled, partnerRows, orgRows] = await Promise.all([
    listOfferings(input.partnerId, { enabledOnly: true }),
    listAssignmentRows({ partnerId: input.partnerId }),
    listAssignmentRows({ partnerId: input.partnerId, orgId: input.orgId }),
  ]);
  const offerings: AiOrgModelDefaultsDto['offerings'] = [];
  for (const o of enabled) {
    const c = await loadOfferingCandidate(o.id, input.partnerId);
    if (!c) continue;
    offerings.push({
      id: o.id,
      displayName: c.displayName,
      funding: c.funding,
      supportsTools: c.facts.supportsTools,
      optionSupport: c.optionSupport,
      rates: c.facts.rate?.standard ?? null,
      requiredPermission: o.requiredPermission,
    });
  }
  return {
    orgId: input.orgId,
    offerings,
    canEdit: input.canEdit,
    canEditReviewer: input.canEditReviewer,
    // W09: one entry per (surface, role), merged with selectRoleRows exactly as
    // the resolver merges it (D2), so the view never disagrees with dispatch.
    surfaces: CONFIGURABLE_AI_SURFACE_ROLES.map(({ surface, role }) => {
      const picked = selectRoleRows([...partnerRows, ...orgRows].filter((r) => r.surface === surface), role);
      const eff = mergeEffectiveAssignment({ surface, role, ...picked });
      const p = picked.partner;
      const own = orgRows.find((r) => r.surface === surface && r.role === role) ?? null;
      return {
        surface,
        role,
        requiresTools: TOOL_SURFACES.has(surface),
        inherited: {
          defaultOfferingId: p?.defaultOfferingId ?? null,
          permittedOfferingIds: p?.permittedOfferingIds ?? null,
          allowUserChoice: p?.allowUserChoice ?? true,
          options: (p?.options ?? {}) as OfferingOptions,
          fallbackOfferingIds: [...(p?.fallbackOfferingIds ?? [])],
          fallbackMayCrossFunding: p?.fallbackMayCrossFunding ?? false,
        },
        org: own && assignmentRowDto(own),
        effective: {
          defaultOfferingId: eff.defaultOfferingId,
          defaultSource: eff.defaultSource,
          permittedOfferingIds: eff.permitted.kind === 'all' ? null : [...eff.permitted.offeringIds],
          allowUserChoice: eff.allowUserChoice,
          options: eff.options,
          fallbackOfferingIds: [...eff.fallbackOfferingIds],
          fallbackMayCrossFunding: eff.fallbackMayCrossFunding,
        },
      };
    }),
  };
}
