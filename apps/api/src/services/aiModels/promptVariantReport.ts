/**
 * The platform's prompt-variant comparison (W11 #7609): every registered
 * variant beside its surface + profile's base prompt, measured with the
 * quality view across ALL partners (prompts are platform-wide), for the
 * prompt-hook surfaces only. Aggregates keyed by variant id; no org, partner
 * or user identifier leaves this module. Runs in system context
 * (routes/admin/aiPromptVariants.ts).
 */
import type { AiPromptVariantDto, AiPromptVariantReportDto, AiPromptVariantReportRowDto, AiQualityMetricsDto } from '@breeze/shared';
import { PROMPT_VARIANTS, PROMPT_VARIANT_SURFACES, type PromptVariant } from './promptVariants';
import { EMPTY_QUALITY_ROW, queryAiQuality, toQualityMetrics } from './qualityQueries';
import type { QualitySources } from './qualitySources';

/** Fewer conversations than this in a row: too few to compare (G5 promotion bar). */
export const MIN_CONVERSATIONS_TO_COMPARE = 30;
export const DEFAULT_PROMPT_VARIANT_REPORT_DAYS = 28;

export function defaultPromptVariantRange(now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const start = new Date(`${to}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (DEFAULT_PROMPT_VARIANT_REPORT_DAYS - 1));
  return { from: start.toISOString().slice(0, 10), to };
}

const toDto = (v: PromptVariant): AiPromptVariantDto => ({
  id: v.id, surface: v.surface, profile: v.profile, version: v.version, state: v.state, canaryPercent: v.canaryPercent, hypothesis: v.hypothesis,
});

export async function buildPromptVariantReport(
  range: { from: string; to: string },
  variants: readonly PromptVariant[] = PROMPT_VARIANTS,
  sources?: QualitySources,
): Promise<AiPromptVariantReportDto> {
  const result = await queryAiQuality({
    groupBy: 'prompt_variant', from: range.from, to: range.to, orgId: null, accessibleOrgIds: null, surfaces: PROMPT_VARIANT_SURFACES, conversationsOnly: true,
  }, sources);
  const zero = toQualityMetrics(EMPTY_QUALITY_ROW, { failover: result.sources.failovers, continuation: result.sources.continuations });
  const byKey = new Map(result.rows.map((r) => [r.key, r]));
  const metricsOf = (key: string): AiQualityMetricsDto => {
    const row = byKey.get(key);
    if (!row) return zero;
    const { key: _key, label: _label, connectionName: _connection, ...metrics } = row;
    return metrics;
  };
  const row = (key: string, v: PromptVariant | null, surface: PromptVariant['surface'], profile: PromptVariant['profile'], incumbent: boolean): AiPromptVariantReportRowDto => {
    const metrics = metricsOf(key);
    return { key, surface, profile, variant: v ? toDto(v) : null, metrics, lowSample: metrics.conversations < MIN_CONVERSATIONS_TO_COMPARE, incumbent };
  };
  const pairs = [...new Map(variants.map((v) => [`${v.surface}/${v.profile}`, v])).values()];
  const rows: AiPromptVariantReportRowDto[] = [];
  for (const pair of pairs) {
    const mine = variants.filter((v) => v.surface === pair.surface && v.profile === pair.profile).sort((a, b) => b.version - a.version);
    const active = mine.find((v) => v.state === 'active') ?? null;
    rows.push(row(`${pair.surface}/${pair.profile}@base`, null, pair.surface, pair.profile, active === null));
    for (const v of mine) rows.push(row(v.id, v, v.surface, v.profile, v === active));
  }
  return { from: range.from, to: range.to, minConversations: MIN_CONVERSATIONS_TO_COMPARE, rows, sources: result.sources };
}
