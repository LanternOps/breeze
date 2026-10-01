/**
 * Backs resolveModel's data adapters with W02's materialized RegistrySnapshot
 * for one parity fixture (#7601 Task 7, P13). The ONE file coupled to the
 * snapshot's shape. Fields the snapshot does not carry are filled with the
 * values W02's reconcile (legacyReconcile.ts) actually writes for that row:
 *  - a platform row the fixture lists is a seeded row: offered iff priced,
 *    priced at the legacy rate table, a Models API tree with tool use;
 *  - a platform row the projection BOOTSTRAPS (no fixture row) is what
 *    ensureLegacyPlatformModel inserts: not offered, unpriced, no capabilities;
 *  - a connection offering carries the reconcile's price (legacy rates when
 *    no priced platform row links it, else none) and no capabilities;
 *  - offerings are available, need no permission and have no refusal fallback.
 * The connection key is the legacy row's ciphertext, decrypted for real.
 */
import { emptyOptionSupport } from '@breeze/shared';
import { getLegacyModelRates } from '../../aiCostTracker';
import type { ListedProvider } from '../../llmProviderCatalog';
import { mergeEffectiveAssignment, type EffectiveAssignment } from '../assignments';
import type { PartnerAiConnection } from '../connections';
import { buildDesiredRegistryState } from '../legacyProjection';
import type { Offering } from '../offerings';
import type { PlatformModel } from '../platformModels';
import { bindLegacyFixture } from './bindLegacyFixture';
import type { ParityFixture } from './harness';
import { projectionEnvFor } from './projectionEnv';
import { materializeDesiredState, type RegistrySnapshot } from './storeProjection';

/** The same projection W02's parity.test.ts materializes for this fixture (incl. the sealed legacy key). */
export function storeFor(fixture: ParityFixture): RegistrySnapshot {
  const sealed = bindLegacyFixture(fixture);
  const desired = buildDesiredRegistryState(fixture.snapshot, projectionEnvFor(fixture));
  return materializeDesiredState(desired, fixture, fixture.snapshot.config ? sealed : null);
}

/** A Models API capabilities tree that derives tool use and no thinking (capabilities.ts). */
const SEEDED_CAPABILITIES = Object.freeze({ thinking: { supported: false } });
const EPOCH = new Date(0);

export interface SnapshotDeps {
  getOffering(id: string): Promise<Offering | null>;
  getConnection(id: string): Promise<PartnerAiConnection | null>;
  getConnectionKeyMaterial(id: string): Promise<{ id: string; partnerId: string; apiKeyEncrypted: string | null } | null>;
  getPlatformModelById(id: string): Promise<PlatformModel | null>;
  getPlatformModelByModelId(modelId: string): Promise<PlatformModel | null>;
  getListedProviderByEntryId(entryId: string): Promise<ListedProvider | null>;
  getEffectiveAssignment(input: { partnerId: string; orgId: string | null; surface: string; role?: string }): Promise<EffectiveAssignment>;
  loadPartnerFacts(partnerId: string): Promise<{ plan: 'unlimited'; residencyRequired: false }>;
  readOrgPartnerId(orgId: string): Promise<string | null>;
  readSessionModelRow(sessionId: string): Promise<{ orgId: string; offeringId: string | null; options: null } | null>;
}

export function snapshotDeps(store: RegistrySnapshot, fixture: ParityFixture): SnapshotDeps {
  const seeded = new Map(fixture.snapshot.platformModels.map((m) => [m.modelId, m]));

  const platformRow = (pm: RegistrySnapshot['platformModels'][number]): PlatformModel => {
    const seed = seeded.get(pm.modelId);
    const priced = seed?.priced === true;
    return {
      id: pm.id, provider: 'anthropic', modelId: pm.modelId, displayName: pm.modelId,
      maxInputTokens: null, maxOutputTokens: null,
      capabilities: seed ? SEEDED_CAPABILITIES : null,
      rates: priced ? getLegacyModelRates(pm.modelId).rates : null,
      optionRates: null, optionSupport: emptyOptionSupport(),
      minPlan: null, promptProfile: 'generic', platformOffered: priced, isPlatformDefault: false,
      lifecycle: 'available', missedSyncCount: 0, operatorNotifiedAt: null,
      firstSeenAt: EPOCH, lastSeenAt: null, updatedAt: EPOCH,
    };
  };

  const conn = (id: string | null) => store.connections.find((c) => c.id === id) ?? null;

  const offering = (o: RegistrySnapshot['offerings'][number]): Offering => {
    const c = conn(o.connectionId);
    const linked = o.platformModelId ? store.platformModels.find((p) => p.id === o.platformModelId) : undefined;
    const linkedPriced = linked ? seeded.get(linked.modelId)?.priced === true : false;
    // legacyProjection onConnection: price = legacy rates unless a PRICED platform row links it; catalog: none.
    const price = c !== null && c.kind !== 'catalog' && !linkedPriced && o.modelId ? getLegacyModelRates(o.modelId).rates : null;
    return {
      id: o.id, partnerId: store.partnerId, connectionId: o.connectionId, platformModelId: o.platformModelId, modelId: o.modelId,
      source: c === null ? 'platform' : c.kind === 'catalog' ? 'catalog' : linked ? 'discovered' : 'manual',
      displayName: null, capabilities: null,
      priceInputCentsPerM: price?.inputCentsPerM ?? null, priceOutputCentsPerM: price?.outputCentsPerM ?? null,
      priceCacheReadCentsPerM: price?.cacheReadCentsPerM ?? null, priceCacheWriteCentsPerM: price?.cacheWriteCentsPerM ?? null,
      enabled: o.enabled, defaultOptions: null, allowedOptions: null, requiredPermission: null,
      refusalFallbackOfferingId: null, lifecycle: 'available', createdAt: EPOCH, updatedAt: EPOCH,
    } as Offering;
  };

  const assignmentRow = (orgId: string | null, surface: string) =>
    store.assignments.find((a) => a.orgId === orgId && a.surface === surface) ?? null;

  return {
    getOffering: async (id) => {
      const o = store.offerings.find((x) => x.id === id);
      return o ? offering(o) : null;
    },
    getConnection: async (id) => {
      const c = conn(id);
      return c ? {
        id: c.id, partnerId: store.partnerId, kind: c.kind, name: c.kind, inferenceGeo: null, providerConfig: null,
        keyLast4: null, catalogEntryId: c.kind === 'catalog' ? fixture.snapshot.config?.catalogEntryId ?? null : null,
        baseUrl: null, status: c.status, lastError: null, verifiedAt: null, configVersion: 1, connectedBy: null,
        lastDiscoveredAt: null, discoveryError: null, legacyDefaultModel: fixture.snapshot.config?.defaultModel ?? null,
        createdAt: EPOCH, updatedAt: EPOCH,
      } as PartnerAiConnection : null;
    },
    getConnectionKeyMaterial: async (id) => {
      const c = conn(id);
      return c ? { id: c.id, partnerId: store.partnerId, apiKeyEncrypted: c.apiKeyEncrypted } : null;
    },
    getPlatformModelById: async (id) => {
      const pm = store.platformModels.find((p) => p.id === id);
      return pm ? platformRow(pm) : null;
    },
    getPlatformModelByModelId: async (modelId) => {
      const pm = store.platformModels.find((p) => p.modelId === modelId);
      return pm ? platformRow(pm) : null;
    },
    getListedProviderByEntryId: async (entryId) =>
      (store.catalogProvider?.entryId === entryId ? store.catalogProvider : null),
    getEffectiveAssignment: async (input) => mergeEffectiveAssignment({
      surface: input.surface as never,
      role: input.role ?? 'default',
      partner: assignmentRow(null, input.surface),
      org: input.orgId ? assignmentRow(input.orgId, input.surface) : null,
    }),
    loadPartnerFacts: async () => ({ plan: 'unlimited', residencyRequired: false }),
    readOrgPartnerId: async (orgId) => (fixture.snapshot.orgIds.includes(orgId) ? store.partnerId : null),
    readSessionModelRow: async (id) => {
      const s = store.sessions.find((x) => x.id === id);
      const live = fixture.snapshot.liveSessions.find((x) => x.id === id);
      return s && live ? { orgId: live.orgId, offeringId: s.offeringId, options: null } : null;
    },
  };
}
