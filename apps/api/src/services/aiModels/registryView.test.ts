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
import { endpointFingerprint } from './gatewayCapabilities';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';

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
  lastDiscoveredAt: null, discoveryError: null, createdAt: T, updatedAt: T,
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

  it('returns one defaults row per configurable (surface, role), never patch_test', async () => {
    h.partnerRows = [assignment({ surface: 'chat', orgId: null, defaultOfferingId: A, allowUserChoice: true })];
    h.allRows = [{ surface: 'chat', role: 'default', orgId: 'o1', defaultOfferingId: null }, { surface: 'chat', role: 'default', orgId: 'o2', defaultOfferingId: null }];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.defaults).toHaveLength(12); // 9 surfaces + ai_agents' three escalation roles
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

  describe('W06 gateway (openai_compatible) connections', () => {
    const G = '99999999-9999-4999-8999-999999999999';
    const URL_ = 'https://llm.example.com/v1';
    const fp = (baseUrl: string) => endpointFingerprint({ kind: 'openai_compatible', baseUrl, providerConfig: null });
    const record = (o: Record<string, unknown>) => ({
      breeze_verification: {
        harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: fp(URL_), at: '2026-10-01T00:00:00.000Z',
        passed: true, toolUse: true, adaptiveEffort: false, summary: null, ...o,
      },
      tool_use: { supported: true },
    });
    const gw = (id: string, capabilities: unknown) =>
      offering({ id, source: 'discovered', connectionId: G, platformModelId: null, modelId: `m-${id}`, capabilities });
    const O1 = '10000000-0000-4000-8000-000000000001';
    const O2 = '10000000-0000-4000-8000-000000000002';
    const O3 = '10000000-0000-4000-8000-000000000003';
    const O4 = '10000000-0000-4000-8000-000000000004';

    it('connection DTO: baseUrl + managedBy, never key material, and no inference geography (D7)', async () => {
      h.platformGeo = 'us';
      h.connections = [
        conn({ id: C, kind: 'anthropic_byok' }),
        conn({ id: G, kind: 'openai_compatible', baseUrl: URL_, providerConfig: { managedBy: 'env' }, keyLast4: null }),
      ];
      setOfferings([gw(O1, null)]);
      const s = await buildPartnerModelsSnapshot(P);
      const g = s.connections.find((c) => c.id === G)!;
      expect(g).toMatchObject({
        kind: 'openai_compatible', baseUrl: URL_, managedBy: 'env', funding: 'partner_key',
        inferenceGeo: null, effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default', supportedInferenceGeos: [],
      });
      expect(JSON.stringify(g)).not.toMatch(/cipher|"fp"|keyFingerprint|apiKeyEncrypted|providerConfig/);
      // Anthropic-dialect and platform connections expose no base URL and are never env-managed here.
      expect(s.connections.find((c) => c.id === C)).toMatchObject({ baseUrl: null, managedBy: null, effectiveInferenceGeo: 'us' });
      expect(s.connections[0]).toMatchObject({ kind: 'platform', baseUrl: null, managedBy: null });
    });

    it('a released env connection stays managedBy env (read-only) and is flagged envReleased (the partner may disconnect it)', async () => {
      h.connections = [
        conn({ id: G, kind: 'openai_compatible', baseUrl: URL_, providerConfig: { managedBy: 'env', envReleasedAt: '2026-10-01T00:00:00.000Z' } }),
        conn({ id: C, kind: 'openai_compatible', baseUrl: URL_, providerConfig: { managedBy: 'env' } }),
      ];
      const s = await buildPartnerModelsSnapshot(P);
      expect(s.connections.find((c) => c.id === G)).toMatchObject({ managedBy: 'env', envReleased: true });
      expect(s.connections.find((c) => c.id === C)).toMatchObject({ managedBy: 'env', envReleased: false });
      expect(s.connections[0]).toMatchObject({ kind: 'platform', envReleased: false });
    });

    it('a user-created gateway connection is not managedBy env', async () => {
      h.connections = [conn({ id: G, kind: 'openai_compatible', baseUrl: URL_ })];
      const s = await buildPartnerModelsSnapshot(P);
      expect(s.connections.find((c) => c.id === G)!.managedBy).toBeNull();
    });

    it('offering DTO carries the verification state against the CURRENT endpoint fingerprint; non-gateway offerings carry null', async () => {
      h.connections = [conn({ id: C, kind: 'anthropic_byok' }), conn({ id: G, kind: 'openai_compatible', baseUrl: URL_ })];
      h.platformModels = [pm({ id: 'pm-1' })];
      setOfferings([
        gw(O1, record({})),
        gw(O2, record({ endpointFingerprint: fp('https://old.example.com/v1') })),
        gw(O3, record({ passed: false, toolUse: false, summary: 'tool_call: no tool call returned' })),
        gw(O4, null),
        offering({ id: A }),
        offering({ id: B, source: 'discovered', connectionId: C, platformModelId: null }),
      ]);
      const s = await buildPartnerModelsSnapshot(P);
      const v = (id: string | null) => s.offerings.find((o) => o.id === id)!.verification;
      expect(v(O1)).toEqual({ state: 'verified', at: '2026-10-01T00:00:00.000Z', harnessVersion: FIDELITY_HARNESS_VERSION, summary: null });
      expect(v(O2)).toMatchObject({ state: 'stale', at: '2026-10-01T00:00:00.000Z' });
      expect(v(O3)).toMatchObject({ state: 'failed', summary: 'tool_call: no tool call returned' });
      expect(v(O4)).toEqual({ state: 'unverified', at: null, harnessVersion: null, summary: null });
      expect(v(A)).toBeNull();
      expect(v(B)).toBeNull();
      expect(v(null)).toBeNull(); // synthesized platform row
      // The raw tree / record never reaches the DTO.
      expect(JSON.stringify(s.offerings)).not.toContain('breeze_verification');
      expect(JSON.stringify(s.offerings)).not.toContain(fp(URL_));
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

describe('W09 role rows and fallback lists in the views', () => {
  it('lists one defaults entry per (surface, role), ai_agents with its three stages', async () => {
    const snap = await buildPartnerModelsSnapshot(P);
    expect(snap.defaults.filter((d) => d.surface === 'ai_agents').map((d) => d.role)).toEqual(['default', 'triage', 'analysis', 'remediation']);
    expect(snap.defaults.find((d) => d.surface === 'chat')).toMatchObject({ role: 'default' });
  });

  it('a role entry carries its own row (with the fallback list) and counts only that role\'s org overrides', async () => {
    h.partnerRows = [
      assignment({ surface: 'ai_agents', orgId: null, defaultOfferingId: A, allowUserChoice: true }),
      assignment({ surface: 'ai_agents', role: 'triage', orgId: null, defaultOfferingId: B, allowUserChoice: true, fallbackOfferingIds: [A], fallbackMayCrossFunding: false }),
    ];
    h.allRows = [{ surface: 'ai_agents', role: 'triage', orgId: 'o1', defaultOfferingId: null }, { surface: 'ai_agents', role: 'default', orgId: 'o2', defaultOfferingId: null }];
    const s = await buildPartnerModelsSnapshot(P);
    const triage = s.defaults.find((d) => d.surface === 'ai_agents' && d.role === 'triage')!;
    expect(triage.partner).toMatchObject({ role: 'triage', defaultOfferingId: B, fallbackOfferingIds: [A], fallbackMayCrossFunding: false });
    expect(triage.orgOverrideCount).toBe(1);
    expect(s.defaults.find((d) => d.surface === 'ai_agents' && d.role === 'analysis')!.partner).toBeNull();
    expect(s.defaults.find((d) => d.surface === 'ai_agents' && d.role === 'default')!.partner).toMatchObject({ fallbackOfferingIds: null, fallbackMayCrossFunding: null });
  });

  it('the org view merges a role exactly as the resolver does (D2)', async () => {
    h.partnerRows = [
      { surface: 'ai_agents', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: true, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null, updatedAt: new Date() },
      { surface: 'ai_agents', role: 'triage', orgId: null, defaultOfferingId: B, permittedOfferingIds: null, allowUserChoice: true, options: null, fallbackOfferingIds: [A], fallbackMayCrossFunding: false, updatedAt: new Date() },
    ];
    h.orgRows = [{ surface: 'ai_agents', role: 'default', orgId: ORG, defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: null, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null, updatedAt: new Date() }];
    const view = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: true });
    const triage = view.surfaces.find((s) => s.surface === 'ai_agents' && s.role === 'triage')!;
    expect(triage.effective).toMatchObject({ defaultOfferingId: B, defaultSource: 'partner', fallbackOfferingIds: [A], fallbackMayCrossFunding: false });
    expect(triage.inherited).toMatchObject({ defaultOfferingId: B, fallbackOfferingIds: [A], fallbackMayCrossFunding: false });
    expect(triage.org).toBeNull();     // no org row for (ai_agents, triage) itself
    expect(view.surfaces.filter((s) => s.surface === 'ai_agents').map((s) => s.role)).toEqual(['default', 'triage', 'analysis', 'remediation']);
  });

  it('an org\'s empty fallback list shows as "no backups", not the partner list (Codex 8)', async () => {
    h.partnerRows = [assignment({ surface: 'chat', orgId: null, defaultOfferingId: A, allowUserChoice: true, fallbackOfferingIds: [B], fallbackMayCrossFunding: true })];
    h.orgRows = [assignment({ surface: 'chat', orgId: ORG, fallbackOfferingIds: [], fallbackMayCrossFunding: false })];
    const view = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: true });
    const chat = view.surfaces.find((s) => s.surface === 'chat')!;
    expect(chat.inherited).toMatchObject({ fallbackOfferingIds: [B], fallbackMayCrossFunding: true });
    expect(chat.org).toMatchObject({ fallbackOfferingIds: [], fallbackMayCrossFunding: false });
    expect(chat.effective).toMatchObject({ fallbackOfferingIds: [], fallbackMayCrossFunding: false });
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
