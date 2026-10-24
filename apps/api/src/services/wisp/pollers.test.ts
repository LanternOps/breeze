/**
 * Wisp W05 Task 8 — pollStaleTickets. `db.execute` is a recorder (the SQL is
 * rendered with PgDialect for assertions); the event bus and the flag are
 * mocked. The window arithmetic is asserted on the bound parameters and on the
 * pure `ticketStaleWindow` helper, since a mock cannot evaluate the predicate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  enabled: true,
  executes: [] as Array<{ query: unknown; inSystem: boolean }>,
  rows: [] as unknown[],
  state: { inSystem: false },
  publishEvent: vi.fn(async (..._a: unknown[]) => 'evt-1'),
  publishedInsideSystem: [] as boolean[],
  captureException: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      h.executes.push({ query, inSystem: h.state.inSystem });
      return h.rows;
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../eventBus', () => ({
  publishEvent: vi.fn(async (...a: unknown[]) => {
    h.publishedInsideSystem.push(h.state.inSystem);
    return h.publishEvent(...a);
  }),
}));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import {
  TICKET_STALE_DEFAULT_HOURS,
  TICKET_STALE_SCAN_WINDOW_MINUTES,
  pollStaleTickets,
  ticketStaleEventId,
  ticketStaleWindow,
} from './pollers';

const dialect = new PgDialect();
const NOW = new Date('2026-10-24T12:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const T1 = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';

function rendered() {
  const q = h.executes[0]!.query as Parameters<PgDialect['sqlToQuery']>[0];
  return dialect.sqlToQuery(q);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.executes = [];
  h.rows = [];
  h.publishedInsideSystem = [];
  h.state.inSystem = false;
  h.publishEvent.mockImplementation(async () => 'evt-1');
});

describe('constants', () => {
  it('defaults to 72h stale and a 5 minute scan window', () => {
    expect(TICKET_STALE_DEFAULT_HOURS).toBe(72);
    expect(TICKET_STALE_SCAN_WINDOW_MINUTES).toBe(5);
  });
});

describe('ticketStaleWindow', () => {
  const { lower, upper } = ticketStaleWindow(NOW, 72, 5);
  const inWindow = (updatedAt: number) => updatedAt > lower.getTime() && updatedAt <= upper.getTime();

  it('includes a ticket updated exactly stale hours ago', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR)).toBe(true);
  });
  it('excludes a ticket updated stale + window + 1 minute ago', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR - 6 * MIN)).toBe(false);
  });
  it('excludes a ticket updated stale - 1 minute ago (not stale yet)', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR + 1 * MIN)).toBe(false);
  });
  it('includes the whole sliding window just inside the lower edge', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR - 5 * MIN + 1)).toBe(true);
    expect(inWindow(NOW.getTime() - 72 * HOUR - 5 * MIN)).toBe(false);
  });
});

describe('ticketStaleEventId', () => {
  it('is a deterministic UUID the event bus accepts, distinct per ticket and threshold', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const a = ticketStaleEventId(T1, 72);
    expect(a).toMatch(re);
    expect(ticketStaleEventId(T1, 72)).toBe(a);
    expect(ticketStaleEventId(T1, 48)).not.toBe(a);
    expect(ticketStaleEventId('00000000-0000-4000-8000-0000000000a2', 72)).not.toBe(a);
  });
});

describe('pollStaleTickets', () => {
  it('returns zeros without touching the DB when Wisp is off', async () => {
    h.enabled = false;
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 0, published: 0 });
    expect(h.executes).toHaveLength(0);
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('queries the sliding window, open-ish statuses and the grant join in SQL, in system context', async () => {
    await pollStaleTickets(NOW);
    expect(h.executes).toHaveLength(1);
    expect(h.executes[0]!.inSystem).toBe(true);
    const { sql: text, params } = rendered();
    expect(text).toMatch(/FROM tickets/i);
    expect(text).toMatch(/status IN \('new', 'open', 'pending'\)/);
    expect(text).toMatch(/EXISTS/i);
    expect(text).toMatch(/wisp_grants/);
    expect(text).toMatch(/g\.status = 'active'/);
    expect(text).toMatch(/g\.partner_id = o\.partner_id/);
    expect(text).toMatch(/g\.org_id IS NULL OR g\.org_id = t\.org_id/);
    expect(text).toMatch(/LIMIT/i);
    const { lower, upper } = ticketStaleWindow(NOW, 72, 5);
    expect(params).toContain(lower.toISOString());
    expect(params).toContain(upper.toISOString());
    expect(params).toContain(500);
  });

  it('honours opts overrides for the window and limit', async () => {
    await pollStaleTickets(NOW, { staleHours: 24, windowMinutes: 10, limit: 50 });
    const { params } = rendered();
    const { lower, upper } = ticketStaleWindow(NOW, 24, 10);
    expect(params).toContain(lower.toISOString());
    expect(params).toContain(upper.toISOString());
    expect(params).toContain(50);
  });

  it('publishes ticket.stale per row after the DB block with a deterministic eventId', async () => {
    const updatedAt = new Date(NOW.getTime() - 72 * HOUR);
    h.rows = [{ id: T1, org_id: ORG, updated_at: updatedAt }];
    const res = await pollStaleTickets(NOW);
    expect(res).toEqual({ scanned: 1, published: 1 });
    expect(h.publishEvent).toHaveBeenCalledWith(
      'ticket.stale', ORG,
      { ticketId: T1, orgId: ORG, staleHours: 72, updatedAt: updatedAt.toISOString() },
      'wisp-pollers',
      { eventId: ticketStaleEventId(T1, 72), occurredAt: new Date(updatedAt.getTime() + 72 * HOUR).toISOString() },
    );
    expect(h.publishedInsideSystem).toEqual([false]);
  });

  it('treats timestamp-without-time-zone text from the driver as UTC', async () => {
    h.rows = [{ id: T1, org_id: ORG, updated_at: '2026-10-21 12:00:00' }];
    await pollStaleTickets(NOW);
    expect(h.publishEvent).toHaveBeenCalledWith(
      'ticket.stale', ORG,
      expect.objectContaining({ updatedAt: '2026-10-21T12:00:00.000Z' }),
      'wisp-pollers',
      expect.objectContaining({ occurredAt: '2026-10-24T12:00:00.000Z' }),
    );
  });

  it('counts a failed publish as scanned but not published and keeps going', async () => {
    h.rows = [
      { id: T1, org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) },
      { id: '00000000-0000-4000-8000-0000000000a2', org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) },
    ];
    h.publishEvent.mockImplementationOnce(async () => { throw new Error('redis down'); });
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 2, published: 1 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
