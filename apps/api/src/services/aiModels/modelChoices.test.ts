import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCandidate } from './candidateLoader';

const m = vi.hoisted(() => ({
  ensurePartnerCutover: vi.fn(async () => true),
  getEffectiveAssignment: vi.fn(),
  listOfferings: vi.fn(),
  loadOfferingCandidate: vi.fn(),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
  loadUserPermissionPredicate: vi.fn(async (): Promise<(k: string) => boolean> => (_k: string) => false),
  rolesGrantingPermission: vi.fn(async () => ['Senior Tech']),
  carriage: { speed: true, inferenceGeo: false, thinkingDisplayUpdates: false, budgetThinking: true },
}));
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: m.ensurePartnerCutover }));
vi.mock('./assignments', () => ({
  getEffectiveAssignment: m.getEffectiveAssignment,
  isPermitted: (set: { kind: 'all' } | { kind: 'list'; offeringIds: string[] }, id: string) =>
    set.kind === 'all' || set.offeringIds.includes(id),
}));
vi.mock('./offerings', () => ({ listOfferings: m.listOfferings }));
vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: m.loadOfferingCandidate,
  loadPlatformDefaultCandidate: vi.fn(),
  loadPartnerFacts: m.loadPartnerFacts,
  loadUserPermissionPredicate: m.loadUserPermissionPredicate,
}));
vi.mock('./transport', () => ({
  defaultTransport: () => 'agent_sdk',
  // messages_api never carries a manual budget or fast (V5 / Task 2).
  transportCarries: (t: string) => (t === 'messages_api'
    ? { ...m.carriage, speed: false, budgetThinking: false }
    : m.carriage),
}));
vi.mock('./permissionRoles', () => ({ rolesGrantingPermission: m.rolesGrantingPermission }));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { listModelChoices } from './modelChoices';
import { defaultOptionsFor, pickerOptionSupport, resolveModel } from './resolveModel';
import { LlmUnavailableError } from '../llm/llmUnavailableError';

const STD = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const FAST = { inputCentsPerM: 600, outputCentsPerM: 3000, cacheReadCentsPerM: 60, cacheWriteCentsPerM: 750 };

function cand(id: string, over: { name?: string; owner?: string; perm?: string | null; minPlan?: string | null; mode?: 'adaptive' | 'budget'; fast?: boolean; window?: number } = {}): LoadedCandidate {
  const mode = over.mode ?? 'adaptive';
  return {
    offeringId: id, connectionId: null, displayName: over.name ?? `Model ${id}`,
    logicalModel: `logical-${id}`, wireModel: `wire-${id}`,
    connection: { id: null, kind: 'platform', config: { source: 'platform', apiKey: 'k', model: `logical-${id}` } },
    funding: 'platform',
    capabilities: { thinkingMode: mode, effortLevels: mode === 'adaptive' ? ['low', 'medium', 'high'] : [], supportsTools: true, supportsVision: false },
    optionSupport: {
      effort: mode === 'adaptive' ? ['low', 'medium', 'high'] : [], thinkingDisplay: ['summarized'],
      speed: over.fast ? ['standard', 'fast'] : ['standard'], inferenceGeo: [],
    },
    optionRates: over.fast ? { 'speed:fast': FAST } : null,
    defaultOptions: null, allowedOptions: null, refusalFallbackOfferingId: null, promptProfile: 'claude-standard',
    limits: { maxInputTokens: over.window ?? 1_000_000, maxOutputTokens: 64000 },
    facts: {
      ownerPartnerId: over.owner ?? 'p1', enabled: true, lifecycle: 'available', requiredPermission: over.perm ?? null,
      platform: { platformOffered: true, lifecycle: 'available', minPlan: (over.minPlan ?? null) as never },
      connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
      rate: { source: 'platform', standard: STD }, supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
    },
  };
}

const catalog = {
  def: cand('def', { name: 'Sonnet 5.5' }),
  opus: cand('opus', { name: 'Opus 5.5', perm: 'ai_models:premium', fast: true }),
  haiku: cand('haiku', { name: 'Haiku 4.5', mode: 'budget', window: 200_000 }),
  foreign: cand('foreign', { owner: 'p2' }),
  enterprise: cand('enterprise', { name: 'Fable', perm: 'ai_models:premium', minPlan: 'enterprise' }),
  unpermitted: cand('unpermitted', { name: 'Unpermitted' }),
} satisfies Record<string, LoadedCandidate>;
const byId: Record<string, LoadedCandidate> = catalog;

function assignment(over: Record<string, unknown> = {}) {
  return {
    surface: 'chat', role: 'default', defaultOfferingId: 'def', defaultSource: 'partner',
    permitted: { kind: 'list', offeringIds: ['haiku', 'opus', 'foreign', 'enterprise', 'missing'] },
    allowUserChoice: true, options: { effort: 'medium' }, fallbackOfferingIds: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getEffectiveAssignment.mockResolvedValue(assignment());
  m.loadOfferingCandidate.mockImplementation(async (id: string) => byId[id] ?? null);
});

const input = { partnerId: 'p1', orgId: 'o1', userId: 'u1', surface: 'chat' as const };

describe('listModelChoices (W05)', () => {
  it('lists the default first, then permitted eligible offerings by name', async () => {
    const r = await listModelChoices(input);
    expect(r.choices.map((c) => c.offeringId)).toEqual(['def', 'haiku', 'opus']);
    expect(r.defaultOfferingId).toBe('def');
    expect(r.allowUserChoice).toBe(true);
  });
  it('never lists another partner\'s offering, nor a missing id', async () => {
    const r = await listModelChoices(input);
    expect(r.choices.map((c) => c.offeringId)).not.toContain('foreign');
    expect(r.choices.map((c) => c.offeringId)).not.toContain('missing');
  });
  it('never lists another partner\'s offering even as the session\'s current choice', async () => {
    const r = await listModelChoices({ ...input, current: { offeringId: 'foreign', options: null } });
    expect(r.choices.map((c) => c.offeringId)).not.toContain('foreign');
  });
  it('a current choice the assignment no longer permits is not offered (a user pick of it would be refused)', async () => {
    const r = await listModelChoices({ ...input, current: { offeringId: 'unpermitted', options: null } });
    expect(r.choices.map((c) => c.offeringId)).not.toContain('unpermitted');
    expect(r.current).toEqual({ offeringId: 'unpermitted', options: null });
  });
  it('lists a permission-gated offering disabled, with the roles that grant it', async () => {
    const opus = (await listModelChoices(input)).choices.find((c) => c.offeringId === 'opus')!;
    expect(opus.disabled).toEqual({ reason: 'permission_required', permission: 'ai_models:premium', roleNames: ['Senior Tech'] });
    expect(m.rolesGrantingPermission).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' });
  });
  it('hides a permission-gated offering that would ALSO fail another rule (plan)', async () => {
    const r = await listModelChoices(input);
    expect(r.choices.map((c) => c.offeringId)).not.toContain('enterprise');
  });
  it('a user holding the permission gets it enabled', async () => {
    m.loadUserPermissionPredicate.mockResolvedValueOnce((k: string) => k === 'ai_models:premium');
    const opus = (await listModelChoices(input)).choices.find((c) => c.offeringId === 'opus')!;
    expect(opus.disabled).toBeNull();
  });
  it('shows context size, price hint and the fast rate only where Fast is selectable', async () => {
    const r = await listModelChoices(input);
    const opus = r.choices.find((c) => c.offeringId === 'opus')!;
    expect(opus.contextTokens).toBe(1_000_000);
    expect(opus.priceHint).toEqual({ inputCentsPerM: 300, outputCentsPerM: 1500, fast: { inputCentsPerM: 600, outputCentsPerM: 3000 } });
    expect(opus.options.speed).toEqual(['standard', 'fast']);
    expect(r.choices.find((c) => c.offeringId === 'def')!.priceHint.fast).toBeNull();
  });
  it('no fast rate and no Fast option while the transport cannot carry fast (L1 not passed)', async () => {
    m.carriage = { ...m.carriage, speed: false };
    const opus = (await listModelChoices(input)).choices.find((c) => c.offeringId === 'opus')!;
    expect(opus.options.speed).toEqual(['standard']);
    expect(opus.priceHint.fast).toBeNull();
    m.carriage = { ...m.carriage, speed: true };
  });
  it('a budget-mode model offers the thinking toggle and no effort', async () => {
    const haiku = (await listModelChoices(input)).choices.find((c) => c.offeringId === 'haiku')!;
    expect(haiku.options).toEqual({ effort: [], speed: ['standard'], budgetThinking: true });
    expect(haiku.thinkingMode).toBe('budget');
  });
  it('defaults are the assignment options clamped to the model', async () => {
    const r = await listModelChoices(input);
    expect(r.choices.find((c) => c.offeringId === 'def')!.defaults).toEqual({ effort: 'medium' });
    expect(r.choices.find((c) => c.offeringId === 'haiku')!.defaults).toEqual({});
  });
  it('a locked chat surface returns no choices and allowUserChoice false', async () => {
    m.getEffectiveAssignment.mockResolvedValue(assignment({ allowUserChoice: false }));
    const r = await listModelChoices(input);
    expect(r).toMatchObject({ allowUserChoice: false, choices: [] });
    expect(m.loadOfferingCandidate).not.toHaveBeenCalled();
  });
  it('the agent picker ignores allow_user_choice (a policy is configuration)', async () => {
    m.getEffectiveAssignment.mockResolvedValue(assignment({ surface: 'ai_agents', allowUserChoice: false }));
    const r = await listModelChoices({ ...input, surface: 'ai_agents' });
    expect(r.allowUserChoice).toBe(true);
    expect(r.choices.length).toBeGreaterThan(0);
  });
  it('permitted = all lists the partner\'s enabled offerings', async () => {
    m.getEffectiveAssignment.mockResolvedValue(assignment({ permitted: { kind: 'all' } }));
    m.listOfferings.mockResolvedValue([{ id: 'haiku' }, { id: 'def' }]);
    const r = await listModelChoices(input);
    expect(m.listOfferings).toHaveBeenCalledWith('p1', { enabledOnly: true });
    expect(r.choices.map((c) => c.offeringId)).toEqual(['def', 'haiku']);
  });
  it('permitted = all still drops an enabled offering on a disconnected connection (listOfferings does not filter it)', async () => {
    const gone = cand('gone', { name: 'Gone' });
    gone.facts.connection = { kind: 'anthropic_byok', status: 'disconnected', keyUsable: false };
    m.loadOfferingCandidate.mockImplementation(async (id: string) => (id === 'gone' ? gone : byId[id] ?? null));
    m.getEffectiveAssignment.mockResolvedValue(assignment({ permitted: { kind: 'all' } }));
    m.listOfferings.mockResolvedValue([{ id: 'gone' }, { id: 'def' }]);
    const r = await listModelChoices(input);
    expect(r.choices.map((c) => c.offeringId)).toEqual(['def']);
  });
  it('an eligible offering behind 60 ineligible ones is still listed (Codex review finding 17)', async () => {
    const dead = Array.from({ length: 60 }, (_, i) => `dead-${i}`);
    m.getEffectiveAssignment.mockResolvedValue(assignment({ permitted: { kind: 'list', offeringIds: [...dead, 'haiku'] } }));
    const r = await listModelChoices(input);
    expect(r.choices.map((c) => c.offeringId)).toContain('haiku');
  });
  it('passes the session\'s current choice through', async () => {
    const current = { offeringId: 'haiku', options: { budgetThinking: 'on' as const } };
    expect((await listModelChoices({ ...input, current })).current).toEqual(current);
  });
  it('a partner not yet cut over → LlmUnavailableError (route answers 503)', async () => {
    m.ensurePartnerCutover.mockResolvedValueOnce(false);
    await expect(listModelChoices(input)).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe('picker helpers stay in lockstep with the resolver (W05)', () => {
  it('allowed_options narrow what the picker offers, exactly as dispatch clamps', () => {
    const c = cand('narrow', { fast: true });
    c.allowedOptions = { effort: ['low'], speed: ['standard'] };
    expect(pickerOptionSupport(c, 'agent_sdk')).toEqual({ effort: ['low'], speed: ['standard'], budgetThinking: false });
  });
  it('messages_api offers no budget-thinking toggle and no Fast', () => {
    expect(pickerOptionSupport(catalog.haiku, 'messages_api').budgetThinking).toBe(false);
    expect(pickerOptionSupport(catalog.opus, 'messages_api').speed).toEqual(['standard']);
  });
  it('defaults fall back to the offering default when the assignment is silent, clamped', () => {
    const c = cand('withDefault');
    c.defaultOptions = { effort: 'high' };
    c.allowedOptions = { effort: ['low', 'medium'] };
    expect(defaultOptionsFor(c, undefined, 'agent_sdk')).toEqual({});
    c.allowedOptions = null;
    expect(defaultOptionsFor(c, undefined, 'agent_sdk')).toEqual({ effort: 'high' });
    expect(defaultOptionsFor(c, { effort: 'low' }, 'agent_sdk')).toEqual({ effort: 'low' });
  });
  it('every enabled choice: no-option dispatch applies exactly `defaults`, and every offered option is applied, never stripped', async () => {
    m.loadUserPermissionPredicate.mockResolvedValue((k: string) => k === 'ai_models:premium');
    const r = await listModelChoices(input);
    expect(r.choices.length).toBeGreaterThan(0);
    for (const choice of r.choices) {
      expect(choice.disabled).toBeNull();
      const plain = await resolveModel({ ...input, requested: { offeringId: choice.offeringId } });
      if (!plain.ok) throw new Error(`${choice.offeringId}: ${plain.reason}`);
      expect(plain.options).toEqual(choice.defaults);
      for (const effort of choice.options.effort) {
        const res = await resolveModel({ ...input, requested: { offeringId: choice.offeringId, options: { effort } } });
        expect(res.ok && res.options.effort).toBe(effort);
      }
      for (const speed of choice.options.speed) {
        const res = await resolveModel({ ...input, requested: { offeringId: choice.offeringId, options: { speed } } });
        expect(res.ok && res.options.speed).toBe(speed);
      }
      if (choice.options.budgetThinking) {
        const res = await resolveModel({ ...input, requested: { offeringId: choice.offeringId, options: { budgetThinking: 'on' } } });
        expect(res.ok && res.options.budgetThinking).toBe('on');
      }
    }
    m.loadUserPermissionPredicate.mockResolvedValue((_k: string) => false);
  });
});
