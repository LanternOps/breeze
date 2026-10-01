/**
 * The W02 projection: legacy config + env → the registry state that makes
 * every AI surface keep today's destination, funding source and model
 * (spec §10, quorum #3). Pure. Applied by legacyReconcile.ts; checked against
 * the REAL legacy code by parity/parity.test.ts. Deleted in W08 with the
 * legacy tables.
 */
import { AI_SURFACES, type AiSurface, type ModelRates } from '@breeze/shared';
import { aiBudgets } from '../../db/schema/ai';
import { legacyAgentModel, legacyOfficeChatModel, legacyReviewerModel } from './legacySurfaceModels';

export interface LegacyPartnerConfig {
  id: string;
  status: 'active' | 'error';
  defaultModel: string | null;
  catalogEntryId: string | null;
}
export interface LegacyPlatformModel { id: string; modelId: string; priced: boolean }
export interface LegacyAgentRow { id: string; kind: string; orgId: string | null; model: string | null }
export interface LegacySession { id: string; orgId: string; model: string }

export interface LegacySnapshot {
  partnerId: string;
  orgIds: readonly string[];
  config: LegacyPartnerConfig | null;
  platformModels: readonly LegacyPlatformModel[];
  partnerReviewerModel: string | null;
  orgReviewerModels: Readonly<Record<string, string | null>>;
  officeAllowedModels: Readonly<Record<string, readonly string[]>>;
  /** Live rows only (disabled_at IS NULL). */
  agents: readonly LegacyAgentRow[];
  /** Raw ai_budgets.allowed_models per org that HAS a budget row. */
  budgetAllowedModels: Readonly<Record<string, unknown>>;
  liveSessions: readonly LegacySession[];
}

export interface LegacyProjectionEnv {
  defaultModel: string;
  reviewerModel: string;
  extensionModel: string;
  legacyRates: (model: string) => ModelRates;
}

export type OfferingKey = string;

export interface DesiredOffering {
  key: OfferingKey;
  connectionId: string | null;
  modelId: string;
  source: 'platform' | 'discovered' | 'manual' | 'catalog';
  platformModelId: string | null;
  needsBootstrapPlatformRow: boolean;
  price: ModelRates | null;
}

export interface DesiredAssignment {
  orgId: string | null;
  surface: AiSurface;
  role: 'default';
  defaultOfferingKey: OfferingKey | null;
  permittedOfferingKeys: readonly OfferingKey[] | null;
  allowUserChoice: boolean | null;
  fallbackMayCrossFunding: boolean | null;
}

export interface DesiredRegistryState {
  partnerId: string;
  connectionId: string | null;
  offerings: readonly DesiredOffering[];
  assignments: readonly DesiredAssignment[];
  agentOfferingKeys: Readonly<Record<string, OfferingKey | null>>;
  sessionOfferingKeys: Readonly<Record<string, OfferingKey>>;
}

/** The ai_budgets.allowed_models column default, read from the schema (an org on it never customized its allowlist). */
export const LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT: readonly string[] = Object.freeze(
  [...((aiBudgets.allowedModels.default as string[] | undefined) ?? [])],
);

/** effectivePolicy.ts: `Array.isArray(budget?.allowedModels) ? … : null`. */
export function legacyBudgetAllowlist(raw: unknown): string[] | null {
  return Array.isArray(raw) ? (raw.filter((m): m is string => typeof m === 'string')) : null;
}

function isCustomizedAllowlist(list: readonly string[] | null): list is readonly string[] {
  if (list === null) return false;
  return !(list.length === LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT.length
    && list.every((m, i) => m === LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT[i]));
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function buildDesiredRegistryState(s: LegacySnapshot, env: LegacyProjectionEnv): DesiredRegistryState {
  const conn = s.config ? { id: s.config.id, catalog: s.config.catalogEntryId !== null } : null;
  const platformByModel = new Map(s.platformModels.map((m) => [m.modelId, m]));
  const offerings = new Map<OfferingKey, DesiredOffering>();

  const onPlatform = (modelId: string): OfferingKey => {
    const key = `platform:${modelId}`;
    if (!offerings.has(key)) {
      const row = platformByModel.get(modelId);
      offerings.set(key, {
        key, connectionId: null, modelId, source: 'platform',
        platformModelId: row?.id ?? null, needsBootstrapPlatformRow: !row, price: null,
      });
    }
    return key;
  };

  const onConnection = (connectionId: string, catalog: boolean, modelId: string): OfferingKey => {
    const key = `conn:${connectionId}:${modelId}`;
    if (!offerings.has(key)) {
      if (catalog) {
        offerings.set(key, { key, connectionId, modelId, source: 'catalog', platformModelId: null, needsBootstrapPlatformRow: false, price: null });
      } else {
        const row = platformByModel.get(modelId);
        offerings.set(key, {
          key, connectionId, modelId,
          source: row ? 'discovered' : 'manual',
          platformModelId: row?.id ?? null,
          needsBootstrapPlatformRow: false,
          price: row?.priced ? null : env.legacyRates(modelId),
        });
      }
    }
    return key;
  };

  const onPartnerDestination = (modelId: string): OfferingKey =>
    conn ? onConnection(conn.id, conn.catalog, modelId) : onPlatform(modelId);

  const P = s.config ? (s.config.defaultModel ?? env.defaultModel) : env.defaultModel;

  const partnerModel: Record<AiSurface, { key: () => OfferingKey; allowUserChoice: boolean }> = {
    chat: { key: () => onPartnerDestination(P), allowUserChoice: true },
    helper: { key: () => onPartnerDestination(P), allowUserChoice: false },
    script_builder: { key: () => onPartnerDestination(P), allowUserChoice: false },
    script_reviewer: { key: () => onPartnerDestination(legacyReviewerModel(s.partnerReviewerModel, env.reviewerModel)), allowUserChoice: false },
    office_chat: { key: () => onPartnerDestination(P), allowUserChoice: false },
    office_ticket: { key: () => onPartnerDestination(P), allowUserChoice: false },
    ai_agents: { key: () => onPartnerDestination(P), allowUserChoice: false },
    catalog_enrichment: { key: () => onPartnerDestination(P), allowUserChoice: false },
    extension_content: { key: () => onPartnerDestination(env.extensionModel), allowUserChoice: false },
    patch_test: { key: () => onPlatform(env.defaultModel), allowUserChoice: false },
  };

  const assignments: DesiredAssignment[] = AI_SURFACES.map((surface) => ({
    orgId: null,
    surface,
    role: 'default' as const,
    defaultOfferingKey: partnerModel[surface].key(),
    permittedOfferingKeys: null,
    allowUserChoice: partnerModel[surface].allowUserChoice,
    fallbackMayCrossFunding: false,
  }));

  // --- agents -------------------------------------------------------------
  const partnerAgents = s.agents.filter((a) => a.orgId === null);
  const agentOfferingKeys: Record<string, OfferingKey | null> = {};
  for (const a of partnerAgents) agentOfferingKeys[a.id] = a.model ? onPartnerDestination(a.model) : null;

  const orgIds = [...s.orgIds].sort();
  for (const orgId of orgIds) {
    const allowlist = Object.hasOwn(s.budgetAllowedModels, orgId) ? legacyBudgetAllowlist(s.budgetAllowedModels[orgId]) : null;
    const orgAgents = s.agents.filter((a) => a.orgId === orgId);
    const admitted = (model: string | null) => model !== null && allowlist !== null && allowlist.includes(model);
    for (const a of orgAgents) agentOfferingKeys[a.id] = admitted(a.model) ? onPartnerDestination(a.model!) : null;

    // script reviewer override
    const reviewer = Object.hasOwn(s.orgReviewerModels, orgId) ? s.orgReviewerModels[orgId] : null;
    if (reviewer) {
      assignments.push({ orgId, surface: 'script_reviewer', role: 'default', defaultOfferingKey: onPartnerDestination(reviewer), permittedOfferingKeys: null, allowUserChoice: null, fallbackMayCrossFunding: null });
    }

    // office chat policy
    const office = Object.hasOwn(s.officeAllowedModels, orgId) ? s.officeAllowedModels[orgId]! : [];
    if (office.length > 0) {
      assignments.push({
        orgId, surface: 'office_chat', role: 'default',
        defaultOfferingKey: onPartnerDestination(legacyOfficeChatModel(office, P)),
        permittedOfferingKeys: unique(office).map(onPartnerDestination),
        allowUserChoice: null, fallbackMayCrossFunding: null,
      });
    }

    // ai_budgets.allowed_models → ai_agents permitted set (customized orgs only)
    if (isCustomizedAllowlist(allowlist)) {
      const running = partnerAgents.map((partner) => {
        const override = orgAgents.find((a) => a.kind === partner.kind);
        const effective = override && admitted(override.model) ? override.model : partner.model;
        return legacyAgentModel(effective, P);
      });
      assignments.push({
        orgId, surface: 'ai_agents', role: 'default', defaultOfferingKey: null,
        permittedOfferingKeys: unique([...allowlist, ...running, P]).map(onPartnerDestination),
        allowUserChoice: null, fallbackMayCrossFunding: null,
      });
    }
  }

  // --- live sessions --------------------------------------------------------
  const sessionOfferingKeys: Record<string, OfferingKey> = {};
  for (const session of s.liveSessions) sessionOfferingKeys[session.id] = onPartnerDestination(session.model);

  return {
    partnerId: s.partnerId,
    connectionId: conn?.id ?? null,
    offerings: [...offerings.values()],
    assignments,
    agentOfferingKeys,
    sessionOfferingKeys,
  };
}
