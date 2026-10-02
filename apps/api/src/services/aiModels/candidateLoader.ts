/**
 * The ONE adapter between W01/W02 row shapes and the resolver. Everything is
 * read LIVE on every call: the key is decrypted, the catalog revision is
 * re-listed and the platform row is re-read, so a rotation, a delisting or an
 * un-offer takes effect on the very next dispatch (quorum #2, #7). No caching.
 * No writes. A foreign or missing offering is indistinguishable (null).
 */
import { eq } from 'drizzle-orm';
import {
  emptyOptionSupport,
  isGatewayConnectionKind,
  type AiSurface,
  type GatewayConnectionKind,
  type EffortLevel,
  type OfferingOptions,
  type OptionRates,
  type OptionSupport,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiSessions, organizations, partners } from '../../db/schema';
import { legacyWireProfile } from '../aiModel';
import { isPlatformLlmConfigured } from '../llm/llmAvailability';
import {
  buildCatalogEndpointSnapshot,
  isLlmProviderCatalogEnabled,
  type UsableLlmConfig,
} from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import { getUserPermissions, hasPermission } from '../permissions';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException } from '../sentry';
import type { AiBillingSource } from '../aiCostTracker';
import { getEffectiveAssignment } from './assignments';
import { deriveCapabilities, type DerivedCapabilities } from './capabilities';
import {
  decryptConnectionKey,
  getConnection,
  getConnectionKeyMaterial,
  type PartnerAiConnection,
} from './connections';
import type { CandidateFacts, ConnectionKind, PartnerPlan } from './eligibility';
import { PARTNER_PLAN_ORDER } from './eligibility';
import type { GatewayConnectionConfig, GatewayCredential } from './gateway/types';
import { gatewayCandidate } from './gatewayCandidate';
import { findOfferingIdForModel, getOffering, type Offering } from './offerings';
import {
  effectivePlatformInferenceGeos,
  getPlatformDefaultModel,
  getPlatformInferenceGeo,
  getPlatformModelById,
  getPlatformModelByModelId,
  type PlatformModel,
} from './platformModels';
import type { RateSnapshot } from './pricing';
import { toPromptProfile, type PromptProfile } from './promptProfiles';
import { safeErrorMessage } from './safeDbError';

/**
 * The dispatchable connection a candidate resolved to. Anthropic-dialect kinds
 * carry a UsableLlmConfig (key inside, as before). Gateway kinds (W06) carry a
 * `source: 'gateway'` config plus the decrypted credential SEPARATELY: the
 * credential is handed only to the loopback model gateway's grant, never to an
 * SDK child env, a log line, a persisted binding or an error message.
 */
export type ResolvedConnection =
  | { id: string | null; kind: Exclude<ConnectionKind, GatewayConnectionKind>; config: UsableLlmConfig }
  | { id: string; kind: GatewayConnectionKind; config: GatewayConnectionConfig; credential: GatewayCredential };

export type GatewayResolvedConnection = Extract<ResolvedConnection, { kind: GatewayConnectionKind }>;

export interface AllowedOptions {
  effort?: EffortLevel[];
  thinkingDisplay?: OptionSupport['thinkingDisplay'];
  speed?: OptionSupport['speed'];
}

export interface LoadedCandidate {
  facts: CandidateFacts;
  offeringId: string | null;
  connectionId: string | null;
  displayName: string;
  logicalModel: string;
  wireModel: string;
  connection: ResolvedConnection | null;
  funding: AiBillingSource;
  capabilities: DerivedCapabilities;
  optionSupport: OptionSupport;
  optionRates: OptionRates | null;
  defaultOptions: Partial<OfferingOptions> | null;
  allowedOptions: AllowedOptions | null;
  refusalFallbackOfferingId: string | null;
  promptProfile: PromptProfile;
  limits: { maxInputTokens: number | null; maxOutputTokens: number | null };
  catalogRevisionId?: string;
  configVersion?: number;
}

/** W01's empty support: nothing selectable, `speed` is always at least `standard`. */
export const EMPTY_OPTION_SUPPORT: OptionSupport = Object.freeze(emptyOptionSupport()) as OptionSupport;

export const UNVERIFIED_CAPABILITIES: DerivedCapabilities = {
  thinkingMode: 'unknown',
  effortLevels: [],
  supportsTools: false,
  supportsVision: false,
};

/** The thinking options the W00 rules made selectable; null when the tree itself decided. */
type LegacyThinkingSupport = Pick<OptionSupport, 'effort' | 'thinkingDisplay'> | null;

/**
 * Capabilities of a candidate on an ANTHROPIC connection (platform key,
 * anthropic_byok, catalog; never openai_compatible). A tree that derives to
 * `unknown` (null on a manual offering, an Office-allowlisted dated id, or the
 * env-bootstrapped platform row) is resolved exactly as legacy ran that id:
 *  - tool use: true (W01 D4: every Claude model the Models API lists has it;
 *    legacy sent tools to every Anthropic destination);
 *  - thinking/effort: the W00 rules keyed on the WIRE id (legacyWireProfile),
 *    which is what agentSdkWireOptions sent for an unregistered id.
 * A recognisable tree always wins, including an explicit `tool_use: false`.
 */
function anthropicCapabilities(raw: unknown, wireModel: string): { capabilities: DerivedCapabilities; legacySupport: LegacyThinkingSupport } {
  const derived = deriveCapabilities(raw);
  if (derived.thinkingMode !== 'unknown') return { capabilities: derived, legacySupport: null };
  const legacy = legacyWireProfile(wireModel);
  return {
    capabilities: {
      thinkingMode: legacy.thinkingMode,
      effortLevels: [...legacy.optionSupport.effort],
      supportsTools: true,
      supportsVision: derived.supportsVision,
    },
    legacySupport: { effort: [...legacy.optionSupport.effort], thinkingDisplay: [...legacy.optionSupport.thinkingDisplay] },
  };
}

function systemRead<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function fourRates(
  i: number | null | undefined,
  o: number | null | undefined,
  cr: number | null | undefined,
  cw: number | null | undefined,
): RateSnapshot['standard'] | null {
  if (i == null || o == null || cr == null || cw == null) return null;
  return {
    inputCentsPerM: Number(i),
    outputCentsPerM: Number(o),
    cacheReadCentsPerM: Number(cr),
    cacheWriteCentsPerM: Number(cw),
  };
}

/** W01: `rates` is all four standard rates, or null when any is unset (unpriced). */
function platformRate(row: PlatformModel): RateSnapshot['standard'] | null {
  return row.rates ?? null;
}

/**
 * W01 deferred finding: `fast` is selectable only where a `speed:fast` rate
 * exists for THIS candidate (§8: a variant with no rate is not selectable).
 * A row that claims fast support without the rate loses it here, so
 * neither the resolver nor the wire builder can ever pick an unpriced fast.
 */
function withPricedSpeeds(support: OptionSupport, optionRates: OptionRates | null): OptionSupport {
  const fastPriced = Boolean(optionRates?.['speed:fast']);
  return fastPriced ? support : { ...support, speed: support.speed.filter((s) => s !== 'fast') };
}

function asPlan(value: string | null | undefined): PartnerPlan | null {
  return (PARTNER_PLAN_ORDER as readonly string[]).includes(value ?? '') ? (value as PartnerPlan) : null;
}

/**
 * W04 (#7602, BD-4): capabilities and selectable options of a platform row as
 * the platform key serves it: unknown trees resolved like legacy (tools true),
 * unrated fast stripped, geographies limited to the platform key's. Pure; the
 * registry snapshot uses it for not-yet-added rows so they show exactly what
 * the loaded offering will.
 */
export function platformModelView(row: PlatformModel): { capabilities: DerivedCapabilities; optionSupport: OptionSupport } {
  const { capabilities, legacySupport } = anthropicCapabilities(row.capabilities, row.modelId);
  // W01 D3: the platform key serves only PLATFORM_KEY_INFERENCE_GEOS; the
  // same effective list feeds eligibility AND wire params, so they agree.
  return {
    capabilities,
    optionSupport: {
      ...withPricedSpeeds(row.optionSupport, row.optionRates ?? null),
      ...(legacySupport ?? {}),
      inferenceGeo: effectivePlatformInferenceGeos(row.optionSupport.inferenceGeo),
    },
  };
}

/**
 * W04 (#7602, ruling BD-1): eligibility facts for a platform model the partner
 * has not added yet (registry snapshot / add-and-enable). Pure: the caller
 * awaits getPlatformInferenceGeo() and passes it in. Built from the SAME
 * helpers as platformCandidate below (effective platform-key geographies,
 * plan, rate, capabilities), so a synthesized row gets the same enable verdict
 * as the loaded offering, including W03's platform-geo `residency_unavailable`.
 * Connection health is reported as usable: the enable gate neutralises it.
 */
export function platformCandidateFacts(
  partnerId: string,
  row: PlatformModel,
  platformInferenceGeo: string | null,
): CandidateFacts {
  const standard = platformRate(row);
  return {
    ownerPartnerId: partnerId,
    enabled: false,
    lifecycle: 'available',
    requiredPermission: null,
    platform: { platformOffered: row.platformOffered, lifecycle: row.lifecycle, minPlan: asPlan(row.minPlan) },
    connection: { kind: 'platform', status: 'active', keyUsable: true },
    catalog: null,
    rate: standard ? { source: 'platform', standard } : null,
    supportsTools: platformModelView(row).capabilities.supportsTools,
    inferenceGeo: platformInferenceGeo,
    supportedInferenceGeos: effectivePlatformInferenceGeos(row.optionSupport.inferenceGeo),
  };
}

/** Platform offering, or the partnerless system candidate (patch_test). */
async function platformCandidate(
  row: PlatformModel,
  offering: Offering | null,
): Promise<LoadedCandidate> {
  const platformGeo = await systemRead(() => getPlatformInferenceGeo());
  // Anthropic credentials only ('agent_sdk' transport): an MCP_LLM_*
  // OpenAI-compatible endpoint is an env-managed gateway connection with its
  // own offerings (envOpenAiBootstrap.ts), never a platform offering, and must
  // never make a platform Claude model look dispatchable.
  const configured = isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk');
  const standard = platformRate(row);
  const config: UsableLlmConfig = { source: 'platform', apiKey: process.env.ANTHROPIC_API_KEY, model: row.modelId };
  const { capabilities, optionSupport } = platformModelView(row);
  const optionRates = row.optionRates ?? null;
  const inferenceGeos = optionSupport.inferenceGeo;
  return {
    facts: {
      ownerPartnerId: offering?.partnerId ?? null,
      enabled: offering ? offering.enabled : true,
      // The partnerless platform default has no offering row; its lifecycle is
      // the platform row's (getPlatformDefaultModel does not filter on it).
      lifecycle: offering ? offering.lifecycle : row.lifecycle,
      requiredPermission: offering?.requiredPermission ?? null,
      platform: { platformOffered: row.platformOffered, lifecycle: row.lifecycle, minPlan: asPlan(row.minPlan) },
      connection: { kind: 'platform', status: configured ? 'active' : 'unconfigured', keyUsable: configured },
      catalog: null,
      rate: standard ? { source: 'platform', standard } : null,
      supportsTools: capabilities.supportsTools,
      inferenceGeo: platformGeo,
      supportedInferenceGeos: inferenceGeos,
    },
    offeringId: offering?.id ?? null,
    connectionId: null,
    displayName: offering?.displayName ?? row.displayName,
    logicalModel: row.modelId,
    wireModel: row.modelId,
    connection: configured ? { id: null, kind: 'platform', config } : null,
    funding: 'platform',
    capabilities,
    optionSupport,
    optionRates,
    defaultOptions: (offering?.defaultOptions as Partial<OfferingOptions> | null) ?? null,
    allowedOptions: (offering?.allowedOptions as AllowedOptions | null) ?? null,
    refusalFallbackOfferingId: offering?.refusalFallbackOfferingId ?? null,
    promptProfile: toPromptProfile(row.promptProfile),
    limits: { maxInputTokens: row.maxInputTokens ?? null, maxOutputTokens: row.maxOutputTokens ?? null },
  };
}

async function connectionCandidate(offering: Offering, conn: PartnerAiConnection): Promise<LoadedCandidate> {
  // W06: gateway kinds never read the linked platform row (no price or
  // capability inheritance) and take their capabilities only from verification.
  if (isGatewayConnectionKind(conn.kind)) return gatewayCandidate({ offering, conn });
  const linked = offering.platformModelId
    ? await systemRead(() => getPlatformModelById(offering.platformModelId!))
    : null;
  const logicalModel = offering.modelId ?? linked?.modelId ?? '';
  const platformGeo = await systemRead(() => getPlatformInferenceGeo());
  const offeringRate = fourRates(
    offering.priceInputCentsPerM,
    offering.priceOutputCentsPerM,
    offering.priceCacheReadCentsPerM,
    offering.priceCacheWriteCentsPerM,
  );

  // PartnerAiConnection carries no key material (W02); fetch it separately.
  // A LOOKUP failure is infrastructure (DB), not a dead key: answering it as
  // key_error would tell the partner to reconnect a working connection
  // (review S6). It throws, like every other read in this loader, scrubbed.
  let material: Awaited<ReturnType<typeof getConnectionKeyMaterial>>;
  try {
    material = await systemRead(() => getConnectionKeyMaterial(conn.id));
  } catch (error) {
    const scrubbed = new Error(`AI connection key lookup failed: ${safeErrorMessage(error)}`);
    captureException(scrubbed, undefined, { service: 'candidateLoader', partner_id: conn.partnerId });
    throw scrubbed;
  }
  let apiKey: string | null = null;
  try {
    apiKey = material ? decryptConnectionKey(material) : null;
  } catch (error) {
    // Undecryptable key material IS a key error: keyUsable false.
    if (error instanceof SecretKeyMaterialError) {
      captureException(error, undefined, { service: 'candidateLoader', partner_id: conn.partnerId });
    } else {
      console.warn('[candidateLoader] connection key could not be decrypted; treated as unusable', {
        connectionId: conn.id, error: safeErrorMessage(error),
      });
    }
    apiKey = null;
  }

  let catalogFacts: CandidateFacts['catalog'] = null;
  let config: UsableLlmConfig | null = null;
  let wireModel = logicalModel;
  let rate: RateSnapshot | null = offeringRate ? { source: 'offering', standard: offeringRate } : null;
  let capabilities: DerivedCapabilities;
  let optionSupport: OptionSupport;
  let optionRates: OptionRates | null = null;
  let promptProfile: PromptProfile;
  let catalogRevisionId: string | undefined;
  const limits = {
    maxInputTokens: linked?.maxInputTokens ?? null,
    maxOutputTokens: linked?.maxOutputTokens ?? null,
  };

  if (conn.kind === 'catalog') {
    const provider = isLlmProviderCatalogEnabled() && conn.catalogEntryId
      ? await systemRead(() => getListedProviderByEntryId(conn.catalogEntryId!))
      : null;
    const endpoint = provider ? buildCatalogEndpointSnapshot(provider, logicalModel) : null;
    catalogFacts = { usable: endpoint !== null };
    if (endpoint) {
      wireModel = endpoint.providerModel;
      catalogRevisionId = endpoint.revisionId;
      if (!rate) {
        rate = {
          source: 'catalog',
          standard: {
            inputCentsPerM: endpoint.pricing.inputCentsPerM,
            outputCentsPerM: endpoint.pricing.outputCentsPerM,
            cacheReadCentsPerM: endpoint.pricing.cacheReadCentsPerM,
            cacheWriteCentsPerM: endpoint.pricing.cacheWriteCentsPerM,
          },
        };
      }
      if (apiKey !== null) {
        config = {
          source: 'partner', partnerId: conn.partnerId, apiKey, model: logicalModel,
          configId: conn.id, configVersion: conn.configVersion, endpoint,
        };
      }
    }
    // A catalog revision's harness pass proves tool-call fidelity. Thinking and
    // effort follow the W00 rules on the catalog WIRE id, as legacy sent them
    // (an id they do not know stays `unknown`: nothing sent).
    const legacyThinking = anthropicCapabilities(null, wireModel);
    capabilities = { ...legacyThinking.capabilities, supportsTools: endpoint !== null };
    optionSupport = { ...EMPTY_OPTION_SUPPORT, ...legacyThinking.legacySupport };
    const sameIdRow = await systemRead(() => getPlatformModelByModelId(logicalModel));
    promptProfile = toPromptProfile(sameIdRow?.promptProfile);
  } else {
    // anthropic_byok (gateway kinds returned above; W06).
    if (!rate && linked) {
      const linkedStandard = platformRate(linked);
      if (linkedStandard) rate = { source: 'linked_platform', standard: linkedStandard };
    }
    const raw = linked ? linked.capabilities : offering.capabilities;
    let legacySupport: LegacyThinkingSupport = null;
    if (conn.kind === 'anthropic_byok') {
      ({ capabilities, legacySupport } = anthropicCapabilities(raw, wireModel));
    } else {
      capabilities = raw ? deriveCapabilities(raw) : UNVERIFIED_CAPABILITIES;
    }
    // Option rates only when the standard rate is the linked platform row's:
    // an admin-entered offering price has no fast-mode variant, so fast is not
    // selectable on it (§8 "a variant with no rate is not selectable").
    optionRates = rate?.source === 'linked_platform' ? linked?.optionRates ?? null : null;
    optionSupport = withPricedSpeeds({
      ...(linked ? linked.optionSupport : { ...EMPTY_OPTION_SUPPORT, effort: capabilities.effortLevels }),
      ...(legacySupport ?? {}),
    }, optionRates);
    promptProfile = toPromptProfile(linked?.promptProfile);
    if (apiKey !== null && conn.kind === 'anthropic_byok') {
      config = {
        source: 'partner', partnerId: conn.partnerId, apiKey, model: logicalModel,
        configId: conn.id, configVersion: conn.configVersion, endpoint: { kind: 'anthropic' },
      };
    }
  }

  return {
    facts: {
      ownerPartnerId: offering.partnerId,
      enabled: offering.enabled,
      lifecycle: offering.lifecycle,
      requiredPermission: offering.requiredPermission,
      platform: null,
      connection: { kind: conn.kind as ConnectionKind, status: conn.status, keyUsable: apiKey !== null },
      catalog: catalogFacts,
      rate,
      supportsTools: capabilities.supportsTools,
      inferenceGeo: conn.inferenceGeo ?? platformGeo,
      supportedInferenceGeos: optionSupport.inferenceGeo,
    },
    offeringId: offering.id,
    connectionId: conn.id,
    displayName: offering.displayName ?? linked?.displayName ?? logicalModel,
    logicalModel,
    wireModel,
    connection: config ? { id: conn.id, kind: conn.kind as 'anthropic_byok' | 'catalog', config } : null,
    funding: 'partner_key',
    capabilities,
    optionSupport,
    optionRates,
    defaultOptions: offering.defaultOptions as Partial<OfferingOptions> | null,
    allowedOptions: offering.allowedOptions as AllowedOptions | null,
    refusalFallbackOfferingId: offering.refusalFallbackOfferingId,
    promptProfile,
    limits,
    catalogRevisionId,
    configVersion: conn.configVersion,
  };
}

export async function loadOfferingCandidate(offeringId: string, partnerId: string): Promise<LoadedCandidate | null> {
  const offering = await systemRead(() => getOffering(offeringId));
  if (!offering || offering.partnerId !== partnerId) return null;
  if (offering.connectionId === null) {
    if (!offering.platformModelId) return null;
    const row = await systemRead(() => getPlatformModelById(offering.platformModelId!));
    return row ? platformCandidate(row, offering) : null;
  }
  const conn = await systemRead(() => getConnection(offering.connectionId!));
  if (!conn || conn.partnerId !== partnerId) return null;
  return connectionCandidate(offering, conn);
}

export async function loadPlatformDefaultCandidate(): Promise<LoadedCandidate | null> {
  const row = await systemRead(() => getPlatformDefaultModel());
  return row ? platformCandidate(row, null) : null;
}

export async function loadPartnerFacts(partnerId: string): Promise<{ plan: PartnerPlan; residencyRequired: boolean }> {
  const [row] = await systemRead(() => db
    .select({ plan: partners.plan, settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1));
  const settings = (row?.settings ?? {}) as { ai?: { residencyRequired?: unknown } };
  return {
    plan: asPlan(row?.plan) ?? 'free',
    residencyRequired: settings.ai?.residencyRequired === true,
  };
}

export async function loadUserPermissionPredicate(
  userId: string,
  partnerId: string | null,
  orgId: string | null,
): Promise<(key: string) => boolean> {
  const perms = await getUserPermissions(userId, {
    ...(partnerId ? { partnerId } : {}),
    ...(orgId ? { orgId } : {}),
  });
  return (key: string) => {
    if (!perms) return false;
    const [resource, action, extra] = key.split(':');
    if (!resource || !action || extra !== undefined) return false;
    return hasPermission(perms, resource, action);
  };
}

/**
 * A legacy model string → the enabled offering with that model on the
 * surface's effective DEFAULT connection (review finding 11). The same id on
 * another connection (platform vs BYOK) would silently change destination and
 * funding, so it is never picked: no match → null (caller: invalid_model).
 * The lookup is W02's connection-scoped `findOfferingIdForModel` (W02 Task 8),
 * which W02's per-connection unique indexes make unambiguous.
 */
export async function findOfferingIdByModel(input: {
  partnerId: string; orgId: string | null; surface: AiSurface; modelId: string;
}): Promise<string | null> {
  const assignment = await systemRead(() => getEffectiveAssignment({
    partnerId: input.partnerId, orgId: input.orgId, surface: input.surface, role: 'default',
  }));
  if (!assignment.defaultOfferingId) return null;
  const def = await systemRead(() => getOffering(assignment.defaultOfferingId!));
  if (!def || def.partnerId !== input.partnerId) return null;
  const id = await systemRead(() => findOfferingIdForModel({
    partnerId: input.partnerId, connectionId: def.connectionId, modelId: input.modelId,
  }));
  if (!id) return null;
  const offering = await systemRead(() => getOffering(id));
  return offering?.enabled ? id : null;
}

export async function readOrgPartnerId(orgId: string): Promise<string | null> {
  const [row] = await systemRead(() => db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1));
  return row?.partnerId ?? null;
}

/** The stored model choice of a session (W02 columns, P11); the only ai_sessions read the resolver makes. */
export async function readSessionModelRow(
  sessionId: string,
): Promise<{
  orgId: string;
  offeringId: string | null;
  options: Partial<OfferingOptions> | null;
  /** W09 (D5): history the SDK would resume (turns run, or a persisted SDK transcript). */
  turnCount: number;
  sdkSessionId: string | null;
} | null> {
  const [row] = await systemRead(() => db
    .select({
      orgId: aiSessions.orgId, offeringId: aiSessions.offeringId, options: aiSessions.options,
      turnCount: aiSessions.turnCount, sdkSessionId: aiSessions.sdkSessionId,
    })
    .from(aiSessions)
    .where(eq(aiSessions.id, sessionId))
    .limit(1));
  return row
    ? {
        orgId: row.orgId,
        offeringId: row.offeringId ?? null,
        options: (row.options ?? null) as Partial<OfferingOptions> | null,
        turnCount: Number(row.turnCount ?? 0),
        sdkSessionId: row.sdkSessionId ?? null,
      }
    : null;
}
