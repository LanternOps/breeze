import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadOfferingCandidate: vi.fn(),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
  enableOffering: vi.fn(),
  getOffering: vi.fn(),
  getPlatformModelById: vi.fn(),
  getPlatformInferenceGeo: vi.fn(async () => null as string | null),
  /** pg_try_advisory_xact_lock result; false = another registry write holds the partner lock. */
  tryLock: vi.fn(async (_partnerId: string) => true),
  hosted: true,
  /** Ordered log of lock acquisition and row writes, to pin lock-before-write. */
  calls: [] as string[],
  dbSelectRows: [] as unknown[][],
  dbUpdateReturning: vi.fn(),
  dbInsertReturning: vi.fn(),
  lastSet: undefined as Record<string, unknown> | undefined,
  insertedValues: undefined as Record<string, unknown> | undefined,
  systemContexts: 0,
}));

vi.mock('./candidateLoader', async (orig) => ({
  ...(await orig<typeof import('./candidateLoader')>()),
  loadOfferingCandidate: h.loadOfferingCandidate,
  loadPartnerFacts: h.loadPartnerFacts,
}));
vi.mock('./offerings', async (orig) => ({
  ...(await orig<typeof import('./offerings')>()),
  enableOffering: (...args: unknown[]) => { h.calls.push('enableOffering'); return h.enableOffering(...args); },
  getOffering: h.getOffering,
}));
vi.mock('./platformModels', async (orig) => ({
  ...(await orig<typeof import('./platformModels')>()),
  getPlatformModelById: h.getPlatformModelById,
  getPlatformInferenceGeo: h.getPlatformInferenceGeo,
}));
vi.mock('./registryWriteLock', () => ({
  tryLockPartnerRegistryWrite: async (partnerId: string) => {
    h.calls.push(`lock:${partnerId}`);
    return h.tryLock(partnerId);
  },
}));
vi.mock('../../config/env', () => ({ isHosted: () => h.hosted }));
vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: any = { from: () => c, where: () => c, limit: () => Promise.resolve(rows()), then: (r: any) => Promise.resolve(rows()).then(r) };
    return c;
  };
  return {
    db: {
      select: () => chain(() => h.dbSelectRows.shift() ?? []),
      update: () => ({
        set: (s: Record<string, unknown>) => {
          h.lastSet = s;
          return { where: () => ({ returning: (...a: unknown[]) => { h.calls.push('update'); return h.dbUpdateReturning(...a); } }) };
        },
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.insertedValues = v;
          return { onConflictDoNothing: () => ({ returning: (...a: unknown[]) => { h.calls.push('insert'); return h.dbInsertReturning(...a); } }) };
        },
      }),
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      h.systemContexts += 1;
      return fn();
    },
  };
});

import { ensurePlatformOffering, setOfferingEnabled, updateOfferingDetails } from './offeringWrites';
import { RegistryWriteError } from './registryWriteErrors';

const P = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';
const FB = '44444444-4444-4444-8444-444444444444';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const UPDATED = new Date('2026-10-01T10:00:00.000Z');

function candidate(over: Record<string, unknown> = {}, factsOver: Record<string, unknown> = {}) {
  return {
    offeringId: OFF, connectionId: null, displayName: 'Model A', funding: 'platform',
    optionSupport: { effort: ['low', 'medium', 'high'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: [] },
    optionRates: null, allowedOptions: null, defaultOptions: null,
    facts: {
      ownerPartnerId: P, enabled: false, lifecycle: 'available', requiredPermission: null,
      platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
      connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
      rate: { source: 'platform', standard: RATES }, supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
      ...factsOver,
    },
    ...over,
  };
}
const row = (over: Record<string, unknown> = {}) => ({
  id: OFF, partnerId: P, connectionId: null, platformModelId: 'pm-1', modelId: null, source: 'platform',
  enabled: false, updatedAt: UPDATED, priceInputCentsPerM: null, allowedOptions: null, defaultOptions: null,
  requiredPermission: null, ...over,
});
/** A full platform-model stub (platformFastSelectable and platformCandidateFacts read optionSupport/rates). */
const platformModel = (over: Record<string, unknown> = {}) => ({
  id: 'pm-1', modelId: 'model-a', platformOffered: true, lifecycle: 'available', minPlan: null, rates: RATES, optionRates: null,
  optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] }, capabilities: {}, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.hosted = true;
  h.dbSelectRows = [];
  h.calls = [];
  h.lastSet = undefined;
  h.insertedValues = undefined;
  h.systemContexts = 0;
  h.getPlatformModelById.mockResolvedValue(null);
  h.getPlatformInferenceGeo.mockResolvedValue(null);
});

describe('setOfferingEnabled', () => {
  it('enables an eligible offering through W02 enableOffering', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.enableOffering.mockResolvedValue(row({ enabled: true }));
    const r = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false });
    expect(h.enableOffering).toHaveBeenCalledWith({ partnerId: P, offeringId: OFF, enabled: true });
    expect(r.offering.enabled).toBe(true);
  });

  it('takes the partner registry lock in a system transaction before writing', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.enableOffering.mockResolvedValue(row({ enabled: true }));
    await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false });
    expect(h.calls).toEqual([`lock:${P}`, 'enableOffering']);
    expect(h.systemContexts).toBe(1);
  });

  it('does not wait for a held partner registry lock: 503 registry_busy and nothing written', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.tryLock.mockResolvedValueOnce(false);
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect([err.status, err.code]).toEqual([503, 'registry_busy']);
    expect(err.message).toBe('Another AI configuration change is in progress. Try again in a moment.');
    expect(h.calls).toEqual([`lock:${P}`]);
    expect(h.enableOffering).not.toHaveBeenCalled();
  });

  it.each([
    ['not offered by the platform', { platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }, 'model_unavailable'],
    ['retired', { lifecycle: 'retired' }, 'model_unavailable'],
    ['plan-gated', { platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }, 'plan_required'],
  ])('refuses to enable a model that is %s (409 not_eligible, reason %s)', async (_l, facts, reason) => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, facts));
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect([err.status, err.code, err.details?.reason]).toEqual([409, 'not_eligible', reason]);
    expect(h.enableOffering).not.toHaveBeenCalled();
  });

  it('404s an offering of another partner (loader returns null)', async () => {
    h.loadOfferingCandidate.mockResolvedValue(null);
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
  });

  describe('an offering on a disconnected connection (W03 soft-disconnect)', () => {
    const onDisconnected = () => candidate({ connectionId: 'c-gone', funding: 'partner_key' }, {
      platform: null, connection: { kind: 'anthropic_byok', status: 'disconnected', keyUsable: false },
      rate: { source: 'linked_platform', standard: RATES },
    });

    it('enable → 409 not_eligible connection_unavailable, nothing written', async () => {
      h.loadOfferingCandidate.mockResolvedValue(onDisconnected());
      const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false }).catch((e) => e);
      expect(err).toBeInstanceOf(RegistryWriteError);
      expect([err.status, err.code, err.details?.reason]).toEqual([409, 'not_eligible', 'connection_unavailable']);
      expect(h.enableOffering).not.toHaveBeenCalled();
    });

    it.each([false, true])('disable (force %s) stays allowed (idempotent: it is already disabled)', async (force) => {
      h.loadOfferingCandidate.mockResolvedValue(onDisconnected());
      h.enableOffering.mockResolvedValue(row({ enabled: false }));
      const r = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: false, force });
      expect(h.enableOffering).toHaveBeenCalledWith({ partnerId: P, offeringId: OFF, enabled: false });
      expect(r.offering.enabled).toBe(false);
    });
  });

  it('refuses to disable a default offering without force, listing the surfaces', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, { enabled: true }));
    h.dbSelectRows = [[{ surface: 'chat', orgId: null }, { surface: 'helper', orgId: 'org-1' }]];
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: false, force: false }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'offering_in_use']);
    expect(err.details.inUse).toEqual([
      { surface: 'chat', level: 'partner', orgId: null },
      { surface: 'helper', level: 'org', orgId: 'org-1' },
    ]);
    expect(h.enableOffering).not.toHaveBeenCalled();
  });

  it('disables a default offering with force and reports what it affected', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, { enabled: true }));
    h.dbSelectRows = [[{ surface: 'chat', orgId: null }]];
    h.enableOffering.mockResolvedValue(row({ enabled: false }));
    const r = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: false, force: true });
    expect(r.inUse).toEqual([{ surface: 'chat', level: 'partner', orgId: null }]);
    expect(h.enableOffering).toHaveBeenCalledWith({ partnerId: P, offeringId: OFF, enabled: false });
  });
});

describe('ensurePlatformOffering', () => {
  it('inserts a disabled platform offering for an offered platform model', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel());
    h.dbInsertReturning.mockResolvedValue([row()]);
    const o = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false });
    expect([o.enabled, o.source]).toEqual([false, 'platform']);
    expect(h.insertedValues).toMatchObject({ partnerId: P, platformModelId: 'pm-1', connectionId: null, source: 'platform', enabled: false, allowedOptions: null });
  });

  it('takes the partner registry lock before inserting', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel());
    h.dbInsertReturning.mockResolvedValue([row()]);
    await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false });
    expect(h.calls).toEqual([`lock:${P}`, 'insert']);
  });

  it('returns the existing row on conflict (idempotent)', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel());
    h.dbInsertReturning.mockResolvedValue([]);
    h.dbSelectRows = [[row()]];
    expect((await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false })).id).toBe(OFF);
    expect(h.enableOffering).not.toHaveBeenCalled();
  });

  it('on conflict with enabled=true, enables the existing (committed) row through the gated path in the same transaction', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel());
    h.dbInsertReturning.mockResolvedValue([]);
    h.dbSelectRows = [[row({ enabled: false })]];
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.enableOffering.mockResolvedValue(row({ enabled: true }));
    const o = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: true });
    expect(o.enabled).toBe(true);
    expect(h.systemContexts).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('lock:'))).toHaveLength(1);
  });

  it('refuses a platform model the operator does not offer', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel({ platformOffered: false }));
    const err = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'not_eligible']);
    expect(h.dbInsertReturning).not.toHaveBeenCalled();
  });

  it('refuses add-and-enable of a plan-gated model without inserting', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel({ minPlan: 'enterprise' }));
    const err = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: true }).catch((e) => e);
    expect([err.status, err.code, err.details?.reason]).toEqual([409, 'not_eligible', 'plan_required']);
    expect(h.dbInsertReturning).not.toHaveBeenCalled();
  });

  it('refuses add-and-enable when the platform geography cannot serve the model (BD-1: residency_unavailable)', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel());
    h.getPlatformInferenceGeo.mockResolvedValue('eu');
    const err = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: true }).catch((e) => e);
    expect([err.status, err.code, err.details?.reason]).toEqual([409, 'not_eligible', 'residency_unavailable']);
  });

  it('adds AND enables in one insert (never loads its own uncommitted row)', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel());
    h.dbInsertReturning.mockResolvedValue([row({ enabled: true })]);
    await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: true });
    expect(h.loadOfferingCandidate).not.toHaveBeenCalled();
    expect(h.insertedValues).toMatchObject({ enabled: true });
  });

  it('a fast-capable platform model starts with allowed speed [standard] (fast is a deliberate opt-in)', async () => {
    h.getPlatformModelById.mockResolvedValue(platformModel({
      optionRates: { 'speed:fast': RATES }, optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] },
    }));
    h.dbInsertReturning.mockResolvedValue([row()]);
    await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false });
    expect(h.insertedValues?.allowedOptions).toEqual({ speed: ['standard'] });
  });
});

describe('updateOfferingDetails', () => {
  const at = UPDATED.toISOString();
  beforeEach(() => {
    h.getOffering.mockResolvedValue(row());
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.dbUpdateReturning.mockResolvedValue([row({ updatedAt: new Date() })]);
  });

  it('takes the partner registry lock before the update', async () => {
    await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, displayName: 'x' } });
    expect(h.calls).toEqual([`lock:${P}`, 'update']);
    expect(h.lastSet).toMatchObject({ displayName: 'x' });
  });

  it('404s an offering of another partner', async () => {
    h.getOffering.mockResolvedValue(row({ partnerId: '99999999-9999-4999-8999-999999999999' }));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, displayName: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
    expect(h.dbUpdateReturning).not.toHaveBeenCalled();
  });

  it('409s a stale write', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: '2026-09-30T00:00:00.000Z', displayName: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
  });

  it('409s when the guarded UPDATE matches no row (lost a race after the read)', async () => {
    h.dbUpdateReturning.mockResolvedValue([]);
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, displayName: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
  });

  it('accepts expectedUpdatedAt for a row whose DB timestamp has microseconds (ms-precision compare)', async () => {
    h.getOffering.mockResolvedValue(row({ updatedAt: new Date('2026-10-01T10:00:00.123Z') })); // pg value …00.123456 truncates to this
    await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: '2026-10-01T10:00:00.123Z', displayName: 'x' } });
    expect(h.dbUpdateReturning).toHaveBeenCalled();
  });

  it('refuses prices on a platform offering (prices are read from the platform row)', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: RATES } }).catch((e) => e);
    expect([err.status, err.code, err.details.field]).toEqual([422, 'invalid', 'prices']);
  });

  it('accepts zero prices (valid for local models) on a discovered offering', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: null, modelId: 'm' }));
    await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } } });
    expect(h.dbUpdateReturning).toHaveBeenCalled();
    expect(h.lastSet).toMatchObject({ priceInputCentsPerM: 0, priceOutputCentsPerM: 0, priceCacheReadCentsPerM: 0, priceCacheWriteCentsPerM: 0 });
  });

  it('refuses clearing the only price of an enabled connection offering (409 unpriced)', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: null, modelId: 'm', enabled: true, priceInputCentsPerM: 300 }));
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, { rate: { source: 'offering', standard: RATES } }));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: null } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'unpriced']);
    expect(h.dbUpdateReturning).not.toHaveBeenCalled();
  });

  it('clearing own prices on an enabled offering is allowed when the linked platform row is priced', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: 'pm-1', modelId: 'm', enabled: true, priceInputCentsPerM: 300 }));
    h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', rates: RATES });
    h.loadOfferingCandidate.mockResolvedValue(candidate({ funding: 'partner_key' }, { rate: { source: 'offering', standard: RATES } }));
    await expect(updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: null } })).resolves.toBeDefined();
    expect(h.lastSet).toMatchObject({ priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null });
  });

  it('rejects allowed options with an empty intersection with model support', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, allowedOptions: { effort: ['max'] } } }).catch((e) => e);
    expect([err.status, err.details]).toEqual([422, { field: 'allowedOptions', key: 'effort' }]);
  });

  it('rejects a default option outside allowed ∩ support', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: {
      expectedUpdatedAt: at, allowedOptions: { effort: ['low', 'medium'] }, defaultOptions: { effort: 'high' },
    } }).catch((e) => e);
    expect([err.status, err.details]).toEqual([422, { field: 'defaultOptions', key: 'effort' }]);
  });

  it('rejects a new default outside the STORED allowed list (validates the full proposed state)', async () => {
    h.getOffering.mockResolvedValue(row({ allowedOptions: { effort: ['low'] } }));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, defaultOptions: { effort: 'high' } } }).catch((e) => e);
    expect([err.status, err.details]).toEqual([422, { field: 'defaultOptions', key: 'effort' }]);
  });

  it('rejects speed fast on a model with no fast rate', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, defaultOptions: { speed: 'fast' } } }).catch((e) => e);
    expect([err.status, err.details.key]).toEqual([422, 'speed']);
  });

  it('setting own prices drops fast: an existing fast default is rejected against the proposed state', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: 'pm-1', modelId: 'm', defaultOptions: { speed: 'fast' } }));
    h.loadOfferingCandidate.mockResolvedValue(candidate({ funding: 'partner_key', optionRates: { 'speed:fast': RATES },
      optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } }, { rate: { source: 'linked_platform', standard: RATES } }));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: RATES } }).catch((e) => e);
    expect([err.status, err.details]).toEqual([422, { field: 'defaultOptions', key: 'speed' }]);
  });

  it('a BYOK offering inheriting linked platform rates may keep fast (no premium permission needed off platform credits)', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: 'pm-1', modelId: 'm' }));
    h.loadOfferingCandidate.mockResolvedValue(candidate({ funding: 'partner_key', connectionId: 'c-1', optionRates: { 'speed:fast': RATES },
      optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } }, { rate: { source: 'linked_platform', standard: RATES } }));
    await expect(updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, defaultOptions: { speed: 'fast' } } })).resolves.toBeDefined();
  });

  it('spec §15 #7: allowing fast on a platform offering requires the premium permission', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({ optionRates: { 'speed:fast': RATES },
      optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } }));
    h.getOffering.mockResolvedValue(row({ allowedOptions: { speed: ['standard'] }, requiredPermission: null }));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, allowedOptions: { speed: ['standard', 'fast'] } } }).catch((e) => e);
    expect([err.status, err.details.reason]).toEqual([422, 'fast_requires_permission']);
    await expect(updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: {
      expectedUpdatedAt: at, allowedOptions: { speed: ['standard', 'fast'] }, requiredPermission: 'ai_models:premium',
    } })).resolves.toBeDefined();
  });

  describe('fast-permission rule on a W02-projected platform row (allowedOptions + requiredPermission null, fast-rated model)', () => {
    const fastCandidate = () => candidate({ optionRates: { 'speed:fast': RATES },
      optionSupport: { effort: ['low', 'medium', 'high'], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } });
    beforeEach(() => {
      h.loadOfferingCandidate.mockResolvedValue(fastCandidate());
      h.getOffering.mockResolvedValue(row({ allowedOptions: null, requiredPermission: null }));
    });

    it.each([
      ['a rename', { displayName: 'Renamed' }],
      ['an unrelated default option edit', { defaultOptions: { effort: 'low' as const } }],
      ['a refusal-fallback clear', { refusalFallbackOfferingId: null }],
    ])('%s is not refused', async (_l, fields) => {
      await expect(updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, ...fields } })).resolves.toBeDefined();
      expect(h.dbUpdateReturning).toHaveBeenCalled();
    });

    it.each([
      ['re-saving allowed options that keep fast', { allowedOptions: { speed: ['standard', 'fast'] as Array<'standard' | 'fast'> } }],
      ['setting a fast default', { defaultOptions: { speed: 'fast' as const } }],
      ['explicitly clearing the permission', { requiredPermission: null }],
    ])('%s without the permission is still 422', async (_l, fields) => {
      const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, ...fields } }).catch((e) => e);
      expect([err.status, err.details?.reason]).toEqual([422, 'fast_requires_permission']);
    });

    it('a compliant row (premium required) that drops the permission is 422', async () => {
      h.getOffering.mockResolvedValue(row({ allowedOptions: null, requiredPermission: 'ai_models:premium' }));
      const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, requiredPermission: null } }).catch((e) => e);
      expect([err.status, err.details?.reason]).toEqual([422, 'fast_requires_permission']);
    });
  });

  it('a rename never clears option restrictions (untouched fields keep their stored value)', async () => {
    h.getOffering.mockResolvedValue(row({ allowedOptions: { speed: ['standard'] } }));
    await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, displayName: 'Renamed' } });
    expect(h.lastSet).toMatchObject({ displayName: 'Renamed' });
    expect(h.lastSet).not.toHaveProperty('allowedOptions');
    expect(h.lastSet).not.toHaveProperty('defaultOptions');
    expect(h.lastSet).not.toHaveProperty('priceInputCentsPerM');
  });

  it.each([
    ['on a different connection', candidate({ offeringId: FB, connectionId: 'c-2', funding: 'partner_key' }, { enabled: true }), 'different_connection'],
    ['disabled', candidate({ offeringId: FB }, { enabled: false }), 'disabled'],
    ['unpriced', candidate({ offeringId: FB }, { enabled: true, rate: null }), 'unpriced'],
  ])('rejects a refusal fallback that is %s', async (_l, fb, reason) => {
    h.loadOfferingCandidate.mockImplementation(async (id: string) => (id === FB ? fb : candidate()));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: FB } }).catch((e) => e);
    expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', reason]);
    expect(h.dbUpdateReturning).not.toHaveBeenCalled();
  });

  it('rejects a refusal fallback of another partner (loader returns null)', async () => {
    h.loadOfferingCandidate.mockImplementation(async (id: string) => (id === FB ? null : candidate()));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: FB } }).catch((e) => e);
    expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', 'not_found']);
  });

  it('accepts an eligible refusal fallback on the same connection and funding', async () => {
    h.loadOfferingCandidate.mockImplementation(async (id: string) => (id === FB ? candidate({ offeringId: FB }, { enabled: true }) : candidate()));
    await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: FB } });
    expect(h.lastSet).toMatchObject({ refusalFallbackOfferingId: FB });
  });

  it('rejects the offering as its own refusal fallback', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: OFF } }).catch((e) => e);
    expect(err.details.reason).toBe('self');
  });

  describe('W03 soft-disconnect', () => {
    const disconnected = { kind: 'anthropic_byok', status: 'disconnected', keyUsable: false };
    const live = { kind: 'anthropic_byok', status: 'active', keyUsable: true };
    const byok = (id: string, connectionId: string, connection: Record<string, unknown>, enabled: boolean) =>
      candidate({ offeringId: id, connectionId, funding: 'partner_key' }, {
        enabled, platform: null, connection, rate: { source: 'linked_platform', standard: RATES },
      });

    it.each([
      ['a rename', { displayName: 'x' }],
      ['an option edit', { defaultOptions: { effort: 'low' as const } }],
      ['a refusal-fallback clear', { refusalFallbackOfferingId: null }],
    ])('refuses %s of an offering on a disconnected connection: 409 not_eligible connection_unavailable, nothing written', async (_l, fields) => {
      h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-gone', platformModelId: 'pm-1', modelId: 'm' }));
      h.loadOfferingCandidate.mockResolvedValue(byok(OFF, 'c-gone', disconnected, false));
      const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, ...fields } }).catch((e) => e);
      expect(err).toBeInstanceOf(RegistryWriteError);
      expect([err.status, err.code, err.details]).toEqual([409, 'not_eligible', { reason: 'connection_unavailable' }]);
      expect(err.message).toBe("This model's connection is disconnected.");
      expect(h.dbUpdateReturning).not.toHaveBeenCalled();
    });

    // A reconnect creates a NEW connection, so an offering on the live one and a
    // disconnected offering never share a connection: different_connection.
    it('rejects a refusal fallback on the disconnected (previous) connection', async () => {
      h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-new', platformModelId: 'pm-1', modelId: 'm' }));
      h.loadOfferingCandidate.mockImplementation(async (id: string) => (id === FB
        ? byok(FB, 'c-gone', disconnected, false)
        : byok(OFF, 'c-new', live, true)));
      const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: FB } }).catch((e) => e);
      expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', 'different_connection']);
      expect(h.dbUpdateReturning).not.toHaveBeenCalled();
    });

    // Defence in depth past the connection check: a disconnected offering is
    // disabled, and even an enabled one fails the enable gate.
    it.each([
      ['disabled (as disconnectCompat leaves it)', false, 'disabled'],
      ['still enabled (never left by W03, defence in depth)', true, 'connection_unavailable'],
    ])('rejects a disconnected refusal fallback that is %s', async (_l, enabled, reason) => {
      h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: 'pm-1', modelId: 'm' }));
      h.loadOfferingCandidate.mockImplementation(async (id: string) => (id === FB
        ? byok(FB, 'c-1', disconnected, enabled)
        : byok(OFF, 'c-1', live, true)));
      const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: FB } }).catch((e) => e);
      expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', reason]);
      expect(h.dbUpdateReturning).not.toHaveBeenCalled();
    });
  });
});
