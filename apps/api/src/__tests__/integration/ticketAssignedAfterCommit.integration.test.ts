/**
 * #7963: the `ticket.assigned` notify job must not be queued until the
 * assignment has committed, and a rolled-back assignment must queue nothing.
 *
 * Before the fix, assignTicket queued the job from inside the request
 * transaction. A worker that won the race read the ticket's PRE-commit
 * assignee, took the "reassigned since" branch and completed without
 * notifying — and nothing retried it. The job is now queued by
 * ticketOutboxPublisher from the committed `ticket_outbox` row.
 *
 * The queue is replaced by an in-memory recorder (both the strict and the
 * fire-and-forget entry points), so "queued" is observable without Redis. The
 * publisher runs on its own pooled connection (`runOutsideDbContext`), so
 * running it while the assignment transaction is still open shows exactly
 * what a concurrent publisher pass would see.
 *
 * Prerequisites: a live test database (`pnpm test-stack up`).
 */
import './setup';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

type QueuedEvent = { type: string; ticketId: string; [k: string]: unknown };
const queued = vi.hoisted(() => [] as QueuedEvent[]);
vi.mock('../../services/ticketEvents', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketEvents')>();
  const record = async (event: QueuedEvent) => {
    queued.push(event);
  };
  return { ...actual, emitTicketEvent: record, enqueueTicketEvent: record };
});
vi.mock('../../services/apns', async (orig) => ({
  ...(await orig<typeof import('../../services/apns')>()),
  isApnsConfigured: () => false,
}));
vi.mock('../../services/expoPush', async (orig) => ({
  ...(await orig<typeof import('../../services/expoPush')>()),
  dispatchPushToTokens: vi.fn(async () => ({ tokensFound: 0, dispatched: 0, errors: 0 })),
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { tickets, userNotifications } from '../../db/schema';
import { publishOutboxRows } from '../../jobs/ticketOutboxPublisher';
import { handleTicketEvent } from '../../jobs/ticketNotifyWorker';
import { assignTicket } from '../../services/ticketService';
import type { TicketEvent } from '../../services/ticketEvents';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

async function makeTech(partnerId: string) {
  const user = await createUser({ partnerId, orgId: null, email: `${uniq('assign')}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [{ resource: 'tickets', action: 'read' }]);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user;
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const actor = await makeTech(partner.id);
  const previous = await makeTech(partner.id);
  const assignee = await makeTech(partner.id);
  const [ticket] = await withSystemDbAccessContext(() =>
    db
      .insert(tickets)
      .values({
        orgId: org.id,
        partnerId: partner.id,
        ticketNumber: uniq('TKT'),
        internalNumber: uniq('T'),
        subject: 'Printer',
        status: 'open',
        assignedTo: previous.id,
      })
      .returning());
  // Mirrors authMiddleware for a partner-scope technician.
  const context: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId: actor.id,
  };
  return { partner, org, actor, previous, assignee, ticket: ticket!, context };
}

const assignedFor = (ticketId: string) =>
  queued.filter((e) => e.type === 'ticket.assigned' && e.ticketId === ticketId);

// A publisher pass on its own connection, exactly as the repeatable job runs it.
const publishFromOutside = () => runOutsideDbContext(() => publishOutboxRows());

describe('ticket.assigned is queued only after the assignment commits (#7963)', () => {
  beforeEach(() => {
    queued.length = 0;
  });

  runDb('queues nothing while the assignment transaction is open, then exactly one job after commit', async () => {
    const fx = await seed();

    await withDbAccessContext(fx.context, async () => {
      await assignTicket(fx.ticket.id, fx.assignee.id, { kind: 'user', userId: fx.actor.id });
      // The assignment is not committed yet: nothing may be queued for it,
      // neither by assignTicket itself nor by a concurrent publisher pass.
      await publishFromOutside();
      expect(assignedFor(fx.ticket.id)).toEqual([]);
    });

    await publishFromOutside();
    const jobs = assignedFor(fx.ticket.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'ticket.assigned',
      ticketId: fx.ticket.id,
      orgId: fx.org.id,
      partnerId: fx.partner.id,
      actorUserId: fx.actor.id,
      actorPrincipalId: null,
      payload: { assigneeId: fx.assignee.id },
    });
    expect(jobs[0]!.eventId).toMatch(/^ticket-outbox-\d+$/);

    // A second pass finds the row already published: no duplicate job.
    await publishFromOutside();
    expect(assignedFor(fx.ticket.id)).toHaveLength(1);

    // End to end: the queued job now notifies the assignee, because the worker
    // can only ever read the committed assignment.
    await handleTicketEvent(jobs[0] as unknown as TicketEvent);
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ userId: userNotifications.userId, dedupeKey: userNotifications.dedupeKey })
        .from(userNotifications)
        .where(eq(userNotifications.userId, fx.assignee.id)));
    expect(rows).toEqual([
      {
        userId: fx.assignee.id,
        dedupeKey: `ticket:${fx.ticket.id}:assigned:${fx.assignee.id}:${jobs[0]!.eventId}`,
      },
    ]);
  });

  runDb('a rolled-back assignment queues nothing', async () => {
    const fx = await seed();

    await expect(
      withDbAccessContext(fx.context, async () => {
        await assignTicket(fx.ticket.id, fx.assignee.id, { kind: 'user', userId: fx.actor.id });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    await publishFromOutside();
    expect(assignedFor(fx.ticket.id)).toEqual([]);

    // Positive control: the assignment really was rolled back.
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ assignedTo: tickets.assignedTo }).from(tickets).where(eq(tickets.id, fx.ticket.id)));
    expect(row?.assignedTo).toBe(fx.previous.id);
  });
});
