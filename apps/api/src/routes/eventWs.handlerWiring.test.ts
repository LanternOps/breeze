/**
 * Handler-level wiring guard for the delivery filter.
 *
 * eventWs.deliveryFilter.test.ts proves `buildDeliveryFilter` is correct as a
 * pure function — but nothing there pins the ONE line that wires it into the
 * connection handler (`filter: buildDeliveryFilter(...)` in
 * createEventWsHandlers' onOpen). Reverting that line to the pre-wave-2
 * `buildSiteFilter` would re-open an org-wide delivery of ADDRESSED events —
 * every user's socket in the org would receive every other user's
 * notification nudge — with every pure-function suite still green.
 *
 * So this test goes through the real seam end to end: a client registered by
 * the REAL createEventWsHandlers onOpen path (mocked db/auth, as in
 * eventWs.test.ts) into the REAL EventDispatcher (mocked ioredis, as in
 * eventDispatcher.test.ts), and events pushed through the dispatcher's real
 * dispatch loop — which consults the exact `client.filter` the handler built.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — the DB/auth surface is mocked exactly like eventWs.test.ts;
// the event dispatcher is deliberately REAL (only ioredis is mocked).
// -------------------------------------------------------------------

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => null),
  resolveRedisUrl: vi.fn(() => 'redis://localhost:6379'),
}));

vi.mock('ioredis', () => {
  class MockRedis {
    subscribe = vi.fn((_channel: string, cb: (err: Error | null) => void) => cb(null));
    unsubscribe = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
  }
  return { default: MockRedis };
});

const schemaTables = vi.hoisted(() => ({
  users: { table: 'users' },
  organizationUsers: { table: 'organizationUsers' },
  partnerUsers: { table: 'partnerUsers' },
  organizations: { table: 'organizations' },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === schemaTables.users) {
              return [{ status: 'active', permissionsEpoch: 7, partnerId: 'partner-1', orgId: 'org-1' }];
            }
            if (table === schemaTables.organizationUsers) {
              // siteIds null => the connection is NOT site-restricted, so any
              // leak below is attributable to audience targeting alone.
              return [{ roleId: 'org-role-1', siteIds: null }];
            }
            if (table === schemaTables.partnerUsers) {
              return [{ roleId: 'partner-role-1', orgAccess: 'all', orgIds: null }];
            }
            if (table === schemaTables.organizations) return [{ id: 'org-1' }];
            return [];
          }),
        })),
      })),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({ ...schemaTables }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => { await next(); }),
  resolveOrgAccess: vi.fn(async () => ({ type: 'single', orgId: 'org-1' })),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------

import { createEventWsTicket, createEventWsHandlers, _clearTicketStore } from './eventWs';
import { getEventDispatcher, shutdownEventDispatcher } from '../services/eventDispatcher';

const BOB = 'user-bob';
const ALICE = 'user-alice';

function makeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

/** Parse every frame sent to the socket and keep only dispatched events. */
function eventFrames(ws: ReturnType<typeof makeWs>): Array<Record<string, unknown>> {
  return ws.send.mock.calls
    .map(([raw]: [string]) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame: Record<string, unknown>) => frame.type === 'event');
}

const addressedTo = (userId: string) => JSON.stringify({
  type: 'notification.created',
  orgId: 'org-1',
  audienceUserId: userId,
  payload: { notificationId: 'n1' },
});

describe('createEventWsHandlers wires buildDeliveryFilter into the registered client', () => {
  beforeEach(() => {
    _clearTicketStore();
  });

  afterEach(async () => {
    await shutdownEventDispatcher();
  });

  it("drops another user's addressed notification but delivers Bob's own", async () => {
    const ws = makeWs();
    const { ticket } = await createEventWsTicket(BOB, 'org-1');
    const handlers = createEventWsHandlers(ticket, { jitterMs: () => 0 });
    await handlers.onOpen(undefined, ws);

    // Subscribe Bob to notification events through the real message path.
    handlers.onMessage(
      { data: JSON.stringify({ action: 'subscribe', types: ['notification.*'] }) } as MessageEvent,
      ws,
    );
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"subscribed"'));

    const dispatcher = getEventDispatcher();

    // THE GUARD: an event addressed to Alice fans out to org-1, where Bob is
    // registered — the client.filter built in onOpen must drop it. With the
    // wiring reverted to buildSiteFilter this frame IS delivered (an
    // unrestricted user passes the site filter for every event).
    (dispatcher as any).dispatch('org-1', addressedTo(ALICE));
    expect(eventFrames(ws)).toHaveLength(0);

    // And the same pipeline still delivers Bob's own notification — proving
    // the drop above was targeting, not a dead subscription.
    (dispatcher as any).dispatch('org-1', addressedTo(BOB));
    const delivered = eventFrames(ws);
    expect(delivered).toHaveLength(1);
    expect((delivered[0]!.data as Record<string, unknown>).audienceUserId).toBe(BOB);

    handlers.onClose(undefined, ws);
  });
});
