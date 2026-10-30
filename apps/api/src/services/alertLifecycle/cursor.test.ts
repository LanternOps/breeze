import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { EvidenceCursor } from '@breeze/shared';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), select: vi.fn(), limit: vi.fn(), readWhere: vi.fn(),
  update: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn(),
}));
vi.mock('../../db', () => ({ db: {
  execute: mocks.execute,
  select: mocks.select,
  update: mocks.update,
} }));

import {
  readClosedCursors, readOpenCursors, mergeCursors, advanceOpenCursors,
  contextWithCursorSql, freezeRecoveryCursor, resolveSideCursors,
} from './cursor';

const dialect = new PgDialect();
const compile = (value: SQL) => dialect.sqlToQuery(value);
const event = (n: number): EvidenceCursor => ({
  ts: `2026-10-29T10:00:0${n}.000Z`, createdAt: '2026-10-29T10:01:00.000Z', id: `event-${n}`,
});
const row = (cursor: unknown, status = 'active') => ({ status, context: { lifecycle: { cursor } } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockResolvedValue([]);
  mocks.select.mockReturnValue({ from: () => ({ where: mocks.readWhere }) });
  mocks.readWhere.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockResolvedValue([]);
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ id: 'alert-1' }]);
});

describe('cursor store', () => {
  it('reads the newest closed alert per rule including dismissed', async () => {
    const closedAt = new Date('2026-10-29T11:00:00Z');
    mocks.execute.mockResolvedValue([
      { ruleId: 'rule-1', cursor: { root: event(2) }, closedAt },
      { ruleId: 'rule-2', cursor: {}, closedAt },
    ]);
    expect(await readClosedCursors('device-1', ['rule-1', 'rule-2'])).toEqual(new Map([
      ['rule-1', { cursors: { root: event(2) }, closedAt, legacy: false }],
      ['rule-2', { cursors: {}, closedAt, legacy: false }],
    ]));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const query = compile(mocks.execute.mock.calls[0][0]);
    expect(query.sql).toMatch(/order by "alerts"\."rule_id", COALESCE\("alerts"\."resolved_at", "alerts"\."dismissed_at"\) desc/i);
    expect(query.params).toEqual(['device-1', ['rule-1', 'rule-2']]);
  });

  it('ignores open alerts', async () => {
    await readClosedCursors('device-1', ['rule-1']);
    const { sql } = compile(mocks.execute.mock.calls[0][0]);
    expect(sql).toMatch(/distinct on \("alerts"\."rule_id"\)/i);
    expect(sql).toContain('"alerts"."device_id" = $1');
    expect(sql).toMatch(/"alerts"\."rule_id" = ANY\(\$2/i);
    expect(sql).toContain('"alerts"."rule_id" IS NOT NULL');
    expect(sql).toContain("\"alerts\".\"status\" IN ('resolved', 'dismissed')");
    expect(sql).toContain("COALESCE(\"alerts\".\"subject_key\", '') = ''");
  });

  it('reads closedAt as UTC so the driver never parses a tz-less timestamp in local time', async () => {
    await readClosedCursors('device-1', ['rule-1']);
    const { sql } = compile(mocks.execute.mock.calls[0][0]);
    expect(sql).toMatch(/COALESCE\("alerts"\."resolved_at", "alerts"\."dismissed_at"\) AT TIME ZONE 'UTC' AS "closedAt"/);
  });

  it('skips the query for empty ruleIds', async () => {
    expect(await readClosedCursors('device-1', [])).toEqual(new Map());
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], 'invalid'])('legacy row without a stored cursor is reported legacy with closedAt (%s)', async cursor => {
    const closedAt = new Date('2026-10-29T11:00:00Z');
    mocks.execute.mockResolvedValue([{ ruleId: 'rule-1', cursor, closedAt }]);
    expect((await readClosedCursors('device-1', ['rule-1'])).get('rule-1'))
      .toEqual({ cursors: null, closedAt, legacy: true });
  });

  it('reads one alert cursor and returns {} when none is stored', async () => {
    mocks.limit.mockResolvedValueOnce([row({ root: event(1) })]).mockResolvedValueOnce([{ context: null }]);
    expect(await readOpenCursors('alert-1')).toEqual({ root: event(1) });
    expect(await readOpenCursors('alert-1')).toEqual({});
    expect(await readOpenCursors('missing')).toEqual({});
    expect(compile(mocks.readWhere.mock.calls[0][0]).params).toEqual(['alert-1']);
  });

  it('advance-only: never moves a cursor backwards', async () => {
    const prev = { root: event(3), retained: event(2) };
    expect(mergeCursors(prev, { root: event(1), added: event(2) })).toEqual({
      merged: { ...prev, added: event(2) }, changed: true,
    });
    expect(prev).toEqual({ root: event(3), retained: event(2) });
    mocks.limit.mockResolvedValue([row(prev)]);
    expect(await advanceOpenCursors('alert-1', { root: event(1) })).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not write when the watermark is unchanged', async () => {
    mocks.limit.mockResolvedValue([row({ root: event(2) })]);
    expect(await advanceOpenCursors('alert-1', { root: { ...event(2), logName: 'extra' } })).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not touch a resolved alert', async () => {
    mocks.limit.mockResolvedValueOnce([row({ root: event(1) })])
      .mockResolvedValueOnce([row({ root: event(1) }, 'resolved')]);
    mocks.returning.mockResolvedValue([]);
    expect(await advanceOpenCursors('alert-1', { root: event(2) })).toBe(false);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const query = compile(mocks.where.mock.calls[0][0]);
    expect(query.sql).toContain('"alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4) and');
    expect(query.sql).toContain("->'lifecycle'->'cursor') IS NOT DISTINCT FROM $5::jsonb");
    expect(query.params).toEqual(['alert-1', 'active', 'acknowledged', 'suppressed', JSON.stringify({ root: event(1) })]);
  });

  it('retries a lost CAS with the latest cursor, preserving concurrent leaves', async () => {
    mocks.limit.mockResolvedValueOnce([row({ root: event(1) })])
      .mockResolvedValueOnce([row({ root: event(3), other: event(2) })]);
    mocks.returning.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'alert-1' }]);
    expect(await advanceOpenCursors('alert-1', { root: event(2), added: event(1) })).toBe(true);
    expect(compile(mocks.set.mock.calls[1][0].context).params).toEqual([
      JSON.stringify({ root: event(3), other: event(2), added: event(1) }),
    ]);
  });

  it('stops after three failed CAS attempts', async () => {
    mocks.limit.mockResolvedValue([row({})]);
    mocks.returning.mockResolvedValue([]);
    expect(await advanceOpenCursors('alert-1', { root: event(1) })).toBe(false);
    expect(mocks.update).toHaveBeenCalledTimes(3);
    expect(mocks.select).toHaveBeenCalledTimes(3);
  });

  it('uses SQL NULL for an absent cursor and JSON null for a stored JSON null', async () => {
    mocks.limit.mockResolvedValueOnce([{ status: 'active', context: null }]).mockResolvedValueOnce([row(null)]);
    await advanceOpenCursors('alert-1', { root: event(1) });
    await advanceOpenCursors('alert-1', { root: event(1) });
    expect(compile(mocks.where.mock.calls[0][0]).sql).toContain('IS NOT DISTINCT FROM NULL');
    expect(compile(mocks.where.mock.calls[1][0]).params.at(-1)).toBe('null');
  });

  it('contextWithCursorSql preserves other context keys', () => {
    const query = compile(contextWithCursorSql({ root: event(1) }));
    expect(query.sql).toBe(`COALESCE("alerts"."context",'{}'::jsonb) || jsonb_build_object('lifecycle', COALESCE("alerts"."context"->'lifecycle','{}'::jsonb) || jsonb_build_object('cursor', $1::jsonb))`);
    expect(query.sql).not.toContain('jsonb_set');
    expect(query.params).toEqual([JSON.stringify({ root: event(1) })]);
  });

  it('freezeRecoveryCursor sets every trigger leaf to at least the newest recovery event', () => {
    expect(freezeRecoveryCursor({ '0': event(1), retained: event(4) }, ['0', '1'], { a: event(2), b: event(3) }))
      .toEqual({ '0': event(3), '1': event(3), retained: event(4) });
    expect(freezeRecoveryCursor({ root: event(1) }, ['root', 'missing'], {})).toEqual({ root: event(1) });
    expect(freezeRecoveryCursor({}, [], {})).toEqual({});
  });

  it('resolveSideCursors anchors every recovery leaf to the newest trigger cursor', () => {
    expect(resolveSideCursors({ '0': event(1), '1': event(3) }, ['a', 'b']))
      .toEqual({ a: event(3), b: event(3) });
    expect(resolveSideCursors({}, ['a'])).toEqual({});
    expect(resolveSideCursors({ root: event(1) }, [])).toEqual({});
  });
});
