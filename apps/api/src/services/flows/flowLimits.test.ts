import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_LIMIT_DEFAULTS, type FlowDocumentV1 } from '@breeze/shared';

/**
 * Tool Catalog W05 (#5220) Task A4 — the flow limits resolver (plan Decision 15):
 * partner default → org override that may only LOWER the partner value.
 */

const { selects, ctx } = vi.hoisted(() => ({
  selects: [] as unknown[][],
  ctx: { scope: undefined as string | undefined, systemCalls: 0 },
}));

vi.mock('../../db', () => {
  const chain = (): unknown => new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const value = selects.shift() ?? [];
        return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
      }
      return () => chain();
    },
  });
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => { ctx.systemCalls += 1; return fn(); },
    getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
  };
});

import { computeFlowLimits, effectiveFlowMonthlyCap, resolveFlowLimits } from './flowLimits';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

function doc(limits?: { monthlyRuns?: number }): FlowDocumentV1 {
  return {
    version: 1, name: 'f', trigger: { type: 'manual' }, inputs: [],
    steps: [{ id: 's', tool: 'wait', input: { minutes: 1 }, approval: 'default', onFailure: 'stop', timeoutSec: 300 }],
    ...(limits ? { limits } : {}),
  } as FlowDocumentV1;
}

beforeEach(() => {
  selects.length = 0;
  ctx.scope = undefined;
  ctx.systemCalls = 0;
});

describe('computeFlowLimits', () => {
  it('missing settings give defaults', () => {
    const l = computeFlowLimits(null, null);
    expect(l).toMatchObject({ ...FLOW_LIMIT_DEFAULTS });
    expect(l.source).toEqual({ monthlyRunsPerOwner: 'default', monthlyRunsPerFlow: 'default', aiTokensPerRun: 'default' });
    expect(l.partnerCeiling).toBeNull();
  });

  it('partner owner gets partner values over defaults', () => {
    const l = computeFlowLimits({ flows: { monthlyRunsPerOwner: 500, monthlyRunsPerFlow: 50 } }, null);
    expect(l).toMatchObject({ monthlyRunsPerOwner: 500, monthlyRunsPerFlow: 50, aiTokensPerRun: FLOW_LIMIT_DEFAULTS.aiTokensPerRun });
    expect(l.source).toEqual({ monthlyRunsPerOwner: 'partner', monthlyRunsPerFlow: 'partner', aiTokensPerRun: 'default' });
  });

  it('org override can lower', () => {
    const l = computeFlowLimits({ flows: { monthlyRunsPerFlow: 50 } }, { flows: { monthlyRunsPerFlow: 10, aiTokensPerRun: 2000 } });
    expect(l).toMatchObject({ monthlyRunsPerFlow: 10, aiTokensPerRun: 2000 });
    expect(l.source.monthlyRunsPerFlow).toBe('org');
    expect(l.source.aiTokensPerRun).toBe('org');
    expect(l.partnerCeiling).toEqual({ ...FLOW_LIMIT_DEFAULTS, monthlyRunsPerFlow: 50 });
  });

  it('org override above the partner value is clamped to it', () => {
    const l = computeFlowLimits({ flows: { monthlyRunsPerFlow: 50 } }, { flows: { monthlyRunsPerFlow: 5000, monthlyRunsPerOwner: 999_999 } });
    expect(l.monthlyRunsPerFlow).toBe(50);
    expect(l.source.monthlyRunsPerFlow).toBe('partner');
    // Above the default the partner left in place: clamped to the default.
    expect(l.monthlyRunsPerOwner).toBe(FLOW_LIMIT_DEFAULTS.monthlyRunsPerOwner);
    expect(l.source.monthlyRunsPerOwner).toBe('default');
  });

  it('a malformed field is ignored on its own, never widening the others', () => {
    const l = computeFlowLimits(
      { flows: { monthlyRunsPerFlow: 50, monthlyRunsPerOwner: 'lots', extra: true } },
      { flows: { monthlyRunsPerFlow: -1, aiTokensPerRun: 10_000_000 } },
    );
    expect(l.monthlyRunsPerFlow).toBe(50);
    expect(l.monthlyRunsPerOwner).toBe(FLOW_LIMIT_DEFAULTS.monthlyRunsPerOwner);
    expect(l.aiTokensPerRun).toBe(FLOW_LIMIT_DEFAULTS.aiTokensPerRun);
  });
});

describe('effectiveFlowMonthlyCap', () => {
  it('document monthlyRuns lowers the flow cap', () => {
    const l = computeFlowLimits({ flows: { monthlyRunsPerFlow: 50 } }, null);
    expect(effectiveFlowMonthlyCap(l, doc())).toBe(50);
    expect(effectiveFlowMonthlyCap(l, doc({ monthlyRuns: 7 }))).toBe(7);
    // A document value above the owner's per-flow value never raises it.
    expect(effectiveFlowMonthlyCap(l, doc({ monthlyRuns: 5000 }))).toBe(50);
  });
});

describe('resolveFlowLimits', () => {
  it('org owner reads partner and org settings', async () => {
    selects.push([{ settings: { flows: { monthlyRunsPerFlow: 50 } } }], [{ settings: { flows: { monthlyRunsPerFlow: 20 } } }]);
    const l = await resolveFlowLimits({ orgId: ORG, partnerId: PARTNER });
    expect(l.monthlyRunsPerFlow).toBe(20);
    expect(ctx.systemCalls).toBe(1);
  });

  it('partner owner reads only partner settings and joins an ambient system tx', async () => {
    ctx.scope = 'system';
    selects.push([{ settings: { flows: { monthlyRunsPerOwner: 7 } } }]);
    const l = await resolveFlowLimits({ orgId: null, partnerId: PARTNER });
    expect(l.monthlyRunsPerOwner).toBe(7);
    expect(l.partnerCeiling).toBeNull();
    expect(ctx.systemCalls).toBe(0);
    expect(selects).toHaveLength(0);
  });
});
