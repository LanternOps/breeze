import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryAiQuality: vi.fn() }));
vi.mock('./qualityQueries', async (orig) => ({ ...(await orig<typeof import('./qualityQueries')>()), queryAiQuality: m.queryAiQuality }));
vi.mock('../../db', () => ({ db: {} }));

import { EMPTY_QUALITY_ROW, toQualityMetrics } from './qualityQueries';
import { MIN_CONVERSATIONS_TO_COMPARE, buildPromptVariantReport, defaultPromptVariantRange } from './promptVariantReport';
import { PROMPT_VARIANT_SURFACES, type PromptVariant } from './promptVariants';

const ON = { failover: true, continuation: true };
const metrics = (conversations: number) => ({ ...toQualityMetrics(EMPTY_QUALITY_ROW, ON), conversations, invocations: conversations });
const v = (id: string, version: number, state: PromptVariant['state']): PromptVariant => ({
  id, surface: 'chat', profile: 'claude-small', version, state, canaryPercent: state === 'candidate' ? 10 : 0, guidance: 'g', hypothesis: 'h',
});

describe('buildPromptVariantReport', () => {
  it('queries every partner, the prompt-hook surfaces only, grouped by variant', async () => {
    m.queryAiQuality.mockResolvedValue({ rows: [], totals: metrics(0), sources: { failovers: true, continuations: true } });
    await buildPromptVariantReport({ from: '2026-09-01', to: '2026-09-28' }, [v('chat/claude-small@1', 1, 'active')], ON);
    expect(m.queryAiQuality).toHaveBeenCalledWith({
      groupBy: 'prompt_variant', from: '2026-09-01', to: '2026-09-28', orgId: null, accessibleOrgIds: null, surfaces: PROMPT_VARIANT_SURFACES,
    }, ON);
  });

  it('lists each surface/profile base first, then its variants newest first, with zero metrics for no traffic', async () => {
    m.queryAiQuality.mockResolvedValue({
      rows: [
        { key: 'chat/claude-small@base', label: null, connectionName: null, ...metrics(120) },
        { key: 'chat/claude-small@2', label: null, connectionName: null, ...metrics(12) },
        { key: 'helper/claude-small@base', label: null, connectionName: null, ...metrics(5) }, // no variant registered: omitted
      ],
      totals: metrics(137), sources: { failovers: true, continuations: false },
    });
    const r = await buildPromptVariantReport({ from: '2026-09-01', to: '2026-09-28' },
      [v('chat/claude-small@1', 1, 'retired'), v('chat/claude-small@2', 2, 'candidate')], ON);
    expect(r.rows.map((x) => [x.key, x.metrics.conversations, x.lowSample, x.variant?.state ?? 'base', x.incumbent])).toEqual([
      ['chat/claude-small@base', 120, false, 'base', true],
      ['chat/claude-small@2', 12, true, 'candidate', false],
      ['chat/claude-small@1', 0, true, 'retired', false],
    ]);
  });

  it('once a variant is active it is the incumbent a candidate competes with, not base', async () => {
    m.queryAiQuality.mockResolvedValue({ rows: [], totals: metrics(0), sources: { failovers: true, continuations: false } });
    const r = await buildPromptVariantReport({ from: '2026-09-01', to: '2026-09-28' },
      [v('chat/claude-small@1', 1, 'active'), v('chat/claude-small@2', 2, 'candidate')], ON);
    expect(r.rows.map((x) => [x.key, x.incumbent])).toEqual([
      ['chat/claude-small@base', false],
      ['chat/claude-small@2', false],
      ['chat/claude-small@1', true],
    ]);
    expect(r).toMatchObject({ minConversations: MIN_CONVERSATIONS_TO_COMPARE, sources: { failovers: true, continuations: false } });
  });

  it('the DTO carries no tenant identifiers', async () => {
    m.queryAiQuality.mockResolvedValue({ rows: [{ key: 'chat/claude-small@base', label: null, connectionName: null, ...metrics(40) }], totals: metrics(40), sources: { failovers: true, continuations: true } });
    const json = JSON.stringify(await buildPromptVariantReport({ from: '2026-09-01', to: '2026-09-28' }, [v('chat/claude-small@1', 1, 'active')], ON));
    expect(json).not.toMatch(/orgId|partnerId|userId|connectionName/);
  });

  it('defaults to the last 28 UTC days, today inclusive', () => {
    expect(defaultPromptVariantRange(new Date('2026-10-17T05:00:00Z'))).toEqual({ from: '2026-09-20', to: '2026-10-17' });
  });
});
