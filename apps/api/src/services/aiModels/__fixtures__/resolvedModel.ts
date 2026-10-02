/**
 * Shared ResolvedModel builder for the surface tests (W03 Tasks 7–14). One
 * per connection kind; `anthropic_byok` is the useful default for entrypoint
 * pass-through assertions because its `partner_key` funding differs from
 * every platform default.
 */
import type { ModelRates } from '@breeze/shared';
import type { UsableLlmConfig } from '../../llm/llmConfigResolver';
import type { ResolvedModel } from '../resolveModel';

export const FIXTURE_STD_RATES: ModelRates = {
  inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250,
};

export type FixtureConnectionKind = 'platform' | 'anthropic_byok' | 'catalog';

export function makeResolvedModel(
  kind: FixtureConnectionKind = 'platform',
  over: Partial<ResolvedModel> = {},
): ResolvedModel {
  const config: UsableLlmConfig = kind === 'platform'
    ? { source: 'platform', apiKey: 'sk-platform', model: 'claude-sonnet-5-5' }
    : {
        source: 'partner', partnerId: 'partner-1', apiKey: 'sk-partner', model: 'claude-sonnet-5-5',
        configId: 'conn-1', configVersion: 2,
        endpoint: kind === 'catalog'
          ? {
              kind: 'catalog', catalogEntryId: 'cat-1', revisionId: 'rev-1', baseUrl: 'https://gw.example.com',
              authMode: 'bearer', providerModel: 'anthropic/claude-sonnet-5.5',
              pricing: { catalogEntryId: 'cat-1', revisionId: 'rev-1', ...FIXTURE_STD_RATES },
              models: {},
            }
          : { kind: 'anthropic' },
      };
  const base: ResolvedModel = {
    ok: true,
    surface: 'chat',
    role: 'default',
    transport: 'agent_sdk',
    partnerId: 'partner-1',
    orgId: 'org-1',
    offering: { id: 'off-1', displayName: 'Sonnet 5.5' },
    connection: { id: kind === 'platform' ? null : 'conn-1', kind, config },
    funding: kind === 'platform' ? 'platform' : 'partner_key',
    logicalModel: 'claude-sonnet-5-5',
    wireModel: kind === 'catalog' ? 'anthropic/claude-sonnet-5.5' : 'claude-sonnet-5-5',
    thinking: 'adaptive',
    wireParams: { thinking: { type: 'adaptive' }, effort: 'medium', betas: [], applied: { effort: 'medium' } },
    options: { effort: 'medium' },
    inferenceGeo: null,
    promptProfile: 'claude-standard',
    rateSnapshot: {
      source: kind === 'platform' ? 'platform' : kind === 'catalog' ? 'catalog' : 'linked_platform',
      standard: FIXTURE_STD_RATES,
    },
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high'], supportsTools: true, supportsVision: false },
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    ...(kind === 'platform' ? {} : { configVersion: 2 }),
    ...(kind === 'catalog' ? { catalogRevisionId: 'rev-1' } : {}),
    fellBack: false,
    failover: null,
    failoverRemaining: [],
  };
  return { ...base, ...over };
}
