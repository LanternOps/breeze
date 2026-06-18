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
});
