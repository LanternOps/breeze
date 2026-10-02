import { describe, expect, it } from 'vitest';
import { planTypeEnum } from '../../db/schema/orgs';
import {
  PARTNER_PLAN_ORDER,
  checkEligibility,
  planSatisfies,
  type CandidateFacts,
  type EligibilityContext,
} from './eligibility';

const RATE = {
  source: 'platform' as const,
  standard: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
};

function platformFacts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    ownerPartnerId: 'p1',
    enabled: true,
    lifecycle: 'available',
    requiredPermission: null,
    platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
    connection: { kind: 'platform', status: 'active', keyUsable: true },
    catalog: null,
    rate: RATE,
    supportsTools: true,
    inferenceGeo: null,
    supportedInferenceGeos: [],
    ...over,
  };
}

function byokFacts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return platformFacts({
    platform: null,
    connection: { kind: 'anthropic_byok', status: 'active', keyUsable: true },
    rate: { ...RATE, source: 'linked_platform' },
    ...over,
  });
}

const CTX: EligibilityContext = {
  partnerId: 'p1',
  surface: 'chat',
  partnerPlan: 'pro',
  hosted: true,
  residencyRequired: false,
  geoCarriable: true,
  userInitiated: true,
  userHoldsPermission: () => false,
};

describe('checkEligibility — one row per spec §9 step 2 rule', () => {
  it.each<[string, CandidateFacts, Partial<EligibilityContext>, string | null]>([
    ['eligible platform offering', platformFacts(), {}, null],
    ['eligible BYOK offering', byokFacts(), {}, null],
    ['owned by another partner', platformFacts({ ownerPartnerId: 'p2' }), {}, 'not_permitted'],
    ['disabled offering', platformFacts({ enabled: false }), {}, 'model_unavailable'],
    ['offering lifecycle missing', platformFacts({ lifecycle: 'missing' }), {}, 'model_unavailable'],
    ['platform row not platform_offered (re-checked per dispatch)',
      platformFacts({ platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }), {}, 'model_unavailable'],
    ['platform row retired',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'retired', minPlan: null } }), {}, 'model_unavailable'],
    ['platform key absent on this deployment',
      platformFacts({ connection: { kind: 'platform', status: 'unconfigured', keyUsable: false } }), {}, 'connection_unavailable'],
    ['connection in error', byokFacts({ connection: { kind: 'anthropic_byok', status: 'error', keyUsable: true } }), {}, 'connection_unavailable'],
    ['connection key undecryptable', byokFacts({ connection: { kind: 'anthropic_byok', status: 'active', keyUsable: false } }), {}, 'connection_unavailable'],
    ['openai_compatible is W06', byokFacts({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: true } }), {}, 'connection_unavailable'],
    ['catalog model not mapped+verified in the current revision',
      byokFacts({ connection: { kind: 'catalog', status: 'active', keyUsable: true }, catalog: { usable: false } }), {}, 'model_unavailable'],
    ['catalog model usable', byokFacts({ connection: { kind: 'catalog', status: 'active', keyUsable: true }, catalog: { usable: true }, rate: { ...RATE, source: 'catalog' } }), {}, null],
    ['no resolvable rate', byokFacts({ rate: null }), {}, 'unpriced'],
    ['tool surface without verified tools', platformFacts({ supportsTools: false }), { surface: 'chat' }, 'tools_unsupported'],
    ['non-tool surface without tools is fine', platformFacts({ supportsTools: false }), { surface: 'catalog_enrichment' }, null],
    ['office_chat requires tools (quorum #10)', platformFacts({ supportsTools: false }), { surface: 'office_chat' }, 'tools_unsupported'],
    ['required permission, user lacks it', platformFacts({ requiredPermission: 'ai_models:premium' }), {}, 'permission_required'],
    ['required permission, user holds it', platformFacts({ requiredPermission: 'ai_models:premium' }), { userHoldsPermission: (k) => k === 'ai_models:premium' }, null],
    ['required permission skipped for system/agent calls', platformFacts({ requiredPermission: 'ai_models:premium' }), { userInitiated: false }, null],
    ['min_plan above partner plan (hosted)',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }), {}, 'plan_required'],
    ['min_plan ignored on self-host',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }), { hosted: false }, null],
    ['min_plan satisfied',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'community' } }), {}, null],
    ['residency required, no geography configured', platformFacts(), { residencyRequired: true }, 'residency_unavailable'],
    ['residency required, geography unsupported by model',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['us'] }), { residencyRequired: true }, 'residency_unavailable'],
    ['residency required and honoured',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['us', 'eu'] }), { residencyRequired: true }, null],
    ['residency required but the transport cannot carry a geography (W01 D3 open) → fails closed',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['eu'] }), { residencyRequired: true, geoCarriable: false }, 'residency_unavailable'],
    ['system platform candidate (patch_test) has no owner',
      platformFacts({ ownerPartnerId: null }), { partnerId: null, surface: 'patch_test', userInitiated: false, partnerPlan: null }, null],
    // W01 deferred: getPlatformDefaultModel() has no lifecycle filter, so the
    // platform default is re-checked here like any platform row.
    ['platform default retired → ineligible',
      platformFacts({ ownerPartnerId: null, platform: { platformOffered: true, lifecycle: 'retired', minPlan: null } }),
      { partnerId: null, surface: 'patch_test', userInitiated: false, partnerPlan: null }, 'model_unavailable'],
    ['platform default missing → ineligible',
      platformFacts({ ownerPartnerId: null, platform: { platformOffered: true, lifecycle: 'missing', minPlan: null } }),
      { partnerId: null, surface: 'patch_test', userInitiated: false, partnerPlan: null }, 'model_unavailable'],
    ['platform default un-offered → ineligible',
      platformFacts({ ownerPartnerId: null, platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }),
      { partnerId: null, surface: 'patch_test', userInitiated: false, partnerPlan: null }, 'model_unavailable'],
    // W01 D3: the platform key accepts only us/global; eu is an HTTP 400. A
    // configured platform geography the key cannot serve fails closed even
    // without a residency requirement (never a provider 400, never a silent
    // drop to global).
    ['platform geo eu configured (key serves us/global) → residency_unavailable',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['us', 'global'] }), {}, 'residency_unavailable'],
    ['platform geo eu configured + residency required → residency_unavailable',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['us', 'global'] }), { residencyRequired: true }, 'residency_unavailable'],
    ['platform geo us configured → eligible',
      platformFacts({ inferenceGeo: 'us', supportedInferenceGeos: ['us', 'global'] }), {}, null],
    ['platform geo us configured + residency required → eligible',
      platformFacts({ inferenceGeo: 'us', supportedInferenceGeos: ['us', 'global'] }), { residencyRequired: true }, null],
    ['BYOK geo the model does not list, residency not required → eligible (spec §7: geo simply not sent)',
      byokFacts({ inferenceGeo: 'eu', supportedInferenceGeos: [] }), {}, null],
  ])('%s', (_name, facts, ctx, expected) => {
    expect(checkEligibility(facts, { ...CTX, ...ctx })).toBe(expected);
  });
});

describe('plan ordering', () => {
  it('mirrors planTypeEnum exactly (a new plan must be ranked deliberately)', () => {
    expect([...PARTNER_PLAN_ORDER]).toEqual([...planTypeEnum.enumValues]);
  });
  it('compares by rank', () => {
    expect(planSatisfies('pro', 'community')).toBe(true);
    expect(planSatisfies('starter', 'community')).toBe(false);
    expect(planSatisfies('free', null)).toBe(true);
  });
});
