import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
  onConflictDoNothingMock: vi.fn(),
  returningMock: vi.fn(),
  runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: {
    insert: dbMocks.insertMock,
  },
  runOutsideDbContext: dbMocks.runOutsideDbContextMock,
  withSystemDbAccessContext: dbMocks.withSystemDbAccessContextMock,
}));

import {
  emitMlFeedbackEvent,
  emitMlFeedbackEvents,
  emitSystemMlFeedbackEvent,
} from './mlFeedback';

const validEvent = {
  orgId: '00000000-0000-4000-8000-000000000001',
  sourceType: 'alert',
  sourceId: '00000000-0000-4000-8000-000000000002',
  eventType: 'alert.acknowledged',
  actorUserId: '00000000-0000-4000-8000-000000000003',
  outcome: 'acknowledged',
  confidence: 0.9,
  metadata: { route: 'alerts.acknowledge' },
  occurredAt: new Date('2026-06-18T12:00:00.000Z'),
} as const;

describe('mlFeedback service', () => {
  beforeEach(() => {
    dbMocks.insertMock.mockReset();
    dbMocks.valuesMock.mockReset();
    dbMocks.onConflictDoNothingMock.mockReset();
    dbMocks.returningMock.mockReset();
    dbMocks.runOutsideDbContextMock.mockClear();
    dbMocks.withSystemDbAccessContextMock.mockClear();

    dbMocks.insertMock.mockReturnValue({ values: dbMocks.valuesMock });
    dbMocks.valuesMock.mockReturnValue({ onConflictDoNothing: dbMocks.onConflictDoNothingMock });
    dbMocks.onConflictDoNothingMock.mockReturnValue({ returning: dbMocks.returningMock });
  });

  it('inserts a valid feedback event with replay-safe dedupe semantics', async () => {
    dbMocks.returningMock.mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000010' }]);

    const result = await emitMlFeedbackEvent(validEvent);

    expect(result).toEqual({ id: '00000000-0000-4000-8000-000000000010', inserted: true });
    expect(dbMocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: validEvent.orgId,
      sourceType: 'alert',
      eventType: 'alert.acknowledged',
      dedupeKey: null,
      actorUserId: validEvent.actorUserId,
      confidence: 0.9,
      metadata: { route: 'alerts.acknowledge' },
    }));
    const conflictTarget = dbMocks.onConflictDoNothingMock.mock.calls[0]?.[0]?.target;
    expect(conflictTarget).toHaveLength(4);
  });

  it('returns inserted=false when the dedupe constraint absorbs a replay', async () => {
    dbMocks.returningMock.mockResolvedValue([]);

    const result = await emitMlFeedbackEvent(validEvent);

    expect(result).toEqual({ id: null, inserted: false });
    expect(dbMocks.onConflictDoNothingMock).toHaveBeenCalledTimes(1);
  });

  it('uses a semantic dedupe key when the emitter provides one', async () => {
    dbMocks.returningMock.mockResolvedValue([]);

    const result = await emitMlFeedbackEvent({
      ...validEvent,
      dedupeKey: 'ack:user-action-123',
      occurredAt: new Date('2026-06-18T12:01:00.000Z'),
    });

    expect(result).toEqual({ id: null, inserted: false });
    expect(dbMocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'ack:user-action-123',
      occurredAt: new Date('2026-06-18T12:01:00.000Z'),
    }));
    const conflictConfig = dbMocks.onConflictDoNothingMock.mock.calls[0]?.[0];
    expect(conflictConfig?.target).toHaveLength(5);
    expect(conflictConfig?.where).toBeDefined();
  });

  it('rejects oversized metadata before issuing a database write', async () => {
    await expect(emitMlFeedbackEvent({
      ...validEvent,
      metadata: { notes: 'x'.repeat(9000) },
    })).rejects.toThrow(/metadata/i);

    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('wraps system emission in runOutsideDbContext and withSystemDbAccessContext', async () => {
    dbMocks.returningMock.mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000011' }]);

    await emitSystemMlFeedbackEvent({ ...validEvent, actorUserId: null });

    expect(dbMocks.runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(dbMocks.withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  describe('emitMlFeedbackEvents (batch, W02)', () => {
    const member = (i: number) => ({
      orgId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'anomaly' as const,
      sourceId: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
      eventType: 'anomaly.dismissed' as const,
      dedupeKey: 'episode:00000000-0000-4000-8000-000000000099',
      outcome: 'dismissed' as const,
      metadata: { episodeId: '00000000-0000-4000-8000-000000000099' },
      occurredAt: new Date('2026-09-22T00:00:00.000Z'),
    });

    it('inserts every event in one statement against the semantic dedupe target', async () => {
      dbMocks.returningMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

      const result = await emitMlFeedbackEvents([member(1), member(2), member(3)]);

      expect(result).toEqual({ inserted: 3 });
      expect(dbMocks.insertMock).toHaveBeenCalledTimes(1);
      const inserted = dbMocks.valuesMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(inserted).toHaveLength(3);
      expect(inserted.map((r) => r.sourceId)).toEqual([member(1).sourceId, member(2).sourceId, member(3).sourceId]);
      const conflict = dbMocks.onConflictDoNothingMock.mock.calls[0]![0] as { target: unknown[]; where: unknown };
      expect(conflict.target).toHaveLength(5);
      expect(conflict.where).toBeDefined();
    });

    it('refuses an event without a dedupeKey and writes nothing', async () => {
      const { dedupeKey: _omit, ...noKey } = member(1);
      await expect(emitMlFeedbackEvents([member(2), noKey])).rejects.toThrow(/dedupeKey/);
      expect(dbMocks.insertMock).not.toHaveBeenCalled();
    });

    it('chunks at 500 rows', async () => {
      dbMocks.returningMock.mockResolvedValueOnce(new Array(500).fill({ id: 'x' }));
      dbMocks.returningMock.mockResolvedValueOnce([{ id: 'y' }]);
      const result = await emitMlFeedbackEvents(Array.from({ length: 501 }, (_, i) => member(i)));
      expect(dbMocks.insertMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ inserted: 501 });
    });

    it('is a no-op for an empty list', async () => {
      expect(await emitMlFeedbackEvents([])).toEqual({ inserted: 0 });
      expect(dbMocks.insertMock).not.toHaveBeenCalled();
    });

    it('propagates insert failures (never best-effort)', async () => {
      dbMocks.returningMock.mockRejectedValue(new Error('connection lost'));
      await expect(emitMlFeedbackEvents([member(1)])).rejects.toThrow('connection lost');
    });
  });
});
