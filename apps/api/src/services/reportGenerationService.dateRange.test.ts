import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../db';
import {
  generateAlertSummaryReport,
  generateExecutiveSummaryReport,
  generatePerformanceReport,
} from './reportGenerationService';
import type { OrgReportExecutionAuthority } from './siteScope';

/**
 * #9562 — the configured reporting window must constrain every time-scoped
 * figure. Saved reports (templates, the portal's self-service definitions)
 * store `dateRange: { preset: 'last_30_days' }` with no start/end; before the
 * fix the generators only read start/end, so a preset report counted alerts
 * (and metric samples) from all time.
 *
 * Only `db.select` is faked; drizzle-orm and the schema are real, so each
 * recorded WHERE compiles to the SQL Postgres would receive.
 */

const dialect = new PgDialect();
const compile = (predicate: unknown) => dialect.sqlToQuery(predicate as SQL);

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const ORG = '00000000-0000-0000-0000-000000000001';
const AUTHORITY: OrgReportExecutionAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG },
  principalUserId: '11111111-1111-4111-8111-111111111111',
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};

let wheres: unknown[] = [];

function recordingChain(rows: unknown[]) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) {
    p[m] = () => p;
  }
  p.where = (w: unknown) => {
    wheres.push(w);
    return p;
  };
  return p;
}

function queueSelects(seq: unknown[][]) {
  const m = vi.mocked(db.select);
  m.mockReset();
  for (const rows of seq) m.mockReturnValueOnce(recordingChain(rows));
  m.mockReturnValue(recordingChain([]));
}

/** Every recorded WHERE that mentions `column`, compiled. */
function wheresOn(column: string) {
  return wheres.map(compile).filter((q) => q.sql.includes(column));
}

describe('report generators honour the configured reporting window (#9562)', () => {
  beforeEach(() => {
    wheres = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('executive summary', () => {
    const SEQ = [
      [{ id: ORG, name: 'Acme Corp' }],
      [{ total: 5, online: 3, offline: 2 }],
      [{ total: 4, critical: 1, high: 1, resolved: 3 }],
      [{ osType: 'windows', count: 5 }],
      [{ siteName: 'HQ', deviceCount: 5 }],
    ];

    it('excludes alerts triggered before a last_30_days window', async () => {
      queueSelects(SEQ);
      await generateExecutiveSummaryReport(ORG, { dateRange: { preset: 'last_30_days' } }, AUTHORITY);

      const [alertWhere, ...rest] = wheresOn('"alerts"');
      expect(rest).toHaveLength(0);
      expect(alertWhere!.sql).toContain('"alerts"."triggered_at" >= $');
      expect(alertWhere!.sql).toContain('"alerts"."triggered_at" <= $');
      expect(alertWhere!.params).toContain(iso(NOW.getTime() - 30 * DAY));
      expect(alertWhere!.params).toContain(iso(NOW.getTime()));
    });

    it('applies the window to the one query that feeds alerts-in-window AND resolution rate', async () => {
      queueSelects(SEQ);
      const result = await generateExecutiveSummaryReport(ORG, { dateRange: { preset: 'last_7_days' } }, AUTHORITY);

      expect(wheresOn('"alerts"."triggered_at"')).toHaveLength(1);
      expect(wheresOn('"alerts"')[0]!.params).toContain(iso(NOW.getTime() - 7 * DAY));
      expect(result.summary!.alerts).toEqual({ total: 4, critical: 1, high: 1, resolved: 3, resolutionRate: 75 });
    });

    it('still honours an explicit start/end', async () => {
      queueSelects(SEQ);
      await generateExecutiveSummaryReport(
        ORG,
        { dateRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-30T23:59:59.000Z' } },
        AUTHORITY,
      );
      const [alertWhere] = wheresOn('"alerts"');
      expect(alertWhere!.params).toContain('2026-09-01T00:00:00.000Z');
      expect(alertWhere!.params).toContain('2026-09-30T23:59:59.000Z');
    });

    it('leaves alerts unbounded when no window is configured', async () => {
      queueSelects(SEQ);
      await generateExecutiveSummaryReport(ORG, {}, AUTHORITY);
      const [alertWhere] = wheresOn('"alerts"');
      expect(alertWhere!.sql).not.toContain('triggered_at');
    });
  });

  it('alert summary bounds its rows and severity counts by the preset window', async () => {
    queueSelects([[], []]);
    await generateAlertSummaryReport(ORG, { dateRange: { preset: 'last_7_days' } }, AUTHORITY);
    const alertWheres = wheresOn('"alerts"."triggered_at" >= $');
    // Both statements (rows + severity summary) share the bounded predicate.
    expect(alertWheres.length).toBeGreaterThanOrEqual(1);
    for (const q of alertWheres) expect(q.params).toContain(iso(NOW.getTime() - 7 * DAY));
    expect(wheresOn('"alerts"').every((q) => q.sql.includes('"alerts"."triggered_at" >= $'))).toBe(true);
  });

  it('performance bounds metric samples by the preset window', async () => {
    queueSelects([[{ id: '22222222-2222-4222-8222-222222222222', hostname: 'pc-1' }], []]);
    await generatePerformanceReport(ORG, { dateRange: { preset: 'last_7_days' } }, AUTHORITY);
    const [metricWhere] = wheresOn('"device_metrics"');
    expect(metricWhere!.sql).toContain('"device_metrics"."timestamp" >= $');
    expect(metricWhere!.params).toContain(iso(NOW.getTime() - 7 * DAY));
  });
});
