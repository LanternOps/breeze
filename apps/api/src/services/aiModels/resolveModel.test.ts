import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCandidate } from './candidateLoader';

const m = vi.hoisted(() => ({
  getEffectiveAssignment: vi.fn(),
  loadOfferingCandidate: vi.fn(),
  loadPlatformDefaultCandidate: vi.fn(),
  loadPartnerFacts: vi.fn(),
  loadUserPermissionPredicate: vi.fn(),
  isHosted: vi.fn(() => true),
  transportCarries: vi.fn(() => ({ speed: true, inferenceGeo: true, thinkingDisplayUpdates: true, budgetThinking: true })),
  ensurePartnerCutover: vi.fn(async (_partnerId: string) => true),
}));
// Task 6A: the resolver gates on the partner's registry cutover.
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: m.ensurePartnerCutover }));
vi.mock('./assignments', () => ({
  getEffectiveAssignment: m.getEffectiveAssignment,
  isPermitted: (set: { kind: 'all' } | { kind: 'list'; offeringIds: string[] }, id: string) =>
    set.kind === 'all' || set.offeringIds.includes(id),
}));
vi.mock('./transport', () => ({
  defaultTransport: () => 'agent_sdk',
  transportCarries: m.transportCarries,
}));
vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: m.loadOfferingCandidate,
  loadPlatformDefaultCandidate: m.loadPlatformDefaultCandidate,
  loadPartnerFacts: m.loadPartnerFacts,
  loadUserPermissionPredicate: m.loadUserPermissionPredicate,
}));
vi.mock('../../config/env', () => ({ isHosted: m.isHosted }));
// The resolver reads the assignment in system context, like the loader does.
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
// A faithful stand-in for W01's buildWireParams: clamp each requested key to support.
vi.mock('./wireParams', () => ({
  buildWireParams: vi.fn((i: {
    thinkingMode: string;
    optionSupport: { effort: string[]; speed: string[]; thinkingDisplay: string[]; inferenceGeo: string[] };
    requested: { effort?: string; speed?: string; thinkingDisplay?: string };
    inferenceGeo?: string | null;
  }) => {
    const applied: Record<string, string> = {};
    if (i.requested.effort && i.optionSupport.effort.includes(i.requested.effort)) applied.effort = i.requested.effort;
    if (i.requested.speed && i.optionSupport.speed.includes(i.requested.speed)) applied.speed = i.requested.speed;
    if (i.requested.thinkingDisplay && i.optionSupport.thinkingDisplay.includes(i.requested.thinkingDisplay)) {
      applied.thinkingDisplay = i.requested.thinkingDisplay;
    }
    const geo = i.inferenceGeo && i.optionSupport.inferenceGeo.includes(i.inferenceGeo) ? i.inferenceGeo : undefined;
    return {
      ...(i.thinkingMode === 'adaptive' ? { thinking: { type: 'adaptive' } } : {}),
      ...(applied.effort ? { effort: applied.effort } : {}),
      ...(applied.speed === 'fast' ? { speed: 'fast' } : {}),
      ...(geo ? { inferenceGeo: geo } : {}),
      betas: applied.speed === 'fast' ? ['fast-mode-2026-02-01'] : [],
      applied,
    };
  }),
}));

import { resolveModel } from './resolveModel';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FAST = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 500 };

function cand(id: string, over: Partial<LoadedCandidate> = {}, facts: Partial<LoadedCandidate['facts']> = {}): LoadedCandidate {
  const connectionId = over.connectionId ?? null;
  return {
    offeringId: id,
    connectionId,
    displayName: `Model ${id}`,
    logicalModel: `logical-${id}`,
    wireModel: `wire-${id}`,
    connection: connectionId === null
      ? { id: null, kind: 'platform', config: { source: 'platform', apiKey: 'k', model: `logical-${id}` } }
      : { id: connectionId, kind: 'anthropic_byok', config: {
          source: 'partner', partnerId: 'p1', apiKey: 'pk', model: `logical-${id}`,
          configId: connectionId, configVersion: 3, endpoint: { kind: 'anthropic' } } },
    funding: connectionId === null ? 'platform' : 'partner_key',
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max'], supportsTools: true, supportsVision: false },
    optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['summarized', 'updates'], speed: ['standard', 'fast'], inferenceGeo: ['us', 'eu'] },
    optionRates: { 'speed:fast': FAST },
    defaultOptions: null,
    allowedOptions: null,
    refusalFallbackOfferingId: null,
    promptProfile: 'claude-standard',
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    ...over,
    facts: {
      ownerPartnerId: 'p1',
      enabled: true,
      lifecycle: 'available',
      requiredPermission: null,
      platform: connectionId === null ? { platformOffered: true, lifecycle: 'available', minPlan: null } : null,
      connection: { kind: connectionId === null ? 'platform' : 'anthropic_byok', status: 'active', keyUsable: true },
      catalog: null,
      rate: { source: connectionId === null ? 'platform' : 'linked_platform', standard: STD },
      supportsTools: true,
      inferenceGeo: null,
      supportedInferenceGeos: ['us', 'eu'],
      ...facts,
    },
  };
}

const ASSIGNMENT = {
  surface: 'chat', role: 'default', defaultOfferingId: 'def', defaultSource: 'partner',
  permitted: { kind: 'list', offeringIds: ['def', 'alt'] }, allowUserChoice: true, options: {},
  fallbackOfferingIds: [], fallbackMayCrossFunding: false, warnings: [],
};
const BASE = { partnerId: 'p1', orgId: 'o1', surface: 'chat' as const };

let candidates: Record<string, LoadedCandidate | null>;

beforeEach(() => {
  vi.clearAllMocks();
  candidates = { def: cand('def'), alt: cand('alt') };
  m.getEffectiveAssignment.mockResolvedValue(ASSIGNMENT);
  m.transportCarries.mockReturnValue({ speed: true, inferenceGeo: true, thinkingDisplayUpdates: true, budgetThinking: true });
  m.loadOfferingCandidate.mockImplementation(async (id: string) => candidates[id] ?? null);
  m.loadPartnerFacts.mockResolvedValue({ plan: 'pro', residencyRequired: false });
  m.loadUserPermissionPredicate.mockResolvedValue(() => false);
  m.ensurePartnerCutover.mockResolvedValue(true);
});

describe('resolveModel — registry cutover gate (Task 6A)', () => {
  it('a partner that could not be cut over refuses (recoverable) before any registry read', async () => {
    m.ensurePartnerCutover.mockResolvedValue(false);
    const r = await resolveModel(BASE);
    expect(r).toMatchObject({ ok: false, reason: 'registry_unavailable', recoverable: true, offeringId: null });
    expect(r.ok === false && r.message).toBe('AI configuration is being upgraded. Try again in a moment.');
    expect(m.ensurePartnerCutover).toHaveBeenCalledWith('p1');
    expect(m.getEffectiveAssignment).not.toHaveBeenCalled();
    expect(m.loadOfferingCandidate).not.toHaveBeenCalled();
  });

  it('a cut-over partner resolves normally', async () => {
    expect(await resolveModel(BASE)).toMatchObject({ ok: true });
    expect(m.ensurePartnerCutover).toHaveBeenCalledWith('p1');
  });
});

describe('resolveModel — candidate selection', () => {
  it('uses the effective default when nothing is requested', async () => {
    const r = await resolveModel(BASE);
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-def', funding: 'platform', fellBack: false, promptProfile: 'claude-standard' });
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'chat', role: 'default' });
  });

  it('honours a user request inside the permitted set when user choice is allowed', async () => {
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'alt' } });
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-alt' });
  });

  it('refuses a user request when allow_user_choice is false (no fallback for a fresh choice)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, allowUserChoice: false });
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'alt', origin: 'user' } });
    expect(r).toMatchObject({ ok: false, reason: 'not_permitted', recoverable: true });
  });

  it('refuses a user request outside the permitted set', async () => {
    candidates.out = cand('out');
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'out' } });
    expect(r).toMatchObject({ ok: false, reason: 'not_permitted' });
    expect(m.loadOfferingCandidate).not.toHaveBeenCalledWith('out', 'p1');
  });

  it('a foreign offering id is not_permitted and reveals nothing (loader returned null)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, permitted: { kind: 'all' } });
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'foreign' } });
    expect(r).toEqual({
      ok: false, reason: 'not_permitted', recoverable: true, offeringId: 'foreign',
      message: 'This AI model is not available here. Choose another model.',
    });
  });

  it('a policy choice ignores allow_user_choice but still needs the permitted set', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, allowUserChoice: false });
    expect(await resolveModel({ ...BASE, surface: 'ai_agents', requested: { offeringId: 'alt', origin: 'policy' } }))
      .toMatchObject({ ok: true, wireModel: 'wire-alt', fellBack: false });
  });

  it('returns no_eligible_model when the surface has no assignment', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, defaultOfferingId: null, defaultSource: 'none' });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'no_eligible_model' });
  });

  it('rejects a role the surface does not define', async () => {
    await expect(resolveModel({ ...BASE, role: 'triage' })).rejects.toThrow(/not a role of chat/);
  });
});

describe('resolveModel — §9.1 bounded fallback for stored choices', () => {
  it('stored session offering disabled → falls back to the default on the same connection', async () => {
    candidates.alt = cand('alt', {}, { enabled: false });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });

  it('stored offering now outside the permitted set → falls back the same way', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, permitted: { kind: 'list', offeringIds: ['def'] } });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });

  it('refuses when the default is on a different connection', async () => {
    candidates.alt = cand('alt', { connectionId: 'conn-A' }, { enabled: false });
    candidates.def = cand('def', { connectionId: 'conn-B' });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: 'alt' });
    expect((r as { message: string }).message).toBe('Model Model alt is no longer available — choose another.');
  });

  it('refuses when the default changes funding (BYOK stored, platform default)', async () => {
    candidates.alt = cand('alt', { connectionId: 'conn-A' }, { enabled: false });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  it('refuses when the default itself is ineligible (exactly one candidate)', async () => {
    candidates.alt = cand('alt', {}, { enabled: false });
    candidates.def = cand('def', {}, { platform: { platformOffered: false, lifecycle: 'available', minPlan: null } });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(m.loadOfferingCandidate).toHaveBeenCalledTimes(2);
  });

  it('a deleted stored offering cannot prove its connection, so it refuses', async () => {
    candidates.alt = null;
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: false, reason: 'not_permitted' });
  });

  it('plan downgrade below min_plan → plan_required on the stored platform model, same-connection default serves', async () => {
    candidates.alt = cand('alt', {}, { platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });
});

describe('resolveModel — gates that need request context', () => {
  it('loads the permission predicate only for user-initiated calls', async () => {
    candidates.def = cand('def', {}, { requiredPermission: 'ai_models:premium' });
    expect(await resolveModel({ ...BASE, userId: 'u1' })).toMatchObject({ ok: false, reason: 'permission_required' });
    expect(m.loadUserPermissionPredicate).toHaveBeenCalledWith('u1', 'p1', 'o1');
    m.loadUserPermissionPredicate.mockClear();
    expect(await resolveModel({ ...BASE, surface: 'ai_agents' })).toMatchObject({ ok: true });
    expect(m.loadUserPermissionPredicate).not.toHaveBeenCalled();
  });

  it('residency required: fails closed', async () => {
    m.loadPartnerFacts.mockResolvedValue({ plan: 'pro', residencyRequired: true });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'residency_unavailable' });
    candidates.def = cand('def', {}, { inferenceGeo: 'eu' });
    expect(await resolveModel(BASE)).toMatchObject({ ok: true, inferenceGeo: 'eu' });
  });
});

describe('resolveModel — §7 options', () => {
  it('request beats assignment beats offering default, per key', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, options: { effort: 'low', thinkingDisplay: 'summarized' } });
    candidates.def = cand('def', { defaultOptions: { effort: 'high', thinkingDisplay: 'updates', speed: 'standard' } });
    const r = await resolveModel({ ...BASE, requested: { options: { effort: 'max' } } });
    expect(r).toMatchObject({ ok: true, options: { effort: 'max', thinkingDisplay: 'summarized', speed: 'standard' } });
  });

  it('allowed_options clamps support (a disallowed effort is omitted, never sent)', async () => {
    candidates.def = cand('def', { allowedOptions: { effort: ['low', 'medium'] } });
    const r = await resolveModel({ ...BASE, requested: { options: { effort: 'max' } } });
    expect(r).toMatchObject({ ok: true });
    expect((r as { options: object }).options).not.toHaveProperty('effort');
  });

  it('fast is selectable only with an option rate, and then the snapshot carries it', async () => {
    candidates.def = cand('def', { optionRates: null });
    const noRate = await resolveModel({ ...BASE, requested: { options: { speed: 'fast' } } });
    expect((noRate as { options: object }).options).not.toHaveProperty('speed');
    expect((noRate as { rateSnapshot: object }).rateSnapshot).not.toHaveProperty('option');

    candidates.def = cand('def');
    const withRate = await resolveModel({ ...BASE, requested: { options: { speed: 'fast' } } });
    expect(withRate).toMatchObject({
      ok: true,
      options: { speed: 'fast' },
      rateSnapshot: { source: 'platform', standard: STD, option: { key: 'speed:fast', rates: FAST } },
    });
  });
});

describe('resolveModel — transport carriage (W01 adapters refuse what they cannot send)', () => {
  it('fast and geo are never applied — or priced — on a transport that cannot carry them', async () => {
    m.transportCarries.mockReturnValue({ speed: false, inferenceGeo: false, thinkingDisplayUpdates: false, budgetThinking: false });
    candidates.def = cand('def', {}, { inferenceGeo: 'eu' });
    const r = await resolveModel({ ...BASE, requested: { options: { speed: 'fast', thinkingDisplay: 'updates' } } });
    expect(r).toMatchObject({ ok: true, inferenceGeo: null, transport: 'agent_sdk' });
    expect((r as { options: object }).options).toEqual({});
    expect((r as { rateSnapshot: object }).rateSnapshot).not.toHaveProperty('option');
  });

  it('residency required on a transport that cannot carry a geography fails closed', async () => {
    m.transportCarries.mockReturnValue({ speed: true, inferenceGeo: false, thinkingDisplayUpdates: true, budgetThinking: true });
    m.loadPartnerFacts.mockResolvedValue({ plan: 'pro', residencyRequired: true });
    candidates.def = cand('def', {}, { inferenceGeo: 'eu' });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'residency_unavailable' });
  });
});

describe('resolveModel — refusal fallback', () => {
  it('Messages API: carries an eligible same-connection fallback with its own (different) rate', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', {}, { rate: { source: 'platform', standard: FAST } });
    const r = await resolveModel({ ...BASE, transport: 'messages_api' });
    expect(r).toMatchObject({
      ok: true,
      refusalFallback: { offeringId: 'fb', wireModel: 'wire-fb', rateSnapshot: { source: 'platform', standard: FAST } },
    });
  });

  it('Agent SDK: a differently priced fallback is dropped (overload fallback is unattributable, finding 3)', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', {}, { rate: { source: 'platform', standard: FAST } });
    expect(await resolveModel({ ...BASE, transport: 'agent_sdk' })).not.toHaveProperty('refusalFallback');
  });

  it('Agent SDK: an equally priced fallback is carried', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb');
    expect(await resolveModel({ ...BASE, transport: 'agent_sdk' })).toMatchObject({ refusalFallback: { offeringId: 'fb' } });
  });

  it('drops a fallback on another connection', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', { connectionId: 'conn-X' });
    expect(await resolveModel(BASE)).not.toHaveProperty('refusalFallback');
  });

  it('drops an ineligible fallback', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', {}, { rate: null });
    expect(await resolveModel(BASE)).not.toHaveProperty('refusalFallback');
  });
});

describe('resolveModel — platform-only system surface', () => {
  it('patch_test resolves the platform default with no partner and no assignment', async () => {
    m.loadPlatformDefaultCandidate.mockResolvedValue(cand('sys', { offeringId: null }, { ownerPartnerId: null }));
    const r = await resolveModel({ partnerId: null, orgId: null, surface: 'patch_test' });
    expect(r).toMatchObject({ ok: true, funding: 'platform', offering: { id: null } });
    expect(m.getEffectiveAssignment).not.toHaveBeenCalled();
  });

  it('a partnerless call on a tenant surface is a programming error', async () => {
    await expect(resolveModel({ partnerId: null, orgId: null, surface: 'chat' })).rejects.toThrow(/requires a partner/);
  });
});

describe('resolveModel — dispatcher-pinned invariants', () => {
  it('fallbackMayCrossFunding: true (a W09 flag) does NOT let the bounded fallback cross funding', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, fallbackMayCrossFunding: true });
    candidates.alt = cand('alt', { connectionId: 'conn-A' }, { enabled: false });   // BYOK stored, platform default
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: false, reason: 'model_unavailable', offeringId: 'alt' });
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, fallbackMayCrossFunding: true });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'policy' } }))
      .toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  it('fallbackMayCrossFunding: true does NOT let the refusal fallback cross funding or connection', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, fallbackMayCrossFunding: true });
    candidates.def = cand('def', { connectionId: 'conn-A', refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb');   // platform-funded
    const r = await resolveModel({ ...BASE, transport: 'messages_api' });
    expect(r).toMatchObject({ ok: true, funding: 'partner_key' });
    expect(r).not.toHaveProperty('refusalFallback');
  });

  it('the partner default stays reachable when an org narrowing excludes it (no isPermitted re-check, spec §5.4)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, permitted: { kind: 'list', offeringIds: ['alt'] } });
    expect(await resolveModel(BASE)).toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: false });
    expect(await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'def', origin: 'user' } }))
      .toMatchObject({ ok: true, wireModel: 'wire-def' });
    // …and serves as the bounded fallback for a stored choice the narrowing dropped.
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, permitted: { kind: 'list', offeringIds: [] } });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });

  it('an active connection whose key will not decrypt → connection_unavailable, never a keyless dispatch', async () => {
    candidates.def = cand('def', { connectionId: 'conn-A', connection: null }, { connection: { kind: 'anthropic_byok', status: 'active', keyUsable: false } });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'connection_unavailable', offeringId: 'def' });
  });

  it('an unpriced model is never returned ok (unpriced), as primary or as the bounded fallback', async () => {
    candidates.def = cand('def', {}, { rate: null });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'unpriced' });
    candidates.alt = cand('alt', {}, { enabled: false });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  it('a fast request on a candidate with no speed:fast rate is neither sent nor priced, even if support lists fast', async () => {
    candidates.def = cand('def', { optionRates: {} });
    const r = await resolveModel({ ...BASE, requested: { options: { speed: 'fast' } } });
    expect(r).toMatchObject({ ok: true });
    expect((r as { wireParams: object }).wireParams).not.toHaveProperty('speed');
    expect((r as { rateSnapshot: object }).rateSnapshot).not.toHaveProperty('option');
  });

  it('the bound rate snapshot always prices what is sent: fast sent ⇔ fast rate bound', async () => {
    const r = await resolveModel({ ...BASE, requested: { options: { speed: 'fast' } } });
    expect((r as { wireParams: { speed?: string } }).wireParams.speed).toBe('fast');
    expect((r as { rateSnapshot: { option?: { key: string } } }).rateSnapshot.option?.key).toBe('speed:fast');
  });
});
