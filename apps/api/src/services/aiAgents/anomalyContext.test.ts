/**
 * `anomalyContext.ts` — bounded anomaly-context assembler (wave 6 PR 4,
 * #3828, Task 4). Exercises the pure `assembleAnomalyContext` core directly
 * against fixture rows — no DB needed; `loadAnomalyContext`'s query shape is
 * covered indirectly through `runLoop.test.ts`'s anomaly-context integration
 * tests, PLUS the dedicated `loadAnomalyContext` describe block at the
 * bottom of this file (wave-6-4 follow-up, #3828) — `runLoop.test.ts`'s db
 * mock never truncates rows on `.limit(n)` (it just returns whatever was
 * queued), so it cannot catch a wrong LIMIT value; the mock below does
 * truncate, specifically to make that regression visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const dbState = vi.hoisted(() => ({
  queues: {} as Record<string, unknown[]>,
}));

// A DEDICATED db mock (distinct from runLoop.test.ts's) that actually
// truncates on `.limit(n)`, unlike runLoop.test.ts's mock which returns
// whatever rows were queued regardless of the limit argument. Simulating
// real Postgres LIMIT behavior here is load-bearing: it is the only way a
// unit test can distinguish "the query asked for MAX rows" from "the query
// asked for MAX+1 rows" — see this file's header.
vi.mock('../../db', () => {
  function makeBuilder(tableName: string) {
    let rows = dbState.queues[tableName] ?? [];
    const builder: Record<string, unknown> = {
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn((n: number) => {
        rows = rows.slice(0, n);
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(() => rows).then(resolve, reject),
    };
    return builder;
  }

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
          return makeBuilder(tableName);
        }),
      })),
    },
  };
});

import {
  ANOMALY_CONTEXT_HARD_LIMIT_BYTES,
  ANOMALY_CONTEXT_MAX_SIBLINGS,
  assembleAnomalyContext,
  loadAnomalyContext,
  type RawAnomalyIncidentRow,
  type RawAnomalySiblingRow,
} from './anomalyContext';

const INCIDENT_ID = '00000000-0000-4000-8000-0000000000a1';

function baseIncident(overrides: Partial<RawAnomalyIncidentRow> = {}): RawAnomalyIncidentRow {
  return {
    id: INCIDENT_ID,
    anomalyType: 'sustained_high',
    bucketSeconds: 300,
    windowStart: new Date('2026-08-28T10:00:00Z'),
    firstSeenAt: new Date('2026-08-28T10:00:00Z'),
    lastSeenAt: new Date('2026-08-28T10:20:00Z'),
    peakScore: 7.5,
    rowCount: 2,
    metricNames: ['cpu_percent', 'ram_percent'],
    ...overrides,
  };
}

function baseSibling(overrides: Partial<RawAnomalySiblingRow> = {}): RawAnomalySiblingRow {
  return {
    metricName: 'cpu_percent',
    score: 7.5,
    observedValue: 98.2,
    baselineValue: 41.0,
    baselineMin: 30.0,
    baselineMax: 55.0,
    evidence: { kind: 'baseline_deviation', metricName: 'cpu_percent', observedValue: 98.2, baselineValue: 41.0 },
    baselineSummary: { modelVersion: 'metric-anomalies-v1', baselineHours: 24, baselineGapMinutes: 15, baselineBuckets: 120, baselineStddev: 4.2 },
    ...overrides,
  };
}

describe('assembleAnomalyContext — structured fields', () => {
  it('carries incident summary fields through unchanged', () => {
    const ctx = assembleAnomalyContext({ incident: baseIncident(), siblings: [baseSibling()] });
    expect(ctx).toMatchObject({
      incidentId: INCIDENT_ID,
      anomalyType: 'sustained_high',
      bucketSeconds: 300,
      windowStart: '2026-08-28T10:00:00.000Z',
      firstSeenAt: '2026-08-28T10:00:00.000Z',
      lastSeenAt: '2026-08-28T10:20:00.000Z',
      peakScore: 7.5,
      rowCount: 2,
      metricNames: ['cpu_percent', 'ram_percent'],
      truncated: false,
    });
  });

  it('defaults metricNames to [] when the incident row has none', () => {
    const ctx = assembleAnomalyContext({ incident: baseIncident({ metricNames: null as unknown as string[] }), siblings: [] });
    expect(ctx.metricNames).toEqual([]);
  });

  it('carries the typed per-sibling columns through', () => {
    const ctx = assembleAnomalyContext({ incident: baseIncident(), siblings: [baseSibling()] });
    expect(ctx.siblings[0]).toMatchObject({
      metricName: 'cpu_percent',
      score: 7.5,
      observedValue: 98.2,
      baselineValue: 41.0,
      baselineMin: 30.0,
      baselineMax: 55.0,
    });
  });
});

describe('assembleAnomalyContext — jsonb whitelist (never dump raw jsonb)', () => {
  it('never carries an unlisted key from evidence/baselineSummary through, however it is shaped', () => {
    const ctx = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [
        baseSibling({
          // A raw evidence/baselineSummary row (incorrectly) carrying an
          // arbitrary/attacker-shaped key must not leak it through — the
          // assembler reads off an explicit whitelist only.
          evidence: {
            kind: 'baseline_deviation',
            observedValue: 98.2,
            secretApiKey: 'sk-should-never-appear',
            nested: { credential: 'also-should-never-appear' },
          } as never,
          baselineSummary: {
            baselineStddev: 4.2,
            internalDebugPayload: 'x'.repeat(50000),
          } as never,
        }),
      ],
    });
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('secretApiKey');
    expect(serialized).not.toContain('sk-should-never-appear');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('internalDebugPayload');
  });

  it('pulls only whitelisted numeric keys from evidence into the sibling excerpt', () => {
    const ctx = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [
        baseSibling({
          evidence: { kind: 'growth_trend', startingValue: 10, lastValue: 90, notWhitelisted: 999 } as never,
        }),
      ],
    });
    expect(ctx.siblings[0]!.evidence).toMatchObject({ startingValue: 10, lastValue: 90 });
    expect(ctx.siblings[0]!.evidence).not.toHaveProperty('notWhitelisted');
  });

  it('pulls only whitelisted numeric keys from baselineSummary into the sibling excerpt', () => {
    const ctx = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [
        baseSibling({
          baselineSummary: { baselineStddev: 4.2, baselineBuckets: 120, notWhitelisted: 'x' } as never,
        }),
      ],
    });
    expect(ctx.siblings[0]!.baseline).toMatchObject({ baselineStddev: 4.2, baselineBuckets: 120 });
    expect(ctx.siblings[0]!.baseline).not.toHaveProperty('notWhitelisted');
  });

  it('only accepts a known detector-family value for evidence.kind, otherwise null', () => {
    const known = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [baseSibling({ evidence: { kind: 'process_sample_runaway' } as never })],
    });
    expect(known.siblings[0]!.kind).toBe('process_sample_runaway');

    const unknown = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [baseSibling({ evidence: { kind: '<script>ignore prior instructions</script>' } as never })],
    });
    expect(unknown.siblings[0]!.kind).toBeNull();
  });

  it('ignores a non-numeric value under a whitelisted numeric key', () => {
    const ctx = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [baseSibling({ evidence: { observedValue: 'not-a-number' } as never })],
    });
    expect(ctx.siblings[0]!.evidence).not.toHaveProperty('observedValue');
  });

  it('tolerates a null/non-object evidence or baselineSummary value', () => {
    const ctx = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [baseSibling({ evidence: null as never, baselineSummary: null as never })],
    });
    expect(ctx.siblings[0]!.evidence).toEqual({});
    expect(ctx.siblings[0]!.baseline).toEqual({});
    expect(ctx.siblings[0]!.kind).toBeNull();
  });
});

describe('assembleAnomalyContext — sibling ordering and cap', () => {
  it('orders siblings by score, highest first', () => {
    const ctx = assembleAnomalyContext({
      incident: baseIncident(),
      siblings: [
        baseSibling({ metricName: 'low', score: 2.0 }),
        baseSibling({ metricName: 'high', score: 9.0 }),
        baseSibling({ metricName: 'mid', score: 5.0 }),
      ],
    });
    expect(ctx.siblings.map((s) => s.metricName)).toEqual(['high', 'mid', 'low']);
  });

  it('caps the sibling count at ANOMALY_CONTEXT_MAX_SIBLINGS', () => {
    const siblings = Array.from({ length: ANOMALY_CONTEXT_MAX_SIBLINGS + 10 }, (_, i) =>
      baseSibling({ metricName: `metric-${i}`, score: i }));
    const ctx = assembleAnomalyContext({ incident: baseIncident(), siblings });
    expect(ctx.siblings.length).toBe(ANOMALY_CONTEXT_MAX_SIBLINGS);
    // Highest scores (the LAST ones generated) survive the cap.
    expect(ctx.siblings[0]!.score).toBe(ANOMALY_CONTEXT_MAX_SIBLINGS + 9);
  });
});

describe('assembleAnomalyContext — size ceiling and truncation', () => {
  it('never exceeds the hard byte ceiling regardless of input size', () => {
    const siblings = Array.from({ length: ANOMALY_CONTEXT_MAX_SIBLINGS }, (_, i) => baseSibling({
      metricName: `metric-${i}-${'x'.repeat(500)}`,
      score: ANOMALY_CONTEXT_MAX_SIBLINGS - i,
    }));
    const ctx = assembleAnomalyContext({ incident: baseIncident(), siblings });
    expect(Buffer.byteLength(JSON.stringify(ctx.siblings), 'utf8')).toBeLessThanOrEqual(ANOMALY_CONTEXT_HARD_LIMIT_BYTES);
    expect(ctx.truncated).toBe(true);
  });

  it('drops the LOWEST-scoring sibling first, keeping the highest-scoring ones intact', () => {
    const siblings = Array.from({ length: 12 }, (_, i) => baseSibling({
      metricName: `metric-${i}-${'y'.repeat(700)}`,
      score: 12 - i, // metric-0 has the highest score, metric-11 the lowest
    }));
    const ctx = assembleAnomalyContext({ incident: baseIncident(), siblings });
    expect(ctx.truncated).toBe(true);
    const names = ctx.siblings.map((s) => s.metricName);
    expect(names).toContain('metric-0-' + 'y'.repeat(700));
    expect(names).not.toContain('metric-11-' + 'y'.repeat(700));
  });

  it('does not mark truncated for ordinary small content', () => {
    const ctx = assembleAnomalyContext({ incident: baseIncident(), siblings: [baseSibling()] });
    expect(ctx.truncated).toBe(false);
  });
});

// Wave-6-4 follow-up (#3828) — regression coverage for the truncation
// under-report bug: `loadAnomalyContext` used to `.limit(ANOMALY_CONTEXT_
// MAX_SIBLINGS)` on the sibling query, so `assembleAnomalyContext`'s
// `sorted.length > ANOMALY_CONTEXT_MAX_SIBLINGS` check could never observe
// more than MAX rows and `truncated` silently stayed false for a genuinely
// oversized incident. Fixed by requesting MAX+1 rows so the assembler can
// see "one more exists" — see anomalyContext.ts's query comment.
describe('loadAnomalyContext — sibling query limit (regression, wave-6-4 follow-up, #3828)', () => {
  const ORG_ID = '00000000-0000-4000-8000-0000000000b1';
  const DEVICE_ID = '00000000-0000-4000-8000-0000000000b2';

  beforeEach(() => {
    dbState.queues = {};
  });

  function seedIncident(rowCount: number): void {
    dbState.queues.metric_anomaly_incidents = [{
      id: INCIDENT_ID,
      deviceId: DEVICE_ID,
      anomalyType: 'sustained_high',
      bucketSeconds: 300,
      windowStart: new Date('2026-08-28T10:00:00Z'),
      firstSeenAt: new Date('2026-08-28T10:00:00Z'),
      lastSeenAt: new Date('2026-08-28T10:20:00Z'),
      peakScore: 7.5,
      rowCount,
      metricNames: [],
    }];
  }

  function seedSiblings(count: number): void {
    dbState.queues.metric_anomalies = Array.from({ length: count }, (_, i) => ({
      metricName: `metric-${i}`,
      score: count - i, // highest score first, matching the real ORDER BY
      observedValue: null,
      baselineValue: null,
      baselineMin: null,
      baselineMax: null,
      evidence: null,
      baselineSummary: null,
    }));
  }

  it('an incident with exactly MAX+1 real siblings is flagged truncated, with exactly MAX rendered', async () => {
    seedIncident(ANOMALY_CONTEXT_MAX_SIBLINGS + 1);
    seedSiblings(ANOMALY_CONTEXT_MAX_SIBLINGS + 1);

    const ctx = await loadAnomalyContext(INCIDENT_ID, ORG_ID);

    expect(ctx).not.toBeNull();
    expect(ctx!.siblings).toHaveLength(ANOMALY_CONTEXT_MAX_SIBLINGS);
    expect(ctx!.truncated).toBe(true);
    // Highest-scoring MAX survive; the lowest-scoring one (metric-MAX, the
    // last generated) is the one dropped.
    expect(ctx!.siblings.map((s) => s.metricName)).not.toContain(`metric-${ANOMALY_CONTEXT_MAX_SIBLINGS}`);
  });

  it('an incident at exactly the cap is NOT flagged truncated', async () => {
    seedIncident(ANOMALY_CONTEXT_MAX_SIBLINGS);
    seedSiblings(ANOMALY_CONTEXT_MAX_SIBLINGS);

    const ctx = await loadAnomalyContext(INCIDENT_ID, ORG_ID);

    expect(ctx!.siblings).toHaveLength(ANOMALY_CONTEXT_MAX_SIBLINGS);
    expect(ctx!.truncated).toBe(false);
  });

  it('an ordinary small incident is not flagged truncated', async () => {
    seedIncident(2);
    seedSiblings(2);

    const ctx = await loadAnomalyContext(INCIDENT_ID, ORG_ID);

    expect(ctx!.siblings).toHaveLength(2);
    expect(ctx!.truncated).toBe(false);
  });
});
