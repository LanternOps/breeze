/**
 * W05 (#7603): budget-mode thinking on the wire, and the locked-surface rule.
 * The mocks mirror resolveModel.test.ts, except that ./wireParams is the REAL
 * module, because these cases are about what reaches the wire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCandidate } from './candidateLoader';

const m = vi.hoisted(() => ({
  getEffectiveAssignment: vi.fn(),
  loadOfferingCandidate: vi.fn(),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
  loadUserPermissionPredicate: vi.fn(async () => () => true),
  carriage: { speed: true, inferenceGeo: true, thinkingDisplayUpdates: false, budgetThinking: true },
}));
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: vi.fn(async () => true) }));
vi.mock('./assignments', () => ({
  getEffectiveAssignment: m.getEffectiveAssignment,
  isPermitted: (set: { kind: 'all' } | { kind: 'list'; offeringIds: string[] }, id: string) =>
    set.kind === 'all' || set.offeringIds.includes(id),
}));
vi.mock('./transport', () => ({
  defaultTransport: () => 'agent_sdk',
  transportCarries: (t: string) => (t === 'messages_api' ? { ...m.carriage, budgetThinking: false } : m.carriage),
}));
vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: m.loadOfferingCandidate,
  loadPlatformDefaultCandidate: vi.fn(),
  loadPartnerFacts: m.loadPartnerFacts,
  loadUserPermissionPredicate: m.loadUserPermissionPredicate,
}));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { resolveModel } from './resolveModel';
import { BUDGET_THINKING_DEFAULT_TOKENS } from './wireParams';

const STD = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };

function cand(id: string, thinkingMode: 'adaptive' | 'budget' = 'adaptive'): LoadedCandidate {
  return {
    offeringId: id,
    connectionId: null,
    displayName: `Model ${id}`,
    logicalModel: `logical-${id}`,
    wireModel: `wire-${id}`,
    connection: { id: null, kind: 'platform', config: { source: 'platform', apiKey: 'k', model: `logical-${id}` } },
    funding: 'platform',
    capabilities: { thinkingMode, effortLevels: thinkingMode === 'adaptive' ? ['low', 'medium', 'high'] : [], supportsTools: true, supportsVision: false },
    optionSupport: thinkingMode === 'adaptive'
      ? { effort: ['low', 'medium', 'high'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: [] }
      : { effort: [], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: [] },
    optionRates: null,
    defaultOptions: null,
    allowedOptions: null,
    refusalFallbackOfferingId: null,
    promptProfile: 'claude-standard',
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    facts: {
      ownerPartnerId: 'p1', enabled: true, lifecycle: 'available', requiredPermission: null,
      platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
      connection: { kind: 'platform', status: 'active', keyUsable: true },
      catalog: null, rate: { source: 'platform', standard: STD },
      supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
    },
  };
}

function assignment(over: Record<string, unknown> = {}) {
  return {
    surface: 'chat', role: 'default', defaultOfferingId: 'def', defaultSource: 'partner',
    permitted: { kind: 'list', offeringIds: ['def', 'alt', 'haiku'] }, allowUserChoice: true,
    options: { effort: 'medium' }, fallbackOfferingIds: null, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getEffectiveAssignment.mockResolvedValue(assignment());
  m.loadOfferingCandidate.mockImplementation(async (id: string) =>
    (id === 'haiku' ? cand('haiku', 'budget') : ['def', 'alt'].includes(id) ? cand(id) : null));
});

const base = { partnerId: 'p1', orgId: 'o1', userId: 'u1', surface: 'chat' as const };

describe('resolveModel: budget thinking (W05)', () => {
  it('on is applied on the Agent SDK for a budget-mode model', async () => {
    const r = await resolveModel({ ...base, requested: { offeringId: 'haiku', options: { budgetThinking: 'on' }, origin: 'user' } });
    expect(r.ok && r.wireParams.thinking).toEqual({ type: 'enabled', budget_tokens: BUDGET_THINKING_DEFAULT_TOKENS });
    expect(r.ok && r.options.budgetThinking).toBe('on');
  });
  it('on is stripped on messages_api and never applied', async () => {
    const r = await resolveModel({
      ...base, transport: 'messages_api',
      requested: { offeringId: 'haiku', options: { budgetThinking: 'on' }, origin: 'user' },
    });
    expect(r.ok && r.wireParams.thinking).toEqual({ type: 'disabled' });
    expect(r.ok && r.options.budgetThinking).toBeUndefined();
  });
});

describe('resolveModel: locked surface (W05, spec §11 "all hidden when allow_user_choice is false")', () => {
  beforeEach(() => { m.getEffectiveAssignment.mockResolvedValue(assignment({ allowUserChoice: false })); });

  it('user options on a locked surface → not_permitted, even on the default offering', async () => {
    const r = await resolveModel({ ...base, requested: { offeringId: 'def', options: { effort: 'high' }, origin: 'user' } });
    expect(r).toMatchObject({ ok: false, reason: 'not_permitted' });
  });
  it('a user request for the default with no options still resolves', async () => {
    const r = await resolveModel({ ...base, requested: { offeringId: 'def', origin: 'user' } });
    expect(r).toMatchObject({ ok: true, offering: { id: 'def' } });
  });
  it('stored session options are ignored: the assignment options apply', async () => {
    const r = await resolveModel({ ...base, requested: { offeringId: 'def', options: { effort: 'high' }, origin: 'session' } });
    expect(r.ok && r.options.effort).toBe('medium');
  });
  it('a stored non-default session choice falls back to the default WITHOUT its stored options', async () => {
    const r = await resolveModel({ ...base, requested: { offeringId: 'alt', options: { effort: 'high' }, origin: 'session' } });
    expect(r).toMatchObject({ ok: true, offering: { id: 'def' }, fellBack: true });
    expect(r.ok && r.options.effort).toBe('medium');
  });
  it('a user request for a non-default offering is refused (W03 rule, unchanged)', async () => {
    const r = await resolveModel({ ...base, requested: { offeringId: 'alt', origin: 'user' } });
    expect(r).toMatchObject({ ok: false, reason: 'not_permitted', offeringId: 'alt' });
  });
  it('policy options are unaffected by the lock (agents are configured, not chosen per turn)', async () => {
    const r = await resolveModel({ ...base, surface: 'ai_agents', userId: null,
      requested: { offeringId: 'def', options: { effort: 'high' }, origin: 'policy' } });
    expect(r.ok && r.options.effort).toBe('high');
  });
  it('an unlocked surface keeps the user options', async () => {
    m.getEffectiveAssignment.mockResolvedValue(assignment());
    const r = await resolveModel({ ...base, requested: { offeringId: 'alt', options: { effort: 'high' }, origin: 'user' } });
    expect(r.ok && r.options.effort).toBe('high');
  });
});
