import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit level for the P2-6 impact rollup. The REAL SQL is proven against live
 * Postgres in `__tests__/integration/aiAgentImpact.integration.test.ts` (A9);
 * what is provable here is the UTC day arithmetic, the DB-context discipline
 * (escape-then-labelled-system-context, one low-cardinality label), and the
 * invariants of the compiled statement that a live run would only reveal as a
 * wrong number or a runtime cast error.
 */

type ContextTraceEvent =
  | { type: 'escape' }
  | { type: 'open'; label: string | undefined }
  | { type: 'execute' }
  | { type: 'close'; label: string | undefined };

const { executeMock, runOutsideDbContextMock, withSystemDbAccessContextMock, contextTrace } = vi.hoisted(() => {
  const contextTrace: ContextTraceEvent[] = [];
  return {
    contextTrace,
    executeMock: vi.fn(),
    runOutsideDbContextMock: vi.fn(<T>(fn: () => T): T => {
      contextTrace.push({ type: 'escape' });
      return fn();
    }),
    withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
      contextTrace.push({ type: 'open', label });
      try {
        return await fn();
      } finally {
        contextTrace.push({ type: 'close', label });
      }
    }),
  };
});

vi.mock('../../db', () => ({
  db: { execute: executeMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import { IMPACT_FIX_TOOLS } from './impactFixTools';
import {
  findImpactSourceOrgIds,
  lastCompleteUtcDay,
  needsImpactBootstrap,
  rebuildOrgImpactRange,
  shiftUtcDay,
  utcDaySpan,
} from './impactRollup';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const dialect = new PgDialect();

/** The statement handed to `db.execute`, compiled the way the driver sees it. */
function compiled(callIndex = 0): { text: string; params: unknown[] } {
  const statement = executeMock.mock.calls[callIndex]?.[0];
  expect(statement, `expected a db.execute call at index ${callIndex}`).toBeDefined();
  const query = dialect.sqlToQuery(statement as never);
  return { text: query.sql, params: query.params as unknown[] };
}

describe('impact rollup day helpers', () => {
  it('returns the last COMPLETE UTC day, never the current one', () => {
    expect(lastCompleteUtcDay(new Date('2026-09-01T00:05:00Z'))).toBe('2026-08-31');
    expect(lastCompleteUtcDay(new Date('2026-09-01T23:59:59Z'))).toBe('2026-08-31');
  });

  it('crosses the year boundary', () => {
    expect(lastCompleteUtcDay(new Date('2026-01-01T23:59:59Z'))).toBe('2025-12-31');
  });

  it('crosses a non-leap February boundary', () => {
    expect(lastCompleteUtcDay(new Date('2026-03-01T12:00:00Z'))).toBe('2026-02-28');
  });

  it('shifts days in the UTC calendar, across month boundaries in both directions', () => {
    expect(shiftUtcDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftUtcDay('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftUtcDay('2026-09-01', -89)).toBe('2026-06-04');
  });

  it('counts an INCLUSIVE day span', () => {
    expect(utcDaySpan('2026-08-25', '2026-08-31')).toBe(7);
    expect(utcDaySpan('2026-08-31', '2026-08-31')).toBe(1);
  });

  it('rejects a malformed day instead of silently producing NaN', () => {
    expect(() => shiftUtcDay('2026-8-1', 1)).toThrow(/Invalid UTC day/);
    expect(() => utcDaySpan('2026-02-30', '2026-03-01')).toThrow(/Invalid UTC day/);
  });
});

describe('rebuildOrgImpactRange', () => {
  beforeEach(() => {
    contextTrace.length = 0;
    executeMock.mockReset();
    executeMock.mockImplementation(async () => {
      contextTrace.push({ type: 'execute' });
      return [];
    });
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
  });

  it('escapes any ambient context, then opens ONE labelled system context per call', async () => {
    const result = await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');

    expect(result).toEqual({ orgId: ORG_ID, fromDay: '2026-08-25', toDay: '2026-08-31', days: 7 });
    expect(contextTrace).toEqual([
      { type: 'escape' },
      { type: 'open', label: 'aiAgentImpactRollup.rebuild' },
      { type: 'execute' },
      { type: 'close', label: 'aiAgentImpactRollup.rebuild' },
    ]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the context label low-cardinality — never per org or per range', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    await rebuildOrgImpactRange('22222222-2222-2222-2222-222222222222', '2026-01-01', '2026-01-02');

    const labels = withSystemDbAccessContextMock.mock.calls.map((call) => call[1]);
    expect(labels).toEqual(['aiAgentImpactRollup.rebuild', 'aiAgentImpactRollup.rebuild']);
    for (const label of labels) {
      expect(label).not.toContain(ORG_ID);
      expect(label).not.toContain('2026-');
    }
  });

  it('upserts a zero-emitting generate_series day grid', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    const { text } = compiled();

    expect(text).toContain('generate_series');
    expect(text).toContain('ON CONFLICT (org_id, day) DO UPDATE');
    expect(text).toContain('LEFT JOIN');
    // Every counter column is COALESCEd, so a day with no source facts writes a
    // zero row rather than being skipped (a skipped day leaves a stale bucket).
    for (const column of [
      'alerts_judged', 'noise_flagged', 'suppressions_applied', 'tickets_triaged', 'drafts_sent',
      'fixes_proposed', 'fixes_executed', 'fix_watches_held', 'fix_watches_recurred',
      'narratives_delivered', 'llm_cents',
    ]) {
      expect(text).toMatch(new RegExp(`${column}\\s+= EXCLUDED\\.${column}`));
    }
  });

  it('buckets in explicit UTC and never with the session-timezone-dependent date_trunc', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    const { text } = compiled();

    expect(text).toContain("AT TIME ZONE 'UTC'");
    expect(text).not.toContain('date_trunc');
  });

  it('inlines the range bounds instead of materializing a bounds CTE', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    const { text } = compiled();

    // A `bounds` CTE referenced by nine siblings is materialized, which stops the
    // range predicates being constant-folded and loses the index range scans.
    expect(text).not.toMatch(/\bbounds\b/);
  });

  it('reads every source the counters are derived from', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    const { text } = compiled();

    for (const source of [
      'ai_alert_verdicts', 'action_intents', 'ai_agent_runs', 'ticket_drafts', 'ai_agent_fix_watches',
    ]) {
      expect(text).toContain(source);
    }
    // The two jsonb arms and the disjointness predicate that keeps the
    // intent-backed arm from double-counting the outcome-backed one.
    expect(text).toContain("jsonb_array_elements");
    expect(text).toContain("'proposedActions'");
    expect(text).toContain("'executedActions'");
    expect(text).toContain("item->>'intentId' IS NULL");
  });

  it('binds the fix-tool registry as a real text[] array, not a row constructor', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    const { text, params } = compiled();

    // Embedding a JS array directly (`ANY(${tools}::text[])`) makes drizzle expand
    // it to a TUPLE — `ANY(($1, $2, …)::text[])` — which a live server rejects.
    // Same trap as extensions/tenancyTripwire.ts:224-229.
    expect(text).toMatch(/ANY\(ARRAY\[\$\d+(, \$\d+)+\]::text\[\]\)/);
    expect(text).not.toMatch(/ANY\(\(\$\d+, \$\d+/);
    for (const tool of IMPACT_FIX_TOOLS) {
      expect(params).toContain(tool);
    }
    // The sentinel is not a dispatchable tool and must never be counted.
    expect(params).not.toContain('remediation_suggestion');
  });

  it('pins org_id explicitly and passes both range bounds as parameters', async () => {
    await rebuildOrgImpactRange(ORG_ID, '2026-08-25', '2026-08-31');
    const { params } = compiled();

    expect(params).toContain(ORG_ID);
    expect(params).toContain('2026-08-25');
    expect(params).toContain('2026-08-31');
  });

  it('rejects an inverted range instead of silently upserting nothing', async () => {
    await expect(rebuildOrgImpactRange(ORG_ID, '2026-08-31', '2026-08-25')).rejects.toThrow(
      /range must have fromDay <= toDay/,
    );
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('findImpactSourceOrgIds', () => {
  beforeEach(() => {
    contextTrace.length = 0;
    executeMock.mockReset();
    executeMock.mockImplementation(async () => {
      contextTrace.push({ type: 'execute' });
      return [];
    });
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
  });

  it('unions EVERY source timestamp, not just the run timestamps', async () => {
    await findImpactSourceOrgIds('2026-08-25', '2026-08-31');
    const { text } = compiled();

    expect(text).toContain('queued_at');
    expect(text).toContain('finished_at');
    expect(text).toContain('created_at');
    expect(text).toContain('executed_at');
    expect(text).toContain('evaluated_at');
    expect(text).toContain('consumed_at');
    expect(text).toContain('SELECT DISTINCT org_id');
    expect(text).toContain("origin_principal_kind");
    expect(text).toContain("AT TIME ZONE 'UTC'");
    expect(text).not.toContain('date_trunc');
  });

  it('runs in its own labelled system context, outside any ambient one', async () => {
    await findImpactSourceOrgIds('2026-08-25', '2026-08-31');

    expect(contextTrace).toEqual([
      { type: 'escape' },
      { type: 'open', label: 'aiAgentImpactRollup.discoverOrgs' },
      { type: 'execute' },
      { type: 'close', label: 'aiAgentImpactRollup.discoverOrgs' },
    ]);
  });

  it('returns the discovered org ids and drops any null', async () => {
    executeMock.mockResolvedValue([{ org_id: ORG_ID }, { org_id: null }, { org_id: '33333333-3333-3333-3333-333333333333' }]);

    await expect(findImpactSourceOrgIds('2026-08-25', '2026-08-31')).resolves.toEqual([
      ORG_ID,
      '33333333-3333-3333-3333-333333333333',
    ]);
  });

  it('rejects an inverted range', async () => {
    await expect(findImpactSourceOrgIds('2026-08-31', '2026-08-25')).rejects.toThrow(
      /range must have fromDay <= toDay/,
    );
  });
});

describe('needsImpactBootstrap', () => {
  beforeEach(() => {
    contextTrace.length = 0;
    executeMock.mockReset();
    executeMock.mockImplementation(async () => {
      contextTrace.push({ type: 'execute' });
      return [];
    });
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
  });

  it('probes the OLDEST day of the full rebuild window', async () => {
    await needsImpactBootstrap(ORG_ID, '2026-09-01');
    const { text, params } = compiled();

    expect(text).toContain('ai_agent_impact_daily');
    expect(params).toContain(ORG_ID);
    // 2026-09-01 minus (AI_AGENT_IMPACT_REBUILD_DAYS - 1) = minus 89 days.
    expect(params).toContain('2026-06-04');
  });

  it('is true when that bucket is missing and false when it exists', async () => {
    executeMock.mockResolvedValue([]);
    await expect(needsImpactBootstrap(ORG_ID, '2026-09-01')).resolves.toBe(true);

    executeMock.mockResolvedValue([{ present: 1 }]);
    await expect(needsImpactBootstrap(ORG_ID, '2026-09-01')).resolves.toBe(false);
  });

  it('runs in its own labelled system context, outside any ambient one', async () => {
    await needsImpactBootstrap(ORG_ID, '2026-09-01');

    expect(contextTrace).toEqual([
      { type: 'escape' },
      { type: 'open', label: 'aiAgentImpactRollup.bootstrapProbe' },
      { type: 'execute' },
      { type: 'close', label: 'aiAgentImpactRollup.bootstrapProbe' },
    ]);
  });
});
