import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../../../db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { EvidenceCursor } from '@breeze/shared';
import { eventLogHandler } from './eventLog';

describe('eventLogHandler.validate', () => {
  const base = { category: 'application', countThreshold: 1, windowMinutes: 60 };

  // #8174 — the agent now ships Information-level Application events from an
  // allowlisted provider set (APPLICATION_INFO_EVENT_PROVIDERS), so a compiled info rule must validate.
  it.each(['info', 'warning', 'error', 'critical'])('accepts level %s', (level) => {
    expect(eventLogHandler.validate!({ ...base, level }, 'c')).toEqual([]);
  });

  it('rejects an unknown level', () => {
    expect(eventLogHandler.validate!({ ...base, level: 'information' }, 'c')).toEqual(['c.level: Invalid level']);
  });
});


const now = new Date('2026-10-30T12:00:00.000Z');
const cursor: EvidenceCursor = {
  ts: '2026-10-30T11:30:00.000Z', createdAt: '2026-10-30T11:31:00.000Z', id: 'event-2',
};
const condition = { type: 'event_log', category: 'application', level: 'warning', countThreshold: 5, windowMinutes: 60 };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: cursor.id, timestamp: new Date(cursor.ts), createdAt: new Date(cursor.createdAt), ...overrides,
});
const dialect = new PgDialect();
function queueReads(...results: Array<Array<Record<string, unknown>>>) {
  const queries = results.map(rows => {
    const query = {
      from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
      then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
    };
    vi.mocked(db.select).mockReturnValueOnce(query as never);
    return query;
  });
  return queries;
}
function compiled(query: ReturnType<typeof queueReads>[number]) {
  return dialect.sqlToQuery(query.where.mock.calls[0]![0] as SQL);
}

describe('eventLogHandler.evaluate', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('with a cursor, requires one matching row ordered after it', async () => {
    for (const candidates of [[], [row()], [row({ timestamp: new Date('2026-10-30T11:29:59Z') })]]) {
      queueReads([{ count: 5 }], candidates);
      const result = await eventLogHandler.evaluate(condition, 'device-1', { evidenceAfter: cursor });
      expect(result.passed).toBe(false);
      expect(result.description).toContain(' (no new evidence since last episode)');
      expect(result).not.toHaveProperty('dataAvailable');
    }
  });

  it('with a cursor, still counts old rows toward countThreshold', async () => {
    const newer = row({ timestamp: new Date('2026-10-30T11:32:00Z') });
    queueReads([{ count: 6 }], [newer]);
    const result = await eventLogHandler.evaluate(condition, 'device-1', { evidenceAfter: cursor });
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(6);
  });

  it('orders same-log Windows events by recordId when timestamps tie', async () => {
    for (const recordId of [101, 99]) {
      const candidate = row({ id: 'event-1', logName: 'Application', recordId: String(recordId) });
      vi.mocked(db.select).mockClear();
      queueReads([{ count: 5 }], [candidate]);
      const result = await eventLogHandler.evaluate(condition, 'device-1', {
        evidenceAfter: { ...cursor, logName: 'Application', recordId: 100 }, side: 'trigger',
      });
      expect(result.passed).toBe(recordId > 100);
      expect(result.evidenceWatermark?.recordId).toBe(recordId);
      expect(db.select).toHaveBeenCalledTimes(2); // candidates double as the newest row
    }
  });

  it('window still applies under a cursor', async () => {
    const queries = queueReads([{ count: 5 }], []);
    await eventLogHandler.evaluate({ ...condition, sourcePattern: 'app_%', messagePattern: 'disk_%' }, 'device-1', { evidenceAfter: cursor });
    const count = compiled(queries[0]!);
    const candidates = compiled(queries[1]!);
    expect(candidates.params).toEqual([...count.params, '2026-10-30T11:29:59.000Z']);
    expect(candidates.params).toContain('2026-10-30T11:00:00.000Z');
    expect(candidates.params).toContain('device-1');
    expect(candidates.params).toContain('%app\\_\\%%');
    expect(candidates.params).toContain('%disk\\_\\%%');
    expect(candidates.sql).toContain('"timestamp" >=');
    expect(queries[1]!.limit).toHaveBeenCalledWith(50);
    expect(queries[1]!.orderBy.mock.calls[0]!.map((s: SQL) => dialect.sqlToQuery(s).sql))
      .toEqual(['"device_event_logs"."timestamp" desc', '"device_event_logs"."created_at" desc', '"device_event_logs"."id" desc']);
  });

  it('returns the newest matching row as evidenceWatermark', async () => {
    const queries = queueReads([{ count: 5 }], [row({ logName: 'Application', recordId: '42' })]);
    const result = await eventLogHandler.evaluate(condition, 'device-1');
    expect(result.evidenceWatermark).toEqual({ ...cursor, logName: 'Application', recordId: 42 });
    expect(queries[1]!.limit).toHaveBeenCalledWith(1);
  });

  it('no cursor → behaviour identical to today', async () => {
    for (const count of [0, 4, 5, 6]) {
      vi.mocked(db.select).mockReset();
      queueReads([{ count }], ...(count ? [[row()]] : []));
      const result = await eventLogHandler.evaluate(condition, 'device-1');
      expect(result.passed).toBe(count >= 5);
      expect(result.actualValue).toBe(count);
      expect(result.description).toBe(`application/warning events >= 5 in 60min (found ${count})`);
      expect(result).not.toHaveProperty('dataAvailable');
      if (!count) expect(result).not.toHaveProperty('evidenceWatermark');
    }
  });

  it('legacy closed alert without cursor treats events ingested at or before the close as consumed', async () => {
    for (const probe of [[], [{ exists: 1 }]]) {
      const queries = queueReads([{ count: 5 }], probe, ...(probe.length ? [[row()]] : []));
      const result = await eventLogHandler.evaluate(condition, 'device-1', { legacyIngestedBefore: now });
      expect(result.passed).toBe(probe.length > 0);
      const query = compiled(queries[1]!);
      expect(query.sql).toContain('"created_at" >');
      expect(query.params).toEqual([...compiled(queries[0]!).params, now.toISOString()]);
      expect(queries[1]!.limit).toHaveBeenCalledWith(1);
      expect(result.evidenceWatermark).toEqual(probe.length ? cursor : undefined);
    }
  });

  it('skips evidence probes and the watermark read below threshold', async () => {
    for (const count of [0, 4]) {
      vi.mocked(db.select).mockReset();
      queueReads([{ count }], ...(count ? [[row()]] : []));
      const result = await eventLogHandler.evaluate(condition, 'device-1', { evidenceAfter: cursor, legacyIngestedBefore: now });
      expect(result.passed).toBe(false);
      expect(result).not.toHaveProperty('evidenceWatermark');
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(result.description).not.toContain('no new evidence');
    }
  });

  it('omits invalid optional watermark fields and absent rows', async () => {
    queueReads([{ count: 5 }], [row({ logName: '', recordId: 'not-a-number' })]);
    expect((await eventLogHandler.evaluate(condition, 'device-1')).evidenceWatermark).toEqual(cursor);
    queueReads([{ count: 5 }], []);
    expect(await eventLogHandler.evaluate(condition, 'device-1')).not.toHaveProperty('evidenceWatermark');
  });

  it('honors resolve-side ties and prefers a cursor over the legacy flag', async () => {
    queueReads([{ count: 5 }], [row()]);
    expect((await eventLogHandler.evaluate(condition, 'device-1', {
      evidenceAfter: cursor, side: 'resolve', legacyIngestedBefore: now,
    })).passed).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
