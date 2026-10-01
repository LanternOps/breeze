/**
 * Every legacy configuration shape the W02 projection must preserve
 * (spec §10 parity). Test-fixture data: model id literals are allowed here.
 */
import type { ListedProvider } from '../../llmProviderCatalog';
import type { LegacySnapshot } from '../legacyProjection';
import type { ParityFixture } from './harness';

const PARTNER = '70000000-0000-4000-8000-000000000001';
const CONN = '70000000-0000-4000-8000-0000000000c1';
const ORG_A = '70000000-0000-4000-8000-0000000000a1';
const ORG_B = '70000000-0000-4000-8000-0000000000b1';
const KEY = 'sk-ant-api03-parity-fixture-key-0001';

const platformModels: LegacySnapshot['platformModels'] = [
  { id: 'pm-sonnet55', modelId: 'claude-sonnet-5-5', priced: true },
  { id: 'pm-opus55', modelId: 'claude-opus-5-5', priced: true },
  { id: 'pm-sonnet46', modelId: 'claude-sonnet-4-6', priced: true },
  { id: 'pm-haiku45', modelId: 'claude-haiku-4-5', priced: true },
  { id: 'pm-sonnet45d', modelId: 'claude-sonnet-4-5-20250929', priced: true },
];

const base = (over: Partial<LegacySnapshot> = {}): LegacySnapshot => ({
  partnerId: PARTNER, orgIds: [ORG_A, ORG_B], config: null, platformModels,
  partnerReviewerModel: null, orgReviewerModels: {}, officeAllowedModels: {},
  agents: [], budgetAllowedModels: {}, liveSessions: [], ...over,
});

const catalog = (verified: string[]): ListedProvider => ({
  entryId: '70000000-0000-4000-8000-0000000000e1', slug: 'gateway', name: 'Gateway', revisionId: '70000000-0000-4000-8000-0000000000e2',
  revision: 1, baseUrl: 'https://llm-gateway.example.com', authMode: 'x-api-key', dataNote: null,
  modelMap: {
    'claude-sonnet-4-6': { providerModel: 'vendor/claude-sonnet-4-6', inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 },
    'claude-haiku-4-5': { providerModel: 'vendor/claude-haiku-4-5', inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 },
  },
  verifiedModels: verified,
});

const agents = [
  { id: 'ag-p-triage', kind: 'triage', orgId: null, model: 'claude-opus-5-5' },
  { id: 'ag-p-patch', kind: 'patch', orgId: null, model: null },
  { id: 'ag-a-triage', kind: 'triage', orgId: ORG_A, model: 'claude-haiku-4-5' },
];

const byok = (over: Partial<NonNullable<LegacySnapshot['config']>> = {}) =>
  ({ id: CONN, status: 'active' as const, defaultModel: null, catalogEntryId: null, ...over });

export const PARITY_FIXTURES: readonly ParityFixture[] = [
  { name: 'no_config', env: {}, snapshot: base(), legacyApiKey: null, catalogProvider: null },
  {
    name: 'no_config_env_overrides',
    env: { ANTHROPIC_MODEL: 'claude-opus-5-5', BREEZE_AI_SCRIPT_REVIEWER_MODEL: 'claude-haiku-4-5', WORKSPACE_CONTENT_LLM_MODEL: 'claude-sonnet-4-6' },
    snapshot: base(), legacyApiKey: null, catalogProvider: null,
  },
  { name: 'self_host_gateway_model', env: { ANTHROPIC_MODEL: 'my-gateway-model' }, snapshot: base(), legacyApiKey: null, catalogProvider: null },
  { name: 'byok_direct_pinned', env: {}, snapshot: base({ config: byok({ defaultModel: 'claude-opus-5-5' }) }), legacyApiKey: KEY, catalogProvider: null },
  { name: 'byok_direct_tracking_env', env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' }, snapshot: base({ config: byok() }), legacyApiKey: KEY, catalogProvider: null },
  { name: 'byok_errored', env: {}, snapshot: base({ config: byok({ status: 'error' }) }), legacyApiKey: KEY, catalogProvider: null },
  {
    name: 'byok_active_key_undecryptable', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-opus-5-5' }), agents }),
    legacyApiKey: KEY, legacyKeyUndecryptable: true, catalogProvider: null,
  },
  { name: 'byok_unknown_model', env: {}, snapshot: base({ config: byok({ defaultModel: 'my-gateway-model' }) }), legacyApiKey: KEY, catalogProvider: null },
  {
    name: 'byok_catalog_verified', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-sonnet-4-6', catalogEntryId: '70000000-0000-4000-8000-0000000000e1' }), agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5'] } }),
    legacyApiKey: KEY, catalogProvider: catalog(['claude-sonnet-4-6', 'claude-haiku-4-5']),
  },
  {
    name: 'catalog_default_unverified', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-opus-5-5', catalogEntryId: '70000000-0000-4000-8000-0000000000e1' }), partnerReviewerModel: 'claude-haiku-4-5' }),
    legacyApiKey: KEY, catalogProvider: catalog(['claude-sonnet-4-6', 'claude-haiku-4-5']),
  },
  {
    name: 'agent_org_override_inside_allowlist', env: {},
    snapshot: base({ agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5'] } }),
    legacyApiKey: null, catalogProvider: null,
  },
  {
    name: 'agent_org_override_outside_default_allowlist', env: {},
    snapshot: base({ agents, budgetAllowedModels: { [ORG_A]: ['claude-sonnet-4-5-20250929'] } }),
    legacyApiKey: null, catalogProvider: null,
  },
  { name: 'agent_org_override_no_budget_row', env: {}, snapshot: base({ agents }), legacyApiKey: null, catalogProvider: null },
  {
    name: 'byok_agents_customized_allowlist', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-sonnet-5-5' }), agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929'] } }),
    legacyApiKey: KEY, catalogProvider: null,
  },
  {
    name: 'office_and_reviewer_overrides', env: { BREEZE_AI_SCRIPT_REVIEWER_MODEL: 'claude-sonnet-4-6' },
    snapshot: base({
      config: byok({ defaultModel: 'claude-sonnet-5-5' }),
      partnerReviewerModel: 'claude-opus-5-5',
      orgReviewerModels: { [ORG_A]: 'claude-haiku-4-5', [ORG_B]: null },
      officeAllowedModels: { [ORG_A]: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'], [ORG_B]: [] },
    }),
    legacyApiKey: KEY, catalogProvider: null,
  },
  {
    name: 'live_sessions', env: {},
    snapshot: base({
      config: byok({ defaultModel: 'claude-sonnet-5-5' }),
      liveSessions: [
        { id: '70000000-0000-4000-8000-0000000005a1', orgId: ORG_A, model: 'claude-opus-5-5' },
        { id: '70000000-0000-4000-8000-0000000005a2', orgId: ORG_B, model: 'claude-sonnet-5-5' },
      ],
    }),
    legacyApiKey: KEY, catalogProvider: null,
  },
];
