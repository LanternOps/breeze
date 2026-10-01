import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import type { ModelRates } from '@breeze/shared';
import {
  buildDesiredRegistryState,
  LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT,
  legacyBudgetAllowlist,
  type LegacyProjectionEnv,
  type LegacySnapshot,
} from './legacyProjection';

const P = '10000000-0000-4000-8000-000000000001';
const CONN = '20000000-0000-4000-8000-000000000001';
const ORG_A = '30000000-0000-4000-8000-00000000000a';
const ORG_B = '30000000-0000-4000-8000-00000000000b';
const RATES: ModelRates = { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 };

const env: LegacyProjectionEnv = {
  defaultModel: 'claude-sonnet-5-5',
  reviewerModel: 'claude-sonnet-5-5',
  extensionModel: 'claude-haiku-4-5',
  legacyRates: () => RATES,
};

const platformModels = [
  { id: 'pm-sonnet55', modelId: 'claude-sonnet-5-5', priced: true },
  { id: 'pm-opus55', modelId: 'claude-opus-5-5', priced: true },
  { id: 'pm-haiku45', modelId: 'claude-haiku-4-5', priced: true },
  { id: 'pm-legacy', modelId: 'claude-sonnet-4-5-20250929', priced: false },
];

function snapshot(over: Partial<LegacySnapshot> = {}): LegacySnapshot {
  return {
    partnerId: P, orgIds: [ORG_A, ORG_B], config: null, platformModels,
    partnerReviewerModel: null, orgReviewerModels: {}, officeAllowedModels: {},
    agents: [], budgetAllowedModels: {}, liveSessions: [], ...over,
  };
}
const partnerRow = (state: ReturnType<typeof buildDesiredRegistryState>, surface: string) =>
  state.assignments.find((a) => a.orgId === null && a.surface === surface)!;
const offering = (state: ReturnType<typeof buildDesiredRegistryState>, key: string) =>
  state.offerings.find((o) => o.key === key)!;

describe('buildDesiredRegistryState (#7600 W02, spec §10)', () => {
  it('no config: every surface on the platform, patch_test included; extension and reviewer keep their own models', () => {
    const s = buildDesiredRegistryState(snapshot(), env);
    expect(s.connectionId).toBeNull();
    expect(s.assignments.filter((a) => a.orgId === null).map((a) => [a.surface, a.defaultOfferingKey])).toEqual([
      ['chat', 'platform:claude-sonnet-5-5'], ['helper', 'platform:claude-sonnet-5-5'],
      ['script_builder', 'platform:claude-sonnet-5-5'], ['script_reviewer', 'platform:claude-sonnet-5-5'],
      ['office_chat', 'platform:claude-sonnet-5-5'], ['office_ticket', 'platform:claude-sonnet-5-5'],
      ['ai_agents', 'platform:claude-sonnet-5-5'], ['catalog_enrichment', 'platform:claude-sonnet-5-5'],
      ['extension_content', 'platform:claude-haiku-4-5'], ['patch_test', 'platform:claude-sonnet-5-5'],
    ]);
    expect(partnerRow(s, 'chat').allowUserChoice).toBe(true);
    expect(partnerRow(s, 'helper').allowUserChoice).toBe(false);
    expect(offering(s, 'platform:claude-sonnet-5-5')).toMatchObject({ connectionId: null, source: 'platform', platformModelId: 'pm-sonnet55', needsBootstrapPlatformRow: false, price: null });
  });

  it('BYOK pinned: partner-destination surfaces move to the connection; patch_test stays on the platform', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-opus-5-5', catalogEntryId: null } }), env);
    expect(s.connectionId).toBe(CONN);
    expect(partnerRow(s, 'chat').defaultOfferingKey).toBe(`conn:${CONN}:claude-opus-5-5`);
    expect(partnerRow(s, 'extension_content').defaultOfferingKey).toBe(`conn:${CONN}:claude-haiku-4-5`);
    expect(partnerRow(s, 'patch_test').defaultOfferingKey).toBe('platform:claude-sonnet-5-5');
    expect(offering(s, `conn:${CONN}:claude-opus-5-5`)).toMatchObject({ source: 'discovered', platformModelId: 'pm-opus55', price: null });
  });

  it('BYOK tracking the deployment default resolves P from env at projection time', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: null, catalogEntryId: null } }), { ...env, defaultModel: 'claude-opus-5-5' });
    expect(partnerRow(s, 'chat').defaultOfferingKey).toBe(`conn:${CONN}:claude-opus-5-5`);
  });

  it('an errored config keeps every partner-destination surface on its connection (never re-pointed to the platform)', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'error', defaultModel: null, catalogEntryId: null } }), env);
    for (const a of s.assignments.filter((x) => x.orgId === null && x.surface !== 'patch_test')) {
      expect(a.defaultOfferingKey).toMatch(new RegExp(`^conn:${CONN}:`));
    }
  });

  it('catalog: catalog offerings carry no price and no platform link', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-sonnet-4-6', catalogEntryId: 'entry-1' } }), env);
    expect(offering(s, `conn:${CONN}:claude-sonnet-4-6`)).toMatchObject({ source: 'catalog', platformModelId: null, price: null });
  });

  it('unknown ids stay on their destination: manual at legacy rates on a key, bootstrap row on the platform', () => {
    const byok = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'my-gateway-model', catalogEntryId: null } }), env);
    expect(offering(byok, `conn:${CONN}:my-gateway-model`)).toMatchObject({ source: 'manual', platformModelId: null, price: RATES });
    const platform = buildDesiredRegistryState(snapshot(), { ...env, defaultModel: 'my-gateway-model' });
    expect(offering(platform, 'platform:my-gateway-model')).toMatchObject({ source: 'platform', platformModelId: null, needsBootstrapPlatformRow: true, price: null });
  });

  describe('bootstrap provenance: only deployment (env) ids may create a global platform row', () => {
    const UNKNOWN = 'tenant-typed-model';
    const tenantEverywhere = snapshot({
      partnerReviewerModel: UNKNOWN,
      orgReviewerModels: { [ORG_B]: UNKNOWN },
      officeAllowedModels: { [ORG_A]: [UNKNOWN, 'claude-haiku-4-5'] },
      agents: [
        { id: 'agent-partner-triage', kind: 'triage', orgId: null, model: UNKNOWN },
        { id: 'agent-orgA-triage', kind: 'triage', orgId: ORG_A, model: UNKNOWN },
      ],
      budgetAllowedModels: { [ORG_A]: [UNKNOWN, 'claude-haiku-4-5'] },
      liveSessions: [{ id: 'sess-unknown', orgId: ORG_A, model: UNKNOWN }, { id: 'sess-known', orgId: ORG_A, model: 'claude-opus-5-5' }],
    });

    it('a tenant-sourced unknown platform id produces no offering, no binding, and is reported as skipped', () => {
      const s = buildDesiredRegistryState(tenantEverywhere, env);
      expect(s.offerings.some((o) => o.modelId === UNKNOWN)).toBe(false);
      expect(s.offerings.some((o) => o.needsBootstrapPlatformRow)).toBe(false);
      expect(s.skippedUnknownPlatformModels).toEqual([UNKNOWN]);
      // Partner reviewer override was the only source of the partner script_reviewer default.
      expect(partnerRow(s, 'script_reviewer').defaultOfferingKey).toBeNull();
      // An org override onto it is not projected (no row to point at).
      expect(s.assignments.find((a) => a.surface === 'script_reviewer' && a.orgId === ORG_B)).toBeUndefined();
      const office = s.assignments.find((a) => a.surface === 'office_chat' && a.orgId === ORG_A)!;
      expect(office.defaultOfferingKey).toBeNull();
      expect(office.permittedOfferingKeys).toEqual(['platform:claude-haiku-4-5']);
      const agentsRow = s.assignments.find((a) => a.surface === 'ai_agents' && a.orgId === ORG_A)!;
      expect(agentsRow.permittedOfferingKeys).not.toContain(`platform:${UNKNOWN}`);
      expect([...agentsRow.permittedOfferingKeys!].sort()).toEqual(['platform:claude-haiku-4-5', 'platform:claude-sonnet-5-5']);
      expect(s.agentOfferingKeys).toEqual({ 'agent-partner-triage': null, 'agent-orgA-triage': null });
      expect(s.sessionOfferingKeys).toEqual({ 'sess-unknown': null, 'sess-known': 'platform:claude-opus-5-5' });
    });

    it('the same id coming from the deployment env still bootstraps, and tenant references to it then bind', () => {
      const s = buildDesiredRegistryState(tenantEverywhere, { ...env, extensionModel: UNKNOWN });
      expect(offering(s, `platform:${UNKNOWN}`)).toMatchObject({ needsBootstrapPlatformRow: true, platformModelId: null });
      expect(s.skippedUnknownPlatformModels).toEqual([]);
      expect(s.sessionOfferingKeys['sess-unknown']).toBe(`platform:${UNKNOWN}`);
      expect(s.agentOfferingKeys['agent-partner-triage']).toBe(`platform:${UNKNOWN}`);
    });

    it('every env-sourced id (default, reviewer, extension) may bootstrap', () => {
      const s = buildDesiredRegistryState(snapshot(), { ...env, defaultModel: 'env-default-x', reviewerModel: 'env-reviewer-x', extensionModel: 'env-ext-x' });
      expect(s.offerings.filter((o) => o.needsBootstrapPlatformRow).map((o) => o.modelId).sort()).toEqual(['env-default-x', 'env-ext-x', 'env-reviewer-x']);
      expect(s.skippedUnknownPlatformModels).toEqual([]);
    });

    it('a tenant-sourced unknown id on a BYOK connection is unaffected (manual offering at the legacy rate)', () => {
      const s = buildDesiredRegistryState({ ...tenantEverywhere, config: { id: CONN, status: 'active', defaultModel: null, catalogEntryId: null } }, env);
      expect(offering(s, `conn:${CONN}:${UNKNOWN}`)).toMatchObject({ source: 'manual', platformModelId: null, price: RATES, needsBootstrapPlatformRow: false });
      expect(s.sessionOfferingKeys['sess-unknown']).toBe(`conn:${CONN}:${UNKNOWN}`);
      expect(s.skippedUnknownPlatformModels).toEqual([]);
    });
  });

  it('an ACTIVE BYOK config is projected onto its connection whatever its key decrypts to (the projection never reads the key)', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-opus-5-5', catalogEntryId: null } }), env);
    for (const a of s.assignments.filter((x) => x.orgId === null && x.surface !== 'patch_test')) {
      expect(a.defaultOfferingKey).toMatch(new RegExp(`^conn:${CONN}:`));
    }
  });

  it('a BYOK offering linked to an UNPRICED platform row is priced at the legacy rate (never left unpriced)', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-sonnet-4-5-20250929', catalogEntryId: null } }), env);
    expect(offering(s, `conn:${CONN}:claude-sonnet-4-5-20250929`)).toMatchObject({ source: 'discovered', platformModelId: 'pm-legacy', price: RATES });
  });

  it('script reviewer: partner reviewer_model, org override row, env default otherwise', () => {
    const s = buildDesiredRegistryState(snapshot({ partnerReviewerModel: 'claude-opus-5-5', orgReviewerModels: { [ORG_A]: 'claude-haiku-4-5', [ORG_B]: null } }), env);
    expect(partnerRow(s, 'script_reviewer').defaultOfferingKey).toBe('platform:claude-opus-5-5');
    const orgRows = s.assignments.filter((a) => a.surface === 'script_reviewer' && a.orgId !== null);
    expect(orgRows).toEqual([expect.objectContaining({ orgId: ORG_A, defaultOfferingKey: 'platform:claude-haiku-4-5', permittedOfferingKeys: null })]);
    const none = buildDesiredRegistryState(snapshot(), { ...env, reviewerModel: 'claude-haiku-4-5' });
    expect(partnerRow(none, 'script_reviewer').defaultOfferingKey).toBe('platform:claude-haiku-4-5');
  });

  it('office allowedModels → office_chat org row (first = default, list = permitted, de-duplicated); [] → no row', () => {
    const s = buildDesiredRegistryState(snapshot({ officeAllowedModels: { [ORG_A]: ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-haiku-4-5'], [ORG_B]: [] } }), env);
    const rows = s.assignments.filter((a) => a.surface === 'office_chat' && a.orgId !== null);
    expect(rows).toEqual([expect.objectContaining({
      orgId: ORG_A,
      defaultOfferingKey: 'platform:claude-haiku-4-5',
      permittedOfferingKeys: ['platform:claude-haiku-4-5', 'platform:claude-opus-5-5'],
    })]);
  });

  describe('AI agents + ai_budgets.allowed_models', () => {
    const agents = [
      { id: 'agent-partner-triage', kind: 'triage', orgId: null, model: 'claude-opus-5-5' },
      { id: 'agent-partner-patch', kind: 'patch', orgId: null, model: null },
      { id: 'agent-orgA-triage', kind: 'triage', orgId: ORG_A, model: 'claude-haiku-4-5' },
      { id: 'agent-orgB-triage', kind: 'triage', orgId: ORG_B, model: 'claude-haiku-4-5' },
    ];

    it('binds partner rows; binds an org override only when the legacy merge admits it', () => {
      const s = buildDesiredRegistryState(snapshot({
        agents,
        budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5'], [ORG_B]: [...LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT] },
      }), env);
      expect(s.agentOfferingKeys).toEqual({
        'agent-partner-triage': 'platform:claude-opus-5-5',
        'agent-partner-patch': null,
        'agent-orgA-triage': 'platform:claude-haiku-4-5',
        'agent-orgB-triage': null,
      });
    });

    it('a customized allowlist becomes an org ai_agents row permitting allowlist ∪ every model the org runs today', () => {
      const s = buildDesiredRegistryState(snapshot({ agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929'] } }), env);
      const row = s.assignments.find((a) => a.surface === 'ai_agents' && a.orgId === ORG_A)!;
      expect(row.defaultOfferingKey).toBeNull();
      expect([...row.permittedOfferingKeys!].sort()).toEqual([
        'platform:claude-haiku-4-5',            // allowlist + admitted org override (triage)
        'platform:claude-sonnet-4-5-20250929',  // allowlist
        'platform:claude-sonnet-5-5',           // P: the patch agent (model NULL) and the surface default
      ].sort());
    });

    it('an org still on the column-default allowlist gets NO narrowing org row', () => {
      const s = buildDesiredRegistryState(snapshot({ agents, budgetAllowedModels: { [ORG_B]: [...LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT] } }), env);
      expect(s.assignments.find((a) => a.surface === 'ai_agents' && a.orgId === ORG_B)).toBeUndefined();
    });

    it('legacyBudgetAllowlist mirrors effectivePolicy: arrays pass, anything else is null', () => {
      expect(legacyBudgetAllowlist(['a'])).toEqual(['a']);
      expect(legacyBudgetAllowlist(null)).toBeNull();
      expect(legacyBudgetAllowlist({ a: 1 })).toBeNull();
      expect(legacyBudgetAllowlist('a')).toBeNull();
    });
  });

  it('live sessions bind on the partner\'s CURRENT destination', () => {
    const s = buildDesiredRegistryState(snapshot({
      config: { id: CONN, status: 'active', defaultModel: null, catalogEntryId: null },
      liveSessions: [{ id: 'sess-1', orgId: ORG_A, model: 'claude-opus-5-5' }],
    }), env);
    expect(s.sessionOfferingKeys).toEqual({ 'sess-1': `conn:${CONN}:claude-opus-5-5` });
  });

  it('is deterministic and de-duplicates offerings', () => {
    const input = snapshot({ officeAllowedModels: { [ORG_A]: ['claude-sonnet-5-5'] }, liveSessions: [{ id: 's', orgId: ORG_A, model: 'claude-sonnet-5-5' }] });
    const a = buildDesiredRegistryState(input, env);
    expect(buildDesiredRegistryState(input, env)).toEqual(a);
    expect(new Set(a.offerings.map((o) => o.key)).size).toBe(a.offerings.length);
  });

  it('reads the budget column default from the schema, not a literal', () => {
    expect(LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT).toHaveLength(1);
  });
});
