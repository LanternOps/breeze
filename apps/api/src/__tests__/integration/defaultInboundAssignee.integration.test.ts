/**
 * Partner default inbound assignee (settings.ticketing.inbound.defaultAssigneeUserId)
 * against real Postgres.
 *
 *  - Save-time predicate (isAssignableInboundDefaultUser): an active member of
 *    THIS partner whose role grants tickets:read. Each negative user below
 *    fails on exactly one predicate; the other partner's user is a positive
 *    control for its own partner, so its refusal here is the partner boundary.
 *  - Ingest: a new inbound ticket is assigned in the pipeline's transaction,
 *    and its `ticket.assigned` job is queued by ticketOutboxPublisher only
 *    after that transaction commits (#8040); a rollback queues nothing. A reply
 *    never changes an existing assignment, and a user who cannot own the ticket
 *    (another partner's, disabled, or without access to its org) leaves it
 *    unassigned with the reason in the inbound log.
 *
 * The queue is replaced by an in-memory recorder (as in
 * ticketAssignedAfterCommit.integration.test.ts), so "queued" is observable
 * without Redis.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { gmail_v1 } from '@googleapis/gmail';

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
vi.mock('../../services/inboundEmail/autoresponder', () => ({ maybeSendAutoresponse: vi.fn() }));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  customerEmailDomains,
  partnerUsers,
  partners,
  ticketEmailInbound,
  ticketMailboxConnections,
  tickets,
  userNotifications,
} from '../../db/schema';
import { publishOutboxRows } from '../../jobs/ticketOutboxPublisher';
import { handleTicketEvent } from '../../jobs/ticketNotifyWorker';
import { assignTicket } from '../../services/ticketService';
import type { TicketEvent } from '../../services/ticketEvents';
import {
  defaultAssigneeSettingsError,
  isAssignableInboundDefaultUser,
  listAssignableInboundDefaultUsers,
} from '../../services/inboundEmail/defaultAssigneeEligibility';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import { normalizeGmailMessage } from '../../services/ticketMailbox/normalizeGmailMessage';
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

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function message(id: string, from: string, mailbox: string, inReplyTo?: string): gmail_v1.Schema$Message {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: mailbox },
    { name: 'Subject', value: inReplyTo ? 'Re: Printer down' : 'Printer down' },
    { name: 'Message-ID', value: `<${id}@client.test>` },
    { name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
  ];
  if (inReplyTo) headers.push({ name: 'In-Reply-To', value: inReplyTo });
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.now()),
    labelIds: ['INBOX'],
    snippet: 'printer',
    payload: { mimeType: 'text/plain', headers, body: { data: b64url('Our printer stopped working.') } },
  };
}

async function seed() {
  const suffix = uniq('da');
  const clientDomain = `client-${suffix}.test`;
  const mailbox = `help-${suffix}@example.test`;
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const clientOrg = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    await db.insert(customerEmailDomains).values({
      partnerId: partner.id, orgId: clientOrg.id, domain: clientDomain, autoCreateContact: false, isActive: true,
    });
    const ticketRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(ticketRole.id, [{ resource: 'tickets', action: 'read' }]);
    const noTicketRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(noTicketRole.id, [{ resource: 'devices', action: 'read' }]);
    const otherRole = await createRole({ scope: 'partner', partnerId: otherPartner.id });
    await grantRolePermissions(otherRole.id, [{ resource: 'tickets', action: 'read' }]);

    const user = (partnerId: string, status: 'active' | 'disabled' = 'active') =>
      createUser({ partnerId, orgId: null, email: `${uniq('u')}@msp.test`, status });
    const member = async (
      u: { id: string },
      opts: { partnerId?: string; roleId?: string; access?: 'all' | 'selected' | 'none'; orgIds?: string[] } = {},
    ) => {
      const a = await assignUserToPartner(u.id, opts.partnerId ?? partner.id, opts.roleId ?? ticketRole.id, opts.access ?? 'all');
      if (opts.orgIds) await db.update(partnerUsers).set({ orgIds: opts.orgIds }).where(eq(partnerUsers.id, a.id));
    };

    const tech = await user(partner.id); await member(tech);
    const otherTech = await user(partner.id); await member(otherTech);
    const disabled = await user(partner.id, 'disabled'); await member(disabled);
    const noMember = await user(partner.id);
    const noAccess = await user(partner.id); await member(noAccess, { access: 'none' });
    const noTicketPerm = await user(partner.id); await member(noTicketPerm, { roleId: noTicketRole.id });
    const scopedOut = await user(partner.id); await member(scopedOut, { access: 'selected', orgIds: [otherOrg.id] });
    const foreign = await user(otherPartner.id); await member(foreign, { partnerId: otherPartner.id, roleId: otherRole.id });
    // Another partner's user who ALSO holds a membership row in this partner, so
    // only the users.partner_id predicate can refuse them.
    const foreignLinked = await user(otherPartner.id); await member(foreignLinked);

    const [connection] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id,
      provider: 'gmail',
      orgId: clientOrg.id,
      googleAccountSub: `sub-${suffix}`,
      mailboxAddress: mailbox,
      status: 'connected',
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });

    return {
      partnerId: partner.id, otherPartnerId: otherPartner.id, clientOrgId: clientOrg.id, clientDomain, mailbox,
      connection: connection!,
      users: { tech, otherTech, disabled, noMember, noAccess, noTicketPerm, scopedOut, foreign, foreignLinked },
    };
  });
}
type Fx = Awaited<ReturnType<typeof seed>>;

async function setDefaultAssignee(partnerId: string, userId: string | null) {
  await withSystemDbAccessContext(() => db.update(partners)
    .set({ settings: { ticketing: { inbound: { defaultAssigneeUserId: userId } } } })
    .where(eq(partners.id, partnerId)));
}

function normalized(fx: Fx, id: string, inReplyTo?: string) {
  return normalizeGmailMessage(message(id, `Jane Client <jane@${fx.clientDomain}>`, fx.mailbox, inReplyTo), fx.partnerId, fx.mailbox, 'sub-x');
}

function ingestIn(fx: Fx, n: ReturnType<typeof normalized>) {
  return processInboundEmail(n, {
    provider: 'gmail',
    connectionId: fx.connection.id,
    partnerId: fx.partnerId,
    tenantId: null,
    consentAttemptId: fx.connection.consentAttemptId,
  });
}

async function inboundRow(fx: Fx, providerMessageId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ ticketId: ticketEmailInbound.ticketId, status: ticketEmailInbound.parseStatus, note: ticketEmailInbound.error })
    .from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.partnerId, fx.partnerId), eq(ticketEmailInbound.providerMessageId, providerMessageId))));
  return row!;
}

async function ticketRow(ticketId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ assignedTo: tickets.assignedTo, status: tickets.status, emailThreadKey: tickets.emailThreadKey })
    .from(tickets).where(eq(tickets.id, ticketId)));
  return row!;
}

const publishFromOutside = () => runOutsideDbContext(() => publishOutboxRows());
const assignedFor = (ticketId: string) => queued.filter((e) => e.type === 'ticket.assigned' && e.ticketId === ticketId);

describe('default inbound assignee (real DB)', () => {
  beforeEach(() => {
    queued.length = 0;
  });

  runDb('save check: only an active member of this partner with ticket access is assignable', async () => {
    const fx = await seed();
    const check = (userId: string, partnerId = fx.partnerId) =>
      withSystemDbAccessContext(() => isAssignableInboundDefaultUser(userId, partnerId));
    const u = fx.users;

    expect(await check(u.tech.id)).toBe(true);
    // Selected access to some org is still a partner member who can be assigned
    // tickets; per-org eligibility is checked at ingest.
    expect(await check(u.scopedOut.id)).toBe(true);
    expect(await check(u.disabled.id)).toBe(false);
    expect(await check(u.noMember.id)).toBe(false);
    expect(await check(u.noAccess.id)).toBe(false);
    expect(await check(u.noTicketPerm.id)).toBe(false);
    // Cross-partner: assignable for its own partner, never for this one, even
    // under a system DB context where RLS hides nothing.
    expect(await check(u.foreign.id, fx.otherPartnerId)).toBe(true);
    expect(await check(u.foreign.id)).toBe(false);
    expect(await check(u.foreignLinked.id)).toBe(false);
  });

  runDb('the picker lists exactly the users the save accepts', async () => {
    const fx = await seed();
    const u = fx.users;
    const listed = await withSystemDbAccessContext(() => listAssignableInboundDefaultUsers(fx.partnerId));
    expect(listed.map((r) => r.id).sort()).toEqual([u.tech.id, u.otherTech.id, u.scopedOut.id].sort());
  });

  runDb('system partner writes: a changed value must be assignable for that partner', async () => {
    const fx = await seed();
    const u = fx.users;
    const err = (userId: unknown, current: string | null, partnerId: string | null = fx.partnerId) =>
      withSystemDbAccessContext(() => defaultAssigneeSettingsError(
        { ticketing: { inbound: { defaultAssigneeUserId: userId } } }, current, partnerId));

    expect(await err(u.tech.id, null)).toBeNull();
    expect(await err(null, u.tech.id)).toBeNull();
    // Unchanged is not re-checked, even for a user who no longer qualifies.
    expect(await err(u.disabled.id, u.disabled.id)).toBeNull();
    expect(await err(u.disabled.id, null)).toMatch(/active member/);
    expect(await err(u.foreign.id, null)).toMatch(/active member/);
    expect(await err(u.foreignLinked.id, null)).toMatch(/active member/);
    expect(await err('bob', null)).toMatch(/user id/);
    // A partner being created has no members.
    expect(await err(u.tech.id, null, null)).toMatch(/active member/);
  });

  runDb('ingest assigns a new ticket and queues ticket.assigned only after the ingest commits', async () => {
    const fx = await seed();
    await setDefaultAssignee(fx.partnerId, fx.users.tech.id);
    const n = normalized(fx, uniq('new'));

    await withSystemDbAccessContext(async () => {
      await ingestIn(fx, n);
      // Not committed yet: a concurrent publisher pass sees no row.
      await publishFromOutside();
      expect(queued.filter((e) => e.type === 'ticket.assigned')).toEqual([]);
    });

    const inbound = await inboundRow(fx, n.providerMessageId);
    expect(inbound.status).toBe('created');
    const ticket = await ticketRow(inbound.ticketId!);
    expect(ticket.assignedTo).toBe(fx.users.tech.id);
    expect(ticket.status).toBe('open');

    await publishFromOutside();
    const jobs = assignedFor(inbound.ticketId!);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ partnerId: fx.partnerId, actorUserId: null, payload: { assigneeId: fx.users.tech.id } });

    // End to end: the job notifies the default assignee.
    await handleTicketEvent(jobs[0] as unknown as TicketEvent);
    const notes = await withSystemDbAccessContext(() => db
      .select({ dedupeKey: userNotifications.dedupeKey }).from(userNotifications)
      .where(eq(userNotifications.userId, fx.users.tech.id)));
    expect(notes.map((r) => r.dedupeKey)).toEqual([
      `ticket:${inbound.ticketId}:assigned:${fx.users.tech.id}:${jobs[0]!.eventId}`,
    ]);
  });

  runDb('a rolled-back ingest leaves no ticket and queues no assignment', async () => {
    const fx = await seed();
    await setDefaultAssignee(fx.partnerId, fx.users.tech.id);
    const n = normalized(fx, uniq('rollback'));

    await expect(withSystemDbAccessContext(async () => {
      await ingestIn(fx, n);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    await publishFromOutside();
    expect(queued.filter((e) => e.type === 'ticket.assigned')).toEqual([]);
    const rows = await withSystemDbAccessContext(() => db.select({ id: ticketEmailInbound.id }).from(ticketEmailInbound)
      .where(eq(ticketEmailInbound.providerMessageId, n.providerMessageId)));
    expect(rows).toEqual([]);
  });

  runDb('a reply never overrides the assignment a person made', async () => {
    const fx = await seed();
    await setDefaultAssignee(fx.partnerId, fx.users.tech.id);
    const first = normalized(fx, uniq('first'));
    await withSystemDbAccessContext(() => ingestIn(fx, first));
    const ticketId = (await inboundRow(fx, first.providerMessageId)).ticketId!;
    expect((await ticketRow(ticketId)).assignedTo).toBe(fx.users.tech.id);

    // A technician hands the ticket to a colleague.
    await withSystemDbAccessContext(() => assignTicket(ticketId, fx.users.otherTech.id, { kind: 'user', userId: fx.users.tech.id }));
    await publishFromOutside();
    queued.length = 0;

    // The customer replies on the thread.
    const reply = normalized(fx, uniq('reply'), first.messageId ?? undefined);
    await withSystemDbAccessContext(() => ingestIn(fx, reply));
    const replyRow = await inboundRow(fx, reply.providerMessageId);
    expect(replyRow).toMatchObject({ status: 'matched', ticketId });
    expect((await ticketRow(ticketId)).assignedTo).toBe(fx.users.otherTech.id);
    await publishFromOutside();
    expect(assignedFor(ticketId)).toEqual([]);
  });

  runDb('a user who cannot own the ticket leaves it unassigned, never cross-partner', async () => {
    const fx = await seed();
    const cases: Array<[string, string]> = [
      // Written straight into settings, as a stale or tampered row would be: the
      // save check never ran, so only the ingest check stands in the way.
      [fx.users.foreign.id, 'ASSIGNEE_WRONG_PARTNER'],
      [fx.users.foreignLinked.id, 'ASSIGNEE_WRONG_PARTNER'],
      [fx.users.disabled.id, 'ASSIGNEE_NOT_ELIGIBLE'],
      [fx.users.scopedOut.id, 'ASSIGNEE_NOT_ELIGIBLE'],
    ];
    for (const [userId, code] of cases) {
      await setDefaultAssignee(fx.partnerId, userId);
      const n = normalized(fx, uniq(code));
      await withSystemDbAccessContext(() => ingestIn(fx, n));
      const inbound = await inboundRow(fx, n.providerMessageId);
      expect(inbound.status).toBe('created');
      expect(inbound.note).toContain(`default assignee not applied (${code})`);
      const ticket = await ticketRow(inbound.ticketId!);
      expect(ticket.assignedTo).toBeNull();
      expect(ticket.status).toBe('new');
      await publishFromOutside();
      expect(assignedFor(inbound.ticketId!)).toEqual([]);
    }
  });
});
