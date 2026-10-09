/**
 * #7963's rule, applied to creates: the `ticket.created` notify job must not be
 * queued until the ticket has committed, and a rolled-back create must queue
 * nothing.
 *
 * Before the fix, createTicket queued the job from inside the request
 * transaction, so a create that rolled back afterwards still notified the
 * assignee of a ticket that never existed. The Partner API made that reachable
 * from an API caller: a `409 EXTERNAL_ID_CONFLICT` rolls the create back after
 * createTicket returns. The job is now queued by ticketOutboxPublisher from the
 * committed `ticket_outbox` row.
 *
 * Same harness as ticketAssignedAfterCommit.integration.test.ts: the queue is
 * an in-memory recorder (both entry points), and the publisher runs on its own
 * pooled connection, so a pass made while the create is still open shows what
 * a concurrent publisher would see.
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
import { createTicket } from '../../services/ticketService';
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
  const user = await createUser({ partnerId, orgId: null, email: `${uniq('create')}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [{ resource: 'tickets', action: 'read' }]);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user;
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const actor = await makeTech(partner.id);
  const assignee = await makeTech(partner.id);
  // Mirrors authMiddleware for a partner-scope technician.
  const context: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId: actor.id,
  };
  return { partner, org, actor, assignee, context };
}

const createdFor = (orgId: string) =>
  queued.filter((e) => e.type === 'ticket.created' && e.orgId === orgId);

// A publisher pass on its own connection, exactly as the repeatable job runs it.
const publishFromOutside = () => runOutsideDbContext(() => publishOutboxRows());

describe('ticket.created is queued only after the create commits', () => {
  beforeEach(() => {
    queued.length = 0;
  });

  runDb('queues nothing while the create transaction is open, then exactly one job after commit', async () => {
    const fx = await seed();

    const ticket = await withDbAccessContext(fx.context, async () => {
      const created = await createTicket(
        { orgId: fx.org.id, subject: 'Printer', source: 'manual', assigneeId: fx.assignee.id },
        { kind: 'user', userId: fx.actor.id },
      );
      // Not committed yet: nothing may be queued for it, neither by
      // createTicket itself nor by a concurrent publisher pass.
      await publishFromOutside();
      expect(createdFor(fx.org.id)).toEqual([]);
      return created;
    });

    await publishFromOutside();
    const jobs = createdFor(fx.org.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'ticket.created',
      ticketId: ticket.id,
      orgId: fx.org.id,
      partnerId: fx.partner.id,
      actorUserId: fx.actor.id,
      actorPrincipalId: null,
      payload: { internalNumber: ticket.internalNumber, assigneeId: fx.assignee.id, source: 'manual' },
    });
    expect(jobs[0]!.eventId).toMatch(/^ticket-outbox-\d+$/);

    // A second pass finds the row already published: no duplicate job.
    await publishFromOutside();
    expect(createdFor(fx.org.id)).toHaveLength(1);

    // End to end: the job notifies the assignee once, and a re-queue of the
    // same row (same deterministic eventId) does not notify again.
    await handleTicketEvent(jobs[0] as unknown as TicketEvent);
    await handleTicketEvent({ ...jobs[0] } as unknown as TicketEvent);
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ userId: userNotifications.userId, dedupeKey: userNotifications.dedupeKey })
        .from(userNotifications)
        .where(eq(userNotifications.userId, fx.assignee.id)));
    expect(rows).toEqual([
      {
        userId: fx.assignee.id,
        dedupeKey: `ticket:${ticket.id}:assigned:${fx.assignee.id}:${jobs[0]!.eventId}`,
      },
    ]);
  });

  runDb('a rolled-back create queues nothing', async () => {
    const fx = await seed();
    const subject = uniq('rolled-back create');

    await expect(
      withDbAccessContext(fx.context, async () => {
        await createTicket(
          { orgId: fx.org.id, subject, source: 'manual', assigneeId: fx.assignee.id },
          { kind: 'user', userId: fx.actor.id },
        );
        // What a Partner API 409 EXTERNAL_ID_CONFLICT does after createTicket returns.
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    await publishFromOutside();
    expect(createdFor(fx.org.id)).toEqual([]);

    // Positive control: the ticket really was rolled back.
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: tickets.id }).from(tickets).where(eq(tickets.subject, subject)));
    expect(rows).toEqual([]);
  });
});
