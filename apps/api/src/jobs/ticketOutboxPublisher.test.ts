import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, updateMock, publishEventMock, closeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  publishEventMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

// Real AsyncLocalStorage-backed context tracking — NOT a bare identity
// pass-through. Same #1105 regression pattern as intentOutboxPublisher.test.ts:
// an identity `withSystemDbAccessContext: fn => fn()` mock would make
// `hasDbAccessContext()` always report false and could never prove the
// publish loop runs outside a held DB context.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const contextStorage = new AsyncLocalStorage<true>();

  const hasDbAccessContext = (): boolean => contextStorage.getStore() !== undefined;

  const withSystemDbAccessContext = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (contextStorage.getStore()) return fn();
    return contextStorage.run(true, fn);
  };

  const runOutsideDbContext = <T>(fn: () => T): T => contextStorage.exit(fn);

  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
    hasDbAccessContext,
    withSystemDbAccessContext,
    runOutsideDbContext,
  };
});

vi.mock('../db/schema/ticketOutbox', () => ({
  ticketOutbox: {
    id: 'id',
    orgId: 'org_id',
    ticketId: 'ticket_id',
    eventType: 'event_type',
    payload: 'payload',
    createdAt: 'created_at',
    publishedAt: 'published_at',
    publishAttempts: 'publish_attempts',
  },
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { publishOutboxRows } from './ticketOutboxPublisher';
import { captureException } from '../services/sentry';
import * as dbModule from '../db';
import * as fs from 'node:fs';
import * as path from 'node:path';

function makeUpdateChain(returningValue: unknown = undefined) {
  const where = vi.fn(() => Promise.resolve(returningValue));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

function claimedRow(overrides: Partial<{
  id: number;
  org_id: string;
  ticket_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  publish_attempts: number;
}> = {}) {
  return {
    id: 1,
    org_id: 'org-1',
    ticket_id: 'ticket-1',
    event_type: 'ticket.created',
    payload: {},
    publish_attempts: 1,
    ...overrides,
  };
}

describe('ticketOutboxPublisher.publishOutboxRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    publishEventMock.mockResolvedValue('event-id-1');
    closeMock.mockResolvedValue(undefined);
  });

  it('publishes a claimed ticket.created row onto the eventBus, id-only payload, marks published', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // stuck scan
    executeMock.mockResolvedValueOnce({ rows: [claimedRow()] }); // claim

    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith(
      'ticket.created',
      'org-1',
      { ticketId: 'ticket-1' },
      'ticket-outbox-publisher',
    );

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('forwards row.payload id-only fields (commentId, assigneeId, from/to) alongside ticketId — never subject/description/resolutionNote/content', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [
        claimedRow({ id: 2, event_type: 'ticket.commented', payload: { commentId: 'c-1', isPublic: true } }),
      ],
    });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    await publishOutboxRows();

    const [, , payloadArg] = publishEventMock.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect(payloadArg).toEqual({ ticketId: 'ticket-1', commentId: 'c-1', isPublic: true });
    for (const forbidden of ['subject', 'description', 'resolutionNote', 'content']) {
      expect(payloadArg).not.toHaveProperty(forbidden);
    }
  });

  it('status_changed row forwards from/to enum labels only', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [
        claimedRow({ id: 3, event_type: 'ticket.status_changed', payload: { from: 'open', to: 'resolved' } }),
      ],
    });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    await publishOutboxRows();

    const [type, , payloadArg] = publishEventMock.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect(type).toBe('ticket.status_changed');
    expect(payloadArg).toEqual({ ticketId: 'ticket-1', from: 'open', to: 'resolved' });
  });

  it('drains an unmapped event type (ticket.updated) — marks published WITHOUT calling publishEvent', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [claimedRow({ id: 4, event_type: 'ticket.updated', payload: {} })],
    });
    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(publishEventMock).not.toHaveBeenCalled();
    // Still drained: the row is marked published even with no bus target.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('drains ticket.assigned and ticket.restored the same unmapped way', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({
      rows: [
        claimedRow({ id: 5, event_type: 'ticket.assigned', payload: { assigneeId: 'u-1' } }),
        claimedRow({ id: 6, event_type: 'ticket.restored', payload: {} }),
      ],
    });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 2, skipped: 0 });
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('skips rows with publish_attempts > 5: logs, captures, does not publish', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: 7, ticket_id: 'ticket-7', event_type: 'ticket.created', publish_attempts: 6 }],
    });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 0, skipped: 1 });
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = (captureException as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Error;
    expect(captured.message).toContain('ticket-7');
    expect(captured.message).toContain('6 publish attempts');
  });

  it('re-run does not double-publish already-published rows', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 8 })] });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    const first = await publishOutboxRows();
    expect(first.published).toBe(1);
    expect(publishEventMock).toHaveBeenCalledTimes(1);

    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const second = await publishOutboxRows();
    expect(second).toEqual({ published: 0, skipped: 0 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  it('leaves published_at unset and does not crash when publishEvent rejects', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 9 })] });
    publishEventMock.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 0, skipped: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  // #1105 regression: publishOutboxRows must release its DB access context
  // before calling publishEvent(). See intentOutboxPublisher.test.ts's
  // identical assertion for the full rationale.
  it('releases the DB access context before publishing — #1105', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 10 })] });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    let sawContextDuringPublish: boolean | undefined;
    publishEventMock.mockImplementation(async () => {
      sawContextDuringPublish = dbModule.hasDbAccessContext();
      return 'event-id';
    });

    const result = await publishOutboxRows();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(sawContextDuringPublish).toBe(false);
    expect(dbModule.hasDbAccessContext()).toBe(false);
  });
});

// #3828 wave-6-3 task 2 plan bullet: "comment payloads id-only asserted by
// test (no subject/description/content field ever on the bus — regression
// test greps the publish sites' payload types)". The runtime tests above
// prove the actual behavior; this is the literal source-level guard the plan
// calls for — the publisher's payload-construction site must never even
// reference these identifiers, so a future edit that starts threading ticket
// free-text through this file fails here before it fails anywhere else.
describe('ticketOutboxPublisher — source-level id-only guard', () => {
  it('never references subject/description/resolutionNote/content in its payload construction', () => {
    const src = fs.readFileSync(path.join(__dirname, 'ticketOutboxPublisher.ts'), 'utf8');
    for (const forbidden of ['.subject', '.description', '.resolutionNote', 'row.content', 'comment.content']) {
      expect(src).not.toContain(forbidden);
    }
  });
});

// #3828 wave-6-3 review follow-up: `ticket_outbox_unpublished_idx` is keyed
// on (published_at, id) — see the migration
// (2026-09-19-ai-agents-ticket-shadow.sql)'s comment on that index, which
// says the claim "orders by id". Both the stuck-scan and the FOR UPDATE SKIP
// LOCKED claim CTE must actually order by `id` (bigserial, monotonic) to
// match that index and to give a stable walk order across repeated polling
// passes — ordering by `created_at` instead (same-millisecond inserts are not
// distinguishable, and it does not match the index at all) is the bug this
// guards against. A literal source grep, not a mocked-`db.execute` call-arg
// assertion, because `scanAndClaimOutboxRows`'s two statements are raw `sql`
// template literals (`db.execute(sql\`...\`)`), not a Drizzle query-builder
// chain — there is no `.where()`/`.orderBy()` call to intercept, only a
// compiled string, and the string IS the source text below.
describe('ticketOutboxPublisher — claim order matches the (published_at, id) index', () => {
  it('orders both the stuck scan and the claim CTE by id, never created_at', () => {
    const src = fs.readFileSync(path.join(__dirname, 'ticketOutboxPublisher.ts'), 'utf8');
    const orderByClauses = [...src.matchAll(/ORDER BY \$\{[^}]+\}/g)].map((m) => m[0]);
    expect(orderByClauses.length).toBe(2);
    for (const clause of orderByClauses) {
      expect(clause).toContain('ticketOutbox.id');
      expect(clause).not.toContain('createdAt');
    }
    expect(src).not.toContain('ORDER BY ${ticketOutbox.createdAt}');
  });
});
