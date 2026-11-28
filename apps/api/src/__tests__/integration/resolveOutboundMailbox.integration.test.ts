/**
 * Email-first replies W1 Task 2 (Refs #8758, review focus 7): the outbound
 * mailbox is the one that received the ticket, against a real Postgres.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  organizations,
  partners,
  ticketEmailInbound,
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
  tickets,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import { uniqueInternalNumber } from '../../services/inboundEmail/fixtureNumbering';
import { resolveOutboundMailbox } from '../../services/ticketMailbox/resolveOutboundMailbox';

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const admin = () => getTestDb() as any;
const seeded = { partnerIds: [] as string[], orgIds: [] as string[] };

let fx: { partnerId: string; orgId: string; tenantId: string; ticketId: string; support: string; helpdesk: string };

async function connect(mailboxAddress: string, createdAt: Date, status = 'connected') {
  await admin().insert(ticketMailboxConnections).values({
    partnerId: fx.partnerId, tenantId: fx.tenantId, mailboxAddress, status, createdAt,
  });
}

async function inbound(toAddress: string, providerMessageId: string, createdAt: Date) {
  await admin().insert(ticketEmailInbound).values({
    partnerId: fx.partnerId, provider: 'm365', providerMessageId, fromAddress: 'jane@customer.test',
    toAddress, parseStatus: 'matched', ticketId: fx.ticketId, createdAt,
  });
}

const resolve = () => withSystemDbAccessContext(() => resolveOutboundMailbox(fx.ticketId, fx.partnerId));

beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  seeded.partnerIds.push(partner.id);
  seeded.orgIds.push(org.id);
  const tenantId = randomUUID();
  await admin().insert(ticketMailboxTenantOwnerships).values({ tenantId, partnerId: partner.id, verifiedMicrosoftOid: randomUUID() });
  const [t] = await admin().insert(tickets).values({
    orgId: org.id, partnerId: partner.id, ticketNumber: `OM-${suffix()}`, internalNumber: uniqueInternalNumber(),
    subject: 'Printer', status: 'open', source: 'email', submitterEmail: 'jane@customer.test',
  }).returning({ id: tickets.id });
  const s = suffix();
  fx = { partnerId: partner.id, orgId: org.id, tenantId, ticketId: t.id, support: `support-${s}@msp.test`, helpdesk: `helpdesk-${s}@msp.test` };
});

afterAll(async () => {
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);
  const db = admin();
  await db.delete(ticketEmailInbound).where(sql`${ticketEmailInbound.partnerId} IN (${partnerList})`);
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.delete(ticketMailboxConnections).where(sql`${ticketMailboxConnections.partnerId} IN (${partnerList})`);
  await db.delete(ticketMailboxTenantOwnerships).where(sql`${ticketMailboxTenantOwnerships.partnerId} IN (${partnerList})`);
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  });
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('resolveOutboundMailbox (real driver)', () => {
  it('two connections: picks the mailbox that ingested the ticket, threaded on its message', async () => {
    await connect(fx.support, new Date('2027-01-01T00:00:00Z'));
    await connect(fx.helpdesk, new Date('2027-01-02T00:00:00Z'));
    await inbound(fx.helpdesk.toUpperCase(), 'graph-helpdesk-1', new Date('2027-01-03T00:00:00Z'));

    await expect(resolve()).resolves.toEqual({ tenantId: fx.tenantId, mailbox: fx.helpdesk, originalMessageId: 'graph-helpdesk-1' });
  });

  it('receiving mailbox disconnected: returns null even with another mailbox connected', async () => {
    await connect(fx.support, new Date('2027-01-01T00:00:00Z'));
    await connect(fx.helpdesk, new Date('2027-01-02T00:00:00Z'), 'disabled');
    await inbound(fx.helpdesk, 'graph-helpdesk-1', new Date('2027-01-03T00:00:00Z'));

    await expect(resolve()).resolves.toBeNull();
  });

  it('no inbound row + two connections: oldest connection, no thread', async () => {
    await connect(fx.helpdesk, new Date('2027-01-02T00:00:00Z'));
    await connect(fx.support, new Date('2027-01-01T00:00:00Z'));

    await expect(resolve()).resolves.toEqual({ tenantId: fx.tenantId, mailbox: fx.support, originalMessageId: null });
  });

  it("ignores another partner's inbound row for the same ticket id", async () => {
    await connect(fx.support, new Date('2027-01-01T00:00:00Z'));
    const other = await createPartner();
    seeded.partnerIds.push(other.id);
    await admin().insert(ticketEmailInbound).values({
      partnerId: other.id, provider: 'm365', providerMessageId: 'graph-other', fromAddress: 'x@other.test',
      toAddress: fx.support, parseStatus: 'matched', ticketId: fx.ticketId,
    });

    await expect(resolve()).resolves.toEqual({ tenantId: fx.tenantId, mailbox: fx.support, originalMessageId: null });
  });
});
