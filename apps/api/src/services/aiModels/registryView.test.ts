import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  offerings: [] as Array<Record<string, unknown>>,
  candidates: new Map<string, unknown>(),
  facts: { plan: 'pro', residencyRequired: false } as { plan: string; residencyRequired: boolean },
  platformModels: [] as Array<Record<string, unknown>>,
  partnerRows: [] as Array<Record<string, unknown>>,
  orgRows: [] as Array<Record<string, unknown>>,
  allRows: [] as Array<Record<string, unknown>>,
  platformGeo: null as string | null,
  platformConfigured: true,
  platformConfiguredCalls: [] as unknown[][],
  catalogEnabled: false,
  providers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => h.allRows }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../config/env', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isHosted: () => true }));
vi.mock('../llm/llmAvailability', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPlatformLlmConfigured: (...args: unknown[]) => { h.platformConfiguredCalls.push(args); return h.platformConfigured; },
}));
vi.mock('../llm/llmConfigResolver', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isLlmProviderCatalogEnabled: () => h.catalogEnabled,
}));
vi.mock('../llmProviderCatalog', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getListedProviders: async () => h.providers,
}));
vi.mock('./candidateLoader', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadOfferingCandidate: vi.fn(async (id: string) => h.candidates.get(id) ?? null),
  loadPartnerFacts: vi.fn(async () => h.facts),
}));
vi.mock('./platformModels', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listPlatformModels: async () => h.platformModels,
  getPlatformInferenceGeo: async () => h.platformGeo,
}));
vi.mock('./connections', () => ({ listConnections: async () => h.connections }));
vi.mock('./offerings', () => ({
  listOfferings: async (_p: string, opts?: { enabledOnly?: boolean }) =>
    opts?.enabledOnly ? h.offerings.filter((o) => o.enabled) : h.offerings,
}));
vi.mock('./assignmentRows', () => ({
  listAssignmentRows: async (input: { orgId?: string | null }) => (input.orgId ? h.orgRows : h.partnerRows),
}));

import { buildCatalogSummary, buildOrgModelDefaults, buildPartnerModelsSnapshot } from './registryView';

const P = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const T = new Date('2026-10-01T00:00:00.000Z');

const conn = (o: Record<string, unknown>) => ({
  partnerId: P, name: 'x', inferenceGeo: null, providerConfig: null, keyLast4: '1234', catalogEntryId: null,
  baseUrl: null, status: 'active', lastError: null, verifiedAt: T, configVersion: 1, connectedBy: null,
  lastDiscoveredAt: null, discoveryError: null, legacyDefaultModel: null, createdAt: T, updatedAt: T,
  // Never read by the view: present to prove the DTO does not copy it through.
  apiKeyEncrypted: 'cipher', keyFingerprint: 'fp',
  ...o,
});

const pm = (o: Record<string, unknown>) => ({
  provider: 'anthropic', modelId: `model-${String(o.id)}`, displayName: `Model ${String(o.id)}`,
  maxInputTokens: 200_000, maxOutputTokens: 64_000,
  // A recognisable Models API tree with tool use.
  capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { low: { supported: true }, high: { supported: true } }, tool_use: { supported: true } },
  rates: RATES, optionRates: null,
  optionSupport: { effort: ['low', 'high'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
  minPlan: null, promptProfile: 'default', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
  missedSyncCount: 0, operatorNotifiedAt: null, firstSeenAt: T, lastSeenAt: T, updatedAt: T,
  ...o,
});

const offering = (o: Record<string, unknown>) => ({
  partnerId: P, connectionId: null, platformModelId: 'pm-x', modelId: null, source: 'platform', displayName: null,
  capabilities: null, priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null,
  priceCacheWriteCentsPerM: null, enabled: true, defaultOptions: null, allowedOptions: null, requiredPermission: null,
  refusalFallbackOfferingId: null, lifecycle: 'available', createdAt: T, updatedAt: T,
  ...o,
});

function candidateFor(o: Record<string, unknown>) {
  const platform = o.connectionId === null;
  return {
    facts: {
      ownerPartnerId: P, enabled: o.enabled ?? true, lifecycle: 'available', requiredPermission: null,
      platform: platform ? { platformOffered: true, lifecycle: 'available', minPlan: null } : null,
      connection: { kind: platform ? 'platform' : 'anthropic_byok', status: 'active', keyUsable: true },
      catalog: null, rate: { source: platform ? 'platform' : 'offering', standard: RATES },
      supportsTools: true, inferenceGeo: null, supportedInferenceGeos: platform ? ['us', 'global'] : ['eu'],
    },
    offeringId: o.id, connectionId: o.connectionId, displayName: `Offering ${String(o.id)}`, logicalModel: 'model-a',
    wireModel: 'model-a', connection: null, funding: platform ? 'platform' : 'partner_key',
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['low'], supportsTools: true, supportsVision: false },
    optionSupport: { effort: ['low'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: platform ? ['us', 'global'] : ['eu'] },
    optionRates: null, defaultOptions: null, allowedOptions: null, refusalFallbackOfferingId: null,
    promptProfile: 'default', limits: { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
  };
}

function setOfferings(list: Array<Record<string, unknown>>) {
  h.offerings = list;
  h.candidates.clear();
  for (const o of list) h.candidates.set(o.id as string, candidateFor(o));
}

const assignment = (o: Record<string, unknown>) => ({
  id: `row-${String(o.surface)}-${String(o.orgId)}`, partnerId: P, offeringPartnerId: P, role: 'default',
  defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: null, options: null,
  fallbackOfferingIds: null, fallbackMayCrossFunding: null, createdAt: T, updatedAt: T,
  ...o,
});

beforeEach(() => {
  h.connections = []; h.offerings = []; h.candidates.clear(); h.platformModels = [];
  h.partnerRows = []; h.orgRows = []; h.allRows = [];
  h.facts = { plan: 'pro', residencyRequired: false };
  h.platformGeo = null; h.platformConfigured = true; h.platformConfiguredCalls = [];
  h.catalogEnabled = false; h.providers = [];
});

describe('buildPartnerModelsSnapshot', () => {
  it('puts the implicit platform connection first, then partner connections', async () => {
    h.connections = [conn({ id: C, kind: 'anthropic_byok', name: 'Anthropic' })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.connections.map((c) => [c.id, c.kind])).toEqual([[null, 'platform'], [C, 'anthropic_byok']]);
    expect(s.connections[1]).not.toHaveProperty('apiKeyEncrypted');
    expect(s.connections[1]).not.toHaveProperty('keyFingerprint');
    expect(s.connections[1]).toMatchObject({ keyLast4: '1234', funding: 'partner_key' });
  });

  it('decides "platform configured" exactly as the candidate loader does (Anthropic key, agent_sdk) (BD-3)', async () => {
    h.platformConfigured = false;
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.connections.map((c) => c.kind)).not.toContain('platform');
    expect(h.platformConfiguredCalls).toEqual([[process.env.ANTHROPIC_API_KEY, 'agent_sdk']]);
  });

  it('reports the platform connection geo from the platform setting and only the geos the platform key serves (BD-4)', async () => {
    h.platformGeo = 'us';
    h.platformModels = [pm({ id: 'pm-1', optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: ['eu', 'us'] } })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.connections[0]).toMatchObject({
      kind: 'platform', inferenceGeo: null, effectiveInferenceGeo: 'us', inferenceGeoSource: 'platform', supportedInferenceGeos: ['us'],
    });
    expect(s.offerings[0]!.optionSupport.inferenceGeo).toEqual(['us']);
  });

  it('a partner connection inherits the platform geo when it has none of its own', async () => {
    h.platformGeo = 'us';
    h.connections = [conn({ id: C, kind: 'anthropic_byok' }), conn({ id: B, kind: 'anthropic_byok', inferenceGeo: 'eu' })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.connections.slice(1).map((c) => [c.effectiveInferenceGeo, c.inferenceGeoSource])).toEqual([['us', 'platform'], ['eu', 'connection']]);
  });

  it('synthesizes a not-yet-added row for each offered platform model with no offering', async () => {
    h.platformModels = [pm({ id: 'pm-1', platformOffered: true }), pm({ id: 'pm-2', platformOffered: false })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings.filter((o) => o.id === null).map((o) => o.platformModelId)).toEqual(['pm-1']);
  });

  it('does not synthesize a row for a platform model the partner already added', async () => {
    h.platformModels = [pm({ id: 'pm-1' })];
    setOfferings([offering({ id: A, platformModelId: 'pm-1' })]);
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings.map((o) => o.id)).toEqual([A]);
  });

  it('reports enableBlocker via the enable gate (plan gate on a synthesized row)', async () => {
    h.facts = { plan: 'starter', residencyRequired: false };
    h.platformModels = [pm({ id: 'pm-1', platformOffered: true, minPlan: 'enterprise' })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings[0]!.enableBlocker).toBe('plan_required');
  });

  it('a synthesized row reports residency_unavailable when the platform geo cannot be served, like a loaded one (BD-1)', async () => {
    h.platformGeo = 'eu';
    h.platformModels = [pm({ id: 'pm-1' })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings[0]!.enableBlocker).toBe('residency_unavailable');
  });

  it('a synthesized row with an unknown capabilities tree reports tools the way the loader does (BD-4)', async () => {
    h.platformModels = [pm({ id: 'pm-1', capabilities: null })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings[0]!.supportsTools).toBe(true);
  });

  it('lists the surfaces an offering is default for (partner and org rows)', async () => {
    setOfferings([offering({ id: A })]);
    h.allRows = [{ surface: 'chat', orgId: null, defaultOfferingId: A }, { surface: 'helper', orgId: 'o1', defaultOfferingId: A }];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings[0]!.defaultFor).toEqual([
      { surface: 'chat', level: 'partner', orgId: null },
      { surface: 'helper', level: 'org', orgId: 'o1' },
    ]);
  });

  it('returns one defaults row per configurable surface, never patch_test', async () => {
    h.partnerRows = [assignment({ surface: 'chat', orgId: null, defaultOfferingId: A, allowUserChoice: true })];
    h.allRows = [{ surface: 'chat', orgId: 'o1', defaultOfferingId: null }, { surface: 'chat', orgId: 'o2', defaultOfferingId: null }];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.defaults).toHaveLength(9);
    expect(s.defaults.map((d) => d.surface)).not.toContain('patch_test');
    const chat = s.defaults.find((d) => d.surface === 'chat')!;
    expect(chat.requiresTools).toBe(true);
    expect(chat.partner).toMatchObject({ defaultOfferingId: A, updatedAt: T.toISOString() });
    expect(chat.orgOverrideCount).toBe(2);
  });

  it('marks prices editable only for discovered/manual offerings', async () => {
    h.connections = [conn({ id: C, kind: 'anthropic_byok' })];
    setOfferings([offering({ id: A, source: 'platform' }), offering({ id: B, source: 'discovered', connectionId: C, platformModelId: null })]);
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings.map((o) => [o.id, o.pricesEditable])).toEqual([[A, false], [B, true]]);
  });

  describe('W03 soft-disconnect: a disconnected connection and its offerings are never listed', () => {
    const GONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    it('drops a disconnected connection even if the live-only reader ever returned one (type-narrowed)', async () => {
      h.connections = [conn({ id: GONE, kind: 'anthropic_byok', status: 'disconnected', keyLast4: null }), conn({ id: C, kind: 'anthropic_byok' })];
      const s = await buildPartnerModelsSnapshot(P);
      expect(s.connections.map((c) => c.id)).toEqual([null, C]);
      expect(s.connections.map((c) => c.status)).not.toContain('disconnected');
    });

    it('omits offerings whose connection is not live (Models card, defaults pickers and defaultFor read this list)', async () => {
      h.connections = [conn({ id: C, kind: 'anthropic_byok' })];
      setOfferings([
        offering({ id: A }),
        offering({ id: B, source: 'discovered', connectionId: C, platformModelId: null }),
        offering({ id: GONE, source: 'discovered', connectionId: GONE, platformModelId: null, enabled: false }),
      ]);
      h.allRows = [{ surface: 'chat', orgId: 'o1', defaultOfferingId: GONE }];
      const s = await buildPartnerModelsSnapshot(P);
      expect(s.offerings.map((o) => o.id)).toEqual([A, B]);
      expect(s.offerings.flatMap((o) => o.defaultFor)).toEqual([]);
    });
  });

  it('includes the catalog only when the catalog flag is on', async () => {
    h.providers = [{ entryId: 'e1', slug: 's', name: 'Prov', dataNote: null, verifiedModels: ['m1', 'constructor'], modelMap: { m1: 'x' } }];
    expect((await buildPartnerModelsSnapshot(P)).catalog).toEqual([]);
    h.catalogEnabled = true;
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.catalogEnabled).toBe(true);
    expect(s.catalog).toEqual([{ entryId: 'e1', slug: 's', name: 'Prov', dataNote: null, models: ['m1'] }]);
  });
});

describe('buildCatalogSummary', () => {
  it('offers verified ∩ mapped models only (Object.hasOwn)', async () => {
    h.providers = [{ entryId: 'e1', slug: 's', name: 'Prov', dataNote: 'n', verifiedModels: ['m1', 'm2', 'constructor'], modelMap: { m1: 'x' } }];
    expect(await buildCatalogSummary()).toEqual([{ entryId: 'e1', slug: 's', name: 'Prov', dataNote: 'n', models: ['m1'] }]);
  });
});

describe('buildOrgModelDefaults', () => {
  it('shows the inherited (partner) value, the org value and the merged effective value', async () => {
    h.partnerRows = [assignment({ surface: 'chat', orgId: null, defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: true, options: { effort: 'high' } })];
    h.orgRows = [assignment({ surface: 'chat', orgId: ORG, defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: false, options: null })];
    const d = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: false });
    const chat = d.surfaces.find((s) => s.surface === 'chat')!;
    expect(chat.inherited).toMatchObject({ defaultOfferingId: A, allowUserChoice: true, options: { effort: 'high' } });
    expect(chat.org).toMatchObject({ allowUserChoice: false });
    expect(chat.effective).toMatchObject({ defaultOfferingId: A, defaultSource: 'partner', allowUserChoice: false });
    expect(d.canEditReviewer).toBe(false);
  });

  it('lists only enabled offerings as choices', async () => {
    setOfferings([offering({ id: A, enabled: true }), offering({ id: B, enabled: false })]);
    const d = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: true });
    expect(d.offerings.map((o) => o.id)).toEqual([A]);
  });

  it('never offers a disconnected connection’s offering (W03 disables them all on disconnect)', async () => {
    setOfferings([offering({ id: A, enabled: true }), offering({ id: B, source: 'discovered', connectionId: C, platformModelId: null, enabled: false })]);
    const d = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: true });
    expect(d.offerings.map((o) => o.id)).toEqual([A]);
  });
});
