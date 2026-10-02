import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getOffering: vi.fn(),
  getConnection: vi.fn(),
  getConnectionKeyMaterial: vi.fn(),
  decryptConnectionKey: vi.fn(),
  getPlatformModelById: vi.fn(),
  getPlatformModelByModelId: vi.fn(),
  getPlatformDefaultModel: vi.fn(),
  getPlatformInferenceGeo: vi.fn(),
  getListedProviderByEntryId: vi.fn(),
  isLlmProviderCatalogEnabled: vi.fn(() => true),
  isPlatformLlmConfigured: vi.fn(() => true),
  findOfferingIdForModel: vi.fn(),
  getEffectiveAssignment: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('../sentry', () => ({ captureException: m.captureException }));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./offerings', () => ({ getOffering: m.getOffering, listOfferings: vi.fn(), findOfferingIdForModel: m.findOfferingIdForModel }));
vi.mock('./assignments', () => ({ getEffectiveAssignment: m.getEffectiveAssignment }));
vi.mock('./connections', () => ({
  getConnection: m.getConnection,
  getConnectionKeyMaterial: m.getConnectionKeyMaterial,
  decryptConnectionKey: m.decryptConnectionKey,
}));
// The real PLATFORM_KEY_INFERENCE_GEOS / effectivePlatformInferenceGeos (D3)
// are kept; only the DB readers are replaced.
vi.mock('./platformModels', async (orig) => ({
  ...(await orig<typeof import('./platformModels')>()),
  getPlatformModelById: m.getPlatformModelById,
  getPlatformModelByModelId: m.getPlatformModelByModelId,
  getPlatformDefaultModel: m.getPlatformDefaultModel,
  getPlatformInferenceGeo: m.getPlatformInferenceGeo,
}));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: m.getListedProviderByEntryId }));
vi.mock('../llm/llmAvailability', async (orig) => ({
  ...(await orig<typeof import('../llm/llmAvailability')>()),
  isPlatformLlmConfigured: m.isPlatformLlmConfigured,
}));
vi.mock('../llm/llmConfigResolver', async (orig) => ({
  ...(await orig<typeof import('../llm/llmConfigResolver')>()),
  isLlmProviderCatalogEnabled: m.isLlmProviderCatalogEnabled,
}));
vi.mock('./capabilities', () => ({
  deriveCapabilities: (raw: { tools?: boolean } | null) => ({
    thinkingMode: raw ? 'adaptive' : 'unknown',
    effortLevels: raw ? ['low', 'medium', 'high'] : [],
    supportsTools: raw?.tools ?? false,
    supportsVision: false,
  }),
}));

import { findOfferingIdByModel, loadOfferingCandidate, loadPlatformDefaultCandidate, platformCandidateFacts } from './candidateLoader';
import { checkEligibility, checkEnableEligibility, type EligibilityContext } from './eligibility';

const ELIGIBILITY_CTX: EligibilityContext = {
  partnerId: 'p1', surface: 'chat', partnerPlan: 'pro', hosted: true, residencyRequired: false,
  geoCarriable: true, userInitiated: false, userHoldsPermission: () => false,
};

const PLATFORM_ROW = {
  id: 'pm-1', modelId: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5',
  maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: { tools: true },
  rates: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
  optionRates: null,
  optionSupport: { effort: ['low', 'medium', 'high'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: ['us'] },
  minPlan: null, promptProfile: 'claude-standard', platformOffered: true, isPlatformDefault: true, lifecycle: 'available',
};
const BASE_OFFERING = {
  id: 'off-1', partnerId: 'p1', connectionId: null, platformModelId: 'pm-1', modelId: null, source: 'platform',
  displayName: null, capabilities: null,
  priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null,
  enabled: true, defaultOptions: null, allowedOptions: null, requiredPermission: null,
  refusalFallbackOfferingId: null, lifecycle: 'available',
};
const BYOK_CONN = {
  id: 'conn-1', partnerId: 'p1', kind: 'anthropic_byok', name: 'Key', inferenceGeo: null,
  catalogEntryId: null, baseUrl: null, status: 'active', configVersion: 4, apiKeyEncrypted: 'enc',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getPlatformModelById.mockResolvedValue(PLATFORM_ROW);
  m.getPlatformModelByModelId.mockResolvedValue(PLATFORM_ROW);
  m.getPlatformInferenceGeo.mockResolvedValue(null);
  m.getConnectionKeyMaterial.mockImplementation(async (id: string) => ({ id, partnerId: 'p1', apiKeyEncrypted: 'enc' }));
  m.decryptConnectionKey.mockReturnValue('sk-partner');
  m.isPlatformLlmConfigured.mockReturnValue(true);
  m.isLlmProviderCatalogEnabled.mockReturnValue(true);
});

describe('loadOfferingCandidate', () => {
  it('returns null for an offering owned by another partner (no detail leaks)', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, partnerId: 'p2' });
    await expect(loadOfferingCandidate('off-1', 'p1')).resolves.toBeNull();
  });

  it('platform offering: identity, price and capabilities come from the platform row, funding platform', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.logicalModel).toBe('claude-sonnet-5-5');
    expect(c.wireModel).toBe('claude-sonnet-5-5');
    expect(c.funding).toBe('platform');
    expect(c.connection?.kind).toBe('platform');
    expect(c.facts.rate).toEqual({
      source: 'platform',
      standard: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
    });
    expect(c.facts.platform).toEqual({ platformOffered: true, lifecycle: 'available', minPlan: null });
    expect(c.promptProfile).toBe('claude-standard');
  });

  it('re-reads platform_offered every call (quorum #2)', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValueOnce({ ...PLATFORM_ROW, platformOffered: false });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.platform?.platformOffered).toBe(false);
  });

  it('BYOK linked row: offering price beats linked platform price', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5',
      priceInputCentsPerM: 150, priceOutputCentsPerM: 900, priceCacheReadCentsPerM: 15, priceCacheWriteCentsPerM: 190,
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.funding).toBe('partner_key');
    expect(c.facts.rate?.source).toBe('offering');
    expect(c.facts.platform).toBeNull();
    expect(c.connection?.config).toMatchObject({
      source: 'partner', apiKey: 'sk-partner', configId: 'conn-1', configVersion: 4, endpoint: { kind: 'anthropic' },
    });
  });

  it('BYOK linked row without its own price falls back to the linked platform price', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.rate?.source).toBe('linked_platform');
  });

  it('BYOK unlinked + unpriced → rate null (cannot be dispatched)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', platformModelId: null, source: 'manual', modelId: 'my-local-model',
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.rate).toBeNull();
    expect(c.capabilities.thinkingMode).toBe('unknown');
  });

  it('an undecryptable key yields keyUsable=false and no connection config', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.decryptConnectionKey.mockImplementation(() => { throw new Error('bad tag'); });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
  });

  it('a key LOOKUP failure (DB) is not a dead key: it throws (scrubbed) and is reported, never "reconnect it" (review S6)', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.getConnectionKeyMaterial.mockRejectedValue(Object.assign(new Error('Failed query: select … params: conn-secret'), { params: ['conn-secret'] }));
    const thrown = await loadOfferingCandidate('off-1', 'p1').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/key lookup failed/);
    expect(String((thrown as Error).message)).not.toContain('conn-secret');
    expect(m.captureException).toHaveBeenCalledTimes(1);
    expect(String((m.captureException.mock.calls[0]![0] as Error).message)).not.toContain('conn-secret');
    expect(m.decryptConnectionKey).not.toHaveBeenCalled();
  });

  it('a SecretKeyMaterialError on decrypt stays a key error (keyUsable=false), reported', async () => {
    const { SecretKeyMaterialError } = await import('../secretCrypto');
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.decryptConnectionKey.mockImplementation(() => { throw new SecretKeyMaterialError('Unknown encrypted secret key ID'); });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(m.captureException).toHaveBeenCalled();
  });

  it('catalog: resolved LIVE from the current listed revision; unmapped → catalog.usable false', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-2', platformModelId: null, source: 'catalog', modelId: 'claude-sonnet-5-5',
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-2', kind: 'catalog', catalogEntryId: 'cat-1' });
    m.getListedProviderByEntryId.mockResolvedValue({
      entryId: 'cat-1', slug: 'gw', name: 'GW', revisionId: 'rev-7', revision: 7, baseUrl: 'https://gw.example.com',
      authMode: 'bearer', dataNote: null, verifiedModels: ['claude-sonnet-5-5'],
      modelMap: { 'claude-sonnet-5-5': { providerModel: 'anthropic/claude-sonnet-5.5', inputCentsPerM: 210, outputCentsPerM: 1050, cacheReadCentsPerM: 21, cacheWriteCentsPerM: 260 } },
    });
    const ok = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(ok.wireModel).toBe('anthropic/claude-sonnet-5.5');
    expect(ok.catalogRevisionId).toBe('rev-7');
    expect(ok.facts.catalog).toEqual({ usable: true });
    expect(ok.facts.rate?.source).toBe('catalog');
    expect(ok.capabilities.thinkingMode).toBe('unknown');
    expect(ok.capabilities.supportsTools).toBe(true);

    m.getListedProviderByEntryId.mockResolvedValue(null); // delisted
    const gone = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(gone.facts.catalog).toEqual({ usable: false });
    expect(gone.connection).toBeNull();
  });

  it('catalog flag off → catalog unusable (fails closed, never reverts to api.anthropic.com)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-2', platformModelId: null, source: 'catalog', modelId: 'claude-sonnet-5-5',
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-2', kind: 'catalog', catalogEntryId: 'cat-1' });
    m.isLlmProviderCatalogEnabled.mockReturnValue(false);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.catalog).toEqual({ usable: false });
    expect(m.getListedProviderByEntryId).not.toHaveBeenCalled();
  });

  it('effective inference geo: connection value, else the platform setting', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, inferenceGeo: 'eu' });
    m.getPlatformInferenceGeo.mockResolvedValue('us');
    expect((await loadOfferingCandidate('off-1', 'p1'))!.facts.inferenceGeo).toBe('eu');
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, inferenceGeo: null });
    expect((await loadOfferingCandidate('off-1', 'p1'))!.facts.inferenceGeo).toBe('us');
  });
});

describe('findOfferingIdByModel (finding 11: never crosses to another connection)', () => {
  // The same model id exists on the platform AND on a BYOK connection.
  const PLATFORM_SONNET = { ...BASE_OFFERING, id: 'plat-sonnet', partnerId: 'p1' };
  const BYOK_SONNET = { ...BASE_OFFERING, id: 'byok-sonnet', partnerId: 'p1', connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' };
  const BYOK_OPUS_DISABLED = { ...BASE_OFFERING, id: 'byok-opus', partnerId: 'p1', connectionId: 'conn-1', enabled: false, modelId: 'claude-opus-5-5' };
  const rows = [PLATFORM_SONNET, BYOK_SONNET, BYOK_OPUS_DISABLED];
  beforeEach(() => {
    m.getOffering.mockImplementation(async (id: string) => rows.find((o) => o.id === id) ?? null);
    // A faithful stand-in for W02's connection-scoped lookup.
    m.findOfferingIdForModel.mockImplementation(async (q: { connectionId: string | null; modelId: string }) =>
      rows.find((o) => o.connectionId === q.connectionId && (o.modelId ?? 'claude-sonnet-5-5') === q.modelId)?.id ?? null);
  });
  const find = (modelId: string) => findOfferingIdByModel({ partnerId: 'p1', orgId: 'o1', surface: 'chat', modelId });

  it('the same model id on platform and BYOK → the one on the surface default\'s connection', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'byok-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-sonnet-5-5')).toBe('byok-sonnet');
    expect(m.findOfferingIdForModel).toHaveBeenLastCalledWith({ partnerId: 'p1', connectionId: 'conn-1', modelId: 'claude-sonnet-5-5' });
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'plat-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-sonnet-5-5')).toBe('plat-sonnet');
    expect(m.findOfferingIdForModel).toHaveBeenLastCalledWith({ partnerId: 'p1', connectionId: null, modelId: 'claude-sonnet-5-5' });
  });
  it('a disabled match, or a model only on ANOTHER connection, is null (never a destination change)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'byok-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-opus-5-5')).toBeNull();
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'plat-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-opus-5-5')).toBeNull();
  });
  it('no surface default → null', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: null, permitted: { kind: 'all' } });
    expect(await find('claude-sonnet-5-5')).toBeNull();
  });
});

describe('loadPlatformDefaultCandidate', () => {
  it('builds a partnerless platform candidate from the platform default row', async () => {
    m.getPlatformDefaultModel.mockResolvedValue(PLATFORM_ROW);
    const c = (await loadPlatformDefaultCandidate())!;
    expect(c.offeringId).toBeNull();
    expect(c.facts.ownerPartnerId).toBeNull();
    expect(c.funding).toBe('platform');
  });

  // W01 deferred: getPlatformDefaultModel() does not filter on lifecycle.
  it.each([
    ['retired', { lifecycle: 'retired' }],
    ['missing', { lifecycle: 'missing' }],
    ['un-offered', { platformOffered: false }],
  ])('a %s platform default is carried into the facts and is ineligible', async (_name, over) => {
    m.getPlatformDefaultModel.mockResolvedValue({ ...PLATFORM_ROW, ...over });
    const c = (await loadPlatformDefaultCandidate())!;
    expect(c.facts.platform).toMatchObject(over);
    expect(checkEligibility(c.facts, {
      ...ELIGIBILITY_CTX, partnerId: null, surface: 'patch_test', partnerPlan: null,
    })).toBe('model_unavailable');
  });
});

describe('fast mode needs a speed:fast rate (W01 deferred)', () => {
  const FAST_RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 500 };
  const FAST_ROW = { ...PLATFORM_ROW, optionSupport: { ...PLATFORM_ROW.optionSupport, speed: ['standard', 'fast'] } };

  it('platform row claiming fast with no option rate → fast not supported', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValue({ ...FAST_ROW, optionRates: null });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.optionSupport.speed).toEqual(['standard']);
    m.getPlatformModelById.mockResolvedValue({ ...FAST_ROW, optionRates: {} });
    expect((await loadOfferingCandidate('off-1', 'p1'))!.optionSupport.speed).toEqual(['standard']);
  });

  it('platform row claiming fast WITH a speed:fast rate → fast supported', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValue({ ...FAST_ROW, optionRates: { 'speed:fast': FAST_RATES } });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.optionSupport.speed).toEqual(['standard', 'fast']);
    expect(c.optionRates).toEqual({ 'speed:fast': FAST_RATES });
  });

  it('platform default claiming fast with no rate → fast not supported', async () => {
    m.getPlatformDefaultModel.mockResolvedValue({ ...FAST_ROW, optionRates: null });
    expect((await loadPlatformDefaultCandidate())!.optionSupport.speed).toEqual(['standard']);
  });

  it('BYOK priced by the offering itself: the linked row\'s fast rate does not apply → fast not supported', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5',
      priceInputCentsPerM: 150, priceOutputCentsPerM: 900, priceCacheReadCentsPerM: 15, priceCacheWriteCentsPerM: 190,
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.getPlatformModelById.mockResolvedValue({ ...FAST_ROW, optionRates: { 'speed:fast': FAST_RATES } });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.optionRates).toBeNull();
    expect(c.optionSupport.speed).toEqual(['standard']);
  });

  it('BYOK priced by its linked platform row inherits fast only with the row\'s rate', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.getPlatformModelById.mockResolvedValue({ ...FAST_ROW, optionRates: { 'speed:fast': FAST_RATES } });
    expect((await loadOfferingCandidate('off-1', 'p1'))!.optionSupport.speed).toEqual(['standard', 'fast']);
    m.getPlatformModelById.mockResolvedValue({ ...FAST_ROW, optionRates: null });
    expect((await loadOfferingCandidate('off-1', 'p1'))!.optionSupport.speed).toEqual(['standard']);
  });
});

describe('platform-key inference geographies (W01 D3: us + global only)', () => {
  it('a row with no operator geos → the platform key\'s set, on both facts and optionSupport', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValue({ ...PLATFORM_ROW, optionSupport: { ...PLATFORM_ROW.optionSupport, inferenceGeo: [] } });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.supportedInferenceGeos).toEqual(['us', 'global']);
    expect(c.optionSupport.inferenceGeo).toEqual(['us', 'global']);
  });

  it('operator geos are intersected with what the platform key accepts', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValue({ ...PLATFORM_ROW, optionSupport: { ...PLATFORM_ROW.optionSupport, inferenceGeo: ['eu', 'us'] } });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.supportedInferenceGeos).toEqual(['us']);
    expect(c.optionSupport.inferenceGeo).toEqual(['us']);
  });

  it('AI_PLATFORM_INFERENCE_GEO=eu → platform offering AND platform default are residency_unavailable', async () => {
    m.getPlatformInferenceGeo.mockResolvedValue('eu');
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.inferenceGeo).toBe('eu');
    expect(checkEligibility(c.facts, ELIGIBILITY_CTX)).toBe('residency_unavailable');
    m.getPlatformDefaultModel.mockResolvedValue(PLATFORM_ROW);
    const d = (await loadPlatformDefaultCandidate())!;
    expect(checkEligibility(d.facts, { ...ELIGIBILITY_CTX, partnerId: null, surface: 'patch_test', partnerPlan: null }))
      .toBe('residency_unavailable');
  });

  it('AI_PLATFORM_INFERENCE_GEO=us → eligible', async () => {
    m.getPlatformInferenceGeo.mockResolvedValue('us');
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(checkEligibility(c.facts, ELIGIBILITY_CTX)).toBeNull();
  });

  it('a BYOK connection keeps its model\'s own geo list (D3 is a property of the platform key)', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.getPlatformModelById.mockResolvedValue({ ...PLATFORM_ROW, optionSupport: { ...PLATFORM_ROW.optionSupport, inferenceGeo: [] } });
    expect((await loadOfferingCandidate('off-1', 'p1'))!.facts.supportedInferenceGeos).toEqual([]);
  });
});

describe('unknown capabilities on an Anthropic connection (W01 D4 + W00 wire parity, #7601)', () => {
  const PRICE = { priceInputCentsPerM: 100, priceOutputCentsPerM: 500, priceCacheReadCentsPerM: 10, priceCacheWriteCentsPerM: 125 };
  const toolCtx: EligibilityContext = { ...ELIGIBILITY_CTX, surface: 'office_chat' };

  it('BYOK manual offering with null capabilities (dated Office id) supports tools and thinks exactly as legacy did (budget → off)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', platformModelId: null, source: 'manual', modelId: 'claude-haiku-4-5-20251001', ...PRICE,
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.capabilities).toEqual({ thinkingMode: 'budget', effortLevels: [], supportsTools: true, supportsVision: false });
    expect(c.facts.supportsTools).toBe(true);
    expect(checkEligibility(c.facts, toolCtx)).toBeNull();
  });

  it('BYOK manual adaptive id with null capabilities → legacy adaptive profile (effort + displays selectable)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', platformModelId: null, source: 'manual', modelId: 'claude-sonnet-4-6', ...PRICE,
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.capabilities.thinkingMode).toBe('adaptive');
    expect(c.capabilities.supportsTools).toBe(true);
    expect(c.optionSupport.effort).toEqual(['low', 'medium', 'high', 'max']);
    expect(c.optionSupport.thinkingDisplay).toEqual(['omitted', 'summarized']);
  });

  it('platform row with null capabilities (env-bootstrapped) supports tools and uses the legacy wire profile', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValue({
      ...PLATFORM_ROW, modelId: 'claude-sonnet-4-6', capabilities: null,
      optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.capabilities).toEqual({ thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max'], supportsTools: true, supportsVision: false });
    expect(c.optionSupport.effort).toEqual(['low', 'medium', 'high', 'max']);
    // D3: the platform key's geos still come from the platform rule, not the legacy profile.
    expect(c.optionSupport.inferenceGeo).toEqual(c.facts.supportedInferenceGeos);
    expect(checkEligibility(c.facts, toolCtx)).toBeNull();
  });

  it('platform gateway id the W00 rules do not know stays thinking-unknown but supports tools', async () => {
    m.getPlatformDefaultModel.mockResolvedValue({ ...PLATFORM_ROW, modelId: 'my-gateway-model', capabilities: null });
    const d = (await loadPlatformDefaultCandidate())!;
    expect(d.capabilities).toEqual({ thinkingMode: 'unknown', effortLevels: [], supportsTools: true, supportsVision: false });
  });

  it('a recognised tree that says no tools still wins (D4 default applies only to unknown)', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValue({ ...PLATFORM_ROW, capabilities: { tools: false } });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.capabilities.supportsTools).toBe(false);
    expect(checkEligibility(c.facts, toolCtx)).toBe('tools_unsupported');
  });

  it('openai_compatible is NOT an Anthropic connection: unknown stays unverified (no tools)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-9', platformModelId: null, source: 'manual', modelId: 'claude-sonnet-4-6', ...PRICE,
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-9', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1' });
    m.getConnectionKeyMaterial.mockResolvedValue({ id: 'conn-9', partnerId: 'p1', status: 'active', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', configVersion: 4, apiKeyEncrypted: 'enc' });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.capabilities).toEqual({ thinkingMode: 'unknown', effortLevels: [], supportsTools: false, supportsVision: false });
  });

  it('openai_compatible dispatches through the gateway branch (W06): gateway config + credential, offering price only', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-9', platformModelId: 'pm-1', source: 'discovered', modelId: 'qwen2.5-coder:7b', ...PRICE,
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-9', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', inferenceGeo: 'eu' });
    m.getConnectionKeyMaterial.mockResolvedValue({ id: 'conn-9', partnerId: 'p1', status: 'active', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', configVersion: 4, apiKeyEncrypted: 'enc' });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.connection).toEqual({
      id: 'conn-9', kind: 'openai_compatible',
      config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'conn-9', configVersion: 4, baseUrl: 'https://llm.example.com/v1' },
      credential: { secret: 'sk-partner' },
    });
    expect(c.funding).toBe('partner_key');
    expect(c.wireModel).toBe('qwen2.5-coder:7b');
    expect(c.facts.rate?.source).toBe('offering');
    expect(c.facts.inferenceGeo).toBeNull();
    // The linked platform row is never consulted for a gateway kind (no price/capability inheritance).
    expect(m.getPlatformModelById).not.toHaveBeenCalled();
  });

  it('openai_compatible on a disconnected connection is unusable (its NULL key is not "keyless")', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-9', platformModelId: null, source: 'discovered', modelId: 'qwen2.5-coder:7b', ...PRICE,
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-9', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', status: 'disconnected' });
    m.getConnectionKeyMaterial.mockResolvedValue({ id: 'conn-9', partnerId: 'p1', status: 'disconnected', apiKeyEncrypted: null });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.connection).toBeNull();
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(checkEligibility(c.facts, { ...ELIGIBILITY_CTX, surface: 'catalog_enrichment' })).toBe('connection_unavailable');
  });
});

describe('platformCandidateFacts: synthesized platform rows match the loader (W04 #7602, ruling BD-1)', () => {
  const ENABLE_CTX = { partnerId: 'p1', partnerPlan: 'pro' as const, hosted: true };

  it.each([
    ['a geo the key cannot serve', ['us'], 'eu', 'residency_unavailable'],
    ['a served geo', ['us'], 'us', null],
    ['a row geo list the key narrows away', ['eu', 'us'], 'global', 'residency_unavailable'],
    ['the default (empty) row list under global', [], 'global', null],
    ['no configured platform geo', ['us'], null, null],
  ] as const)('%s → the same enable verdict', async (_label, rowGeos, platformGeo, expected) => {
    const row = { ...PLATFORM_ROW, optionSupport: { ...PLATFORM_ROW.optionSupport, inferenceGeo: [...rowGeos] } };
    m.getPlatformModelById.mockResolvedValue(row);
    m.getPlatformInferenceGeo.mockResolvedValue(platformGeo);
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, enabled: false });

    const loaded = (await loadOfferingCandidate('off-1', 'p1'))!;
    const synthesized = platformCandidateFacts('p1', row as never, platformGeo);

    expect(synthesized.inferenceGeo).toBe(loaded.facts.inferenceGeo);
    expect(synthesized.supportedInferenceGeos).toEqual(loaded.facts.supportedInferenceGeos);
    expect(checkEnableEligibility(synthesized, ENABLE_CTX)).toBe(expected);
    expect(checkEnableEligibility(loaded.facts, ENABLE_CTX)).toBe(expected);
  });

  it('carries the loader’s platform, rate and tools facts for the same row', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, enabled: false });
    const loaded = (await loadOfferingCandidate('off-1', 'p1'))!;
    const synthesized = platformCandidateFacts('p1', PLATFORM_ROW as never, null);
    expect(synthesized.platform).toEqual(loaded.facts.platform);
    expect(synthesized.rate).toEqual(loaded.facts.rate);
    expect(synthesized.supportsTools).toBe(loaded.facts.supportsTools);
    expect(synthesized).toMatchObject({ ownerPartnerId: 'p1', enabled: false, lifecycle: 'available', requiredPermission: null, catalog: null });
  });
});
