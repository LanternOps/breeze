/**
 * Registry semantics for one surface, over a store snapshot: effective
 * assignment (tighten-only merge), the stored binding (agent policy / session),
 * W03's permitted check for explicit policy models (spec §5.6), connection
 * status, and catalog binding. Pure. W02 feeds it the materialized projection;
 * W03 swaps in resolveModel.
 */
import type { ListedProvider } from '../../llmProviderCatalog';
import { decryptConnectionKey } from '../connections';
import { mergeEffectiveAssignment, isPermitted, type AssignmentRowInput } from '../assignments';
import type { DesiredRegistryState } from '../legacyProjection';
import type { ParityFixture, ParityQuery, SurfaceUse } from './harness';

export interface RegistrySnapshot {
  partnerId: string;
  connections: ReadonlyArray<{ id: string; kind: 'anthropic_byok' | 'catalog'; status: 'active' | 'error'; apiKeyEncrypted: string | null }>;
  offerings: ReadonlyArray<{ id: string; connectionId: string | null; modelId: string | null; platformModelId: string | null; enabled: boolean }>;
  platformModels: ReadonlyArray<{ id: string; modelId: string }>;
  assignments: ReadonlyArray<AssignmentRowInput & { orgId: string | null; surface: string }>;
  agents: ReadonlyArray<{ id: string; kind: string; orgId: string | null; offeringId: string | null }>;
  sessions: ReadonlyArray<{ id: string; offeringId: string | null }>;
  catalogProvider: ListedProvider | null;
}

const unavailable = (reason: string): SurfaceUse => ({ outcome: 'unavailable', reason });

/**
 * Desired state → a snapshot shaped like the DB (ids = offering keys; bootstrap
 * platform rows get synthetic ids). `legacyKeyCiphertext` is the legacy row's
 * api_key_encrypted: the reconcile mirrors it byte-for-byte onto the connection.
 */
export function materializeDesiredState(desired: DesiredRegistryState, fixture: ParityFixture, legacyKeyCiphertext: string | null): RegistrySnapshot {
  const config = fixture.snapshot.config;
  const platformModels = [
    ...fixture.snapshot.platformModels.map((m) => ({ id: m.id, modelId: m.modelId })),
    ...desired.offerings.filter((o) => o.needsBootstrapPlatformRow).map((o) => ({ id: `bootstrap:${o.modelId}`, modelId: o.modelId })),
  ];
  return {
    partnerId: desired.partnerId,
    connections: config ? [{ id: config.id, kind: config.catalogEntryId ? 'catalog' : 'anthropic_byok', status: config.status, apiKeyEncrypted: legacyKeyCiphertext }] : [],
    offerings: desired.offerings.map((o) => ({
      id: o.key,
      connectionId: o.connectionId,
      modelId: o.connectionId ? o.modelId : null,
      platformModelId: o.connectionId ? o.platformModelId : (o.platformModelId ?? `bootstrap:${o.modelId}`),
      enabled: true,
    })),
    platformModels,
    assignments: desired.assignments.map((a, i) => ({
      id: `assignment-${i}`, role: a.role, orgId: a.orgId, surface: a.surface,
      defaultOfferingId: a.defaultOfferingKey, permittedOfferingIds: a.permittedOfferingKeys ? [...a.permittedOfferingKeys] : null,
      allowUserChoice: a.allowUserChoice, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: a.fallbackMayCrossFunding,
    })),
    agents: fixture.snapshot.agents.map((a) => ({ id: a.id, kind: a.kind, orgId: a.orgId, offeringId: desired.agentOfferingKeys[a.id] ?? null })),
    sessions: fixture.snapshot.liveSessions.map((x) => ({ id: x.id, offeringId: desired.sessionOfferingKeys[x.id] ?? null })),
    catalogProvider: fixture.catalogProvider,
  };
}

function resolveOffering(store: RegistrySnapshot, offeringId: string | null): SurfaceUse {
  if (!offeringId) return unavailable('no_default');
  const offering = store.offerings.find((o) => o.id === offeringId);
  if (!offering || !offering.enabled) return unavailable('offering_unavailable');
  if (offering.connectionId === null) {
    const platform = store.platformModels.find((m) => m.id === offering.platformModelId);
    if (!platform) return unavailable('platform_model_missing');
    return { outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: platform.modelId, wireModel: platform.modelId };
  }
  const connection = store.connections.find((c) => c.id === offering.connectionId);
  if (!connection || connection.status !== 'active') return unavailable('key_error');
  // An ACTIVE connection whose key does not decrypt is unusable (legacy:
  // resolveLlmConfig → key_error). The destination stays the connection —
  // never a silent fall-through to the platform key.
  try {
    decryptConnectionKey(connection);
  } catch {
    return unavailable('key_error');
  }
  const model = offering.modelId!;
  let wireModel = model;
  if (connection.kind === 'catalog') {
    const p = store.catalogProvider;
    if (!p || !Object.hasOwn(p.modelMap, model) || !p.verifiedModels.includes(model)) return unavailable('model_unverified');
    wireModel = p.modelMap[model]!.providerModel;
  }
  return { outcome: 'ok', destination: { connectionId: connection.id }, funding: 'partner_key', logicalModel: model, wireModel };
}

export function projectSurfaceUse(store: RegistrySnapshot, query: ParityQuery): SurfaceUse {
  if (query.kind === 'session') {
    return resolveOffering(store, store.sessions.find((x) => x.id === query.sessionId)?.offeringId ?? null);
  }
  const surface = query.kind === 'agent' ? 'ai_agents' : query.surface;
  const effective = mergeEffectiveAssignment({
    surface,
    role: 'default',
    partner: store.assignments.find((a) => a.orgId === null && a.surface === surface) ?? null,
    org: store.assignments.find((a) => a.orgId === query.orgId && a.surface === surface) ?? null,
  });
  if (query.kind === 'agent') {
    const partnerAgent = store.agents.find((a) => a.orgId === null && a.kind === query.agentKind);
    const orgAgent = store.agents.find((a) => a.orgId === query.orgId && a.kind === query.agentKind);
    const offeringId = orgAgent?.offeringId ?? partnerAgent?.offeringId ?? effective.defaultOfferingId;
    if (offeringId && !isPermitted(effective.permitted, offeringId)) return unavailable('not_permitted');
    return resolveOffering(store, offeringId);
  }
  return resolveOffering(store, effective.defaultOfferingId);
}
