import { describe, expect, it, vi } from 'vitest';

vi.mock('./redis', () => ({
  getRedis: vi.fn(),
  getRedisConnection: vi.fn(),
  createBlockingRedisConnection: vi.fn(),
}));
vi.mock('../db', () => ({ runOutsideDbContext: <T>(fn: () => T) => fn(), db: {} }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./eventDispatchQueue', () => ({
  enqueueRouteEvent: vi.fn(),
  recordShadowLocalInvocation: vi.fn(),
}));

import { EVENT_TYPES, type EventType } from './eventBus';

describe('Wisp W05 event types', () => {
  it('registers the three triage-engine events', () => {
    expect(EVENT_TYPES.AI_INTENT_DECIDED).toBe('ai.intent.decided');
    expect(EVENT_TYPES.AI_OPERATOR_TASK_FINISHED).toBe('ai.operator.task.finished');
    expect(EVENT_TYPES.TICKET_STALE).toBe('ticket.stale');
  });

  it('keeps the new literals assignable to EventType', () => {
    const types: EventType[] = [
      EVENT_TYPES.AI_INTENT_DECIDED,
      EVENT_TYPES.AI_OPERATOR_TASK_FINISHED,
      EVENT_TYPES.TICKET_STALE,
    ];
    expect(types).toHaveLength(3);
  });

  it('has no duplicate values', () => {
    const values = Object.values(EVENT_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });
});
