/**
 * Integration test — W06 (#6776) ticket-operations write tools honour the site
 * axis, the org axis and the partner axis, against real Postgres as the
 * unprivileged `breeze_app` role.
 *
 * Tools: manage_tickets:bulk_update, manage_ticket_attachments,
 * manage_ticket_inbox.
 *
 * Fixture: partner P with org O1 (sites S1, S2; a device in each; one ticket on
 * each device and one device-less ticket) and org O2 (one ticket); partner Q
 * with org Q1. Callers:
 *   restricted  org token for O1, allowed site S1 only
 *   orgAll      org token for O1, no site restriction
 *   partnerAll  partner P admin reaching O1 and O2
 *   adminQ      partner Q admin
 *
 * Proven against stored rows:
 *   bulk_update      out-of-site tickets are skipped and NOT changed; a batch
 *                    spanning organizations is refused whole; another partner's
 *                    tickets are out of scope; the in-scope path DOES write.
 *   attachments      every action on an out-of-site ticket is "not found" (no
 *                    bytes opened, no row written or deleted); the in-site path
 *                    reads text, refuses binary, and deletes.
 *   inbox            convert creates the ticket in the CHOSEN org only (the
 *                    caller's partner), refuses an org of another partner with
 *                    the row left in the queue, and another partner's queue
 *                    rows are not found.
 *
 * Nothing contacts a device; only DB writes sit behind the gates under test.
 */
import './setup';
import { randomUUID, createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, ticketEmailInbound, tickets } from '../../db/schema';
import { ticketAttachments } from '../../db/schema/ticketAttachments';
import { registerTicketingTools } from '../../services/aiToolsTicketing';
import { registerTicketAttachmentTools } from '../../services/aiToolsTicketAttachments';
import { registerTicketInboxTools } from '../../services/aiToolsTicketInbox';
import { clearPermissionCache } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerTicketingTools(reg);
  registerTicketAttachmentTools(reg);
  registerTicketInboxTools(reg);
  return reg;
}

type Who = 'restricted' | 'orgAll' | 'partnerAll' | 'adminQ';

interface Fixture {
  partnerP: string;
  partnerQ: string;
  o1: string;
  o2: string;
  q1: string;
  userId: string;
  adminQId: string;
  tIn: string;      // O1, device in S1
  tOut: string;     // O1, device in S2
  tNone: string;    // O1, no device
  tO2: string;      // O2
  tQ: string;       // Q1
  auth: Record<Who, AuthContext>;
  siteS1: string;
}

const PERMS = [
  { resource: 'tickets', action: 'read' },
  { resource: 'tickets', action: 'write' },
];

function orgAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'ticket-ops-scope' },
  } as unknown as AuthContext;
}

function partnerAuth(userId: string, partnerId: string, orgIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: true },
    token: {} as AuthContext['token'],
    partnerId,
    orgId: null,
    scope: 'partner',
    partnerOrgAccess: 'all',
    accessibleOrgIds: orgIds,
    orgCondition: (col: PgColumn) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'ticket-ops-scope' },
  } as unknown as AuthContext;
}

const db = () => getTestDb();

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await db().insert(devices).values({
    orgId, siteId, agentId: `ops-${randomUUID()}`, hostname: `ops-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedTicket(orgId: string, partnerId: string, deviceId: string | null, subject: string): Promise<string> {
  const [row] = await db().insert(tickets).values({
    orgId, partnerId, deviceId, subject, source: 'manual', ticketNumber: `OPS-${randomUUID().slice(0, 8)}`,
  }).returning({ id: tickets.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const pP = await createPartner();
  const pQ = await createPartner();
  const o1 = await createOrganization({ partnerId: pP.id });
  const o2 = await createOrganization({ partnerId: pP.id });
  const q1 = await createOrganization({ partnerId: pQ.id });
  const s1 = await createSite({ orgId: o1.id, name: 'Ops S1' });
  const s2 = await createSite({ orgId: o1.id, name: 'Ops S2' });

  const user = await createUser({ partnerId: pP.id, orgId: o1.id, email: `ops-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'partner', partnerId: pP.id });
  await grantRolePermissions(role.id, PERMS);
  await assignUserToPartner(user.id, pP.id, role.id, 'all');
  const adminQ = await createUser({ partnerId: pQ.id, email: `ops-q-${randomUUID()}@example.com` });
  const roleQ = await createRole({ scope: 'partner', partnerId: pQ.id });
  await grantRolePermissions(roleQ.id, PERMS);
  await assignUserToPartner(adminQ.id, pQ.id, roleQ.id, 'all');

  const dIn = await seedDevice(o1.id, s1.id);
  const dOut = await seedDevice(o1.id, s2.id);
  return {
    partnerP: pP.id, partnerQ: pQ.id, o1: o1.id, o2: o2.id, q1: q1.id, userId: user.id, adminQId: adminQ.id, siteS1: s1.id,
    tIn: await seedTicket(o1.id, pP.id, dIn, 'in-site ticket'),
    tOut: await seedTicket(o1.id, pP.id, dOut, 'out-of-site ticket'),
    tNone: await seedTicket(o1.id, pP.id, null, 'org-level ticket'),
    tO2: await seedTicket(o2.id, pP.id, null, 'org two ticket'),
    tQ: await seedTicket(q1.id, pQ.id, null, 'other partner ticket'),
    auth: {
      restricted: orgAuth(user.id, pP.id, o1.id, [s1.id]),
      orgAll: orgAuth(user.id, pP.id, o1.id),
      partnerAll: partnerAuth(user.id, pP.id, [o1.id, o2.id]),
      adminQ: partnerAuth(adminQ.id, pQ.id, [q1.id]),
    },
  };
}

function ctxFor(f: Fixture, who: Who): DbAccessContext {
  if (who === 'partnerAll') {
    return { scope: 'partner', orgId: null, accessibleOrgIds: [f.o1, f.o2], accessiblePartnerIds: [f.partnerP], userId: f.userId, currentPartnerId: f.partnerP };
  }
  if (who === 'adminQ') {
    return { scope: 'partner', orgId: null, accessibleOrgIds: [f.q1], accessiblePartnerIds: [f.partnerQ], userId: f.adminQId, currentPartnerId: f.partnerQ };
  }
  return { scope: 'organization', orgId: f.o1, accessibleOrgIds: [f.o1], accessiblePartnerIds: [], userId: f.userId, currentPartnerId: f.partnerP };
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const handler = registry().get(tool)!.handler;
  const raw = await withDbAccessContext(ctxFor(f, who), () => handler(input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const ticketRow = async (id: string) => (await db().select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe('manage_tickets:bulk_update — site axis, org axis, single-org rule', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const bulk = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_tickets', { action: 'bulk_update', ...input });

  runDb('a site-restricted caller: the out-of-site ticket is skipped and NOT changed, the in-site ticket IS changed', async () => {
    const before = await ticketRow(f.tOut);
    const res = await bulk('restricted', { ticketIds: [f.tIn, f.tOut], priority: 'urgent' });
    expect(res).toMatchObject({ updated: 1, skipped: 1, failed: 0, skippedReasons: { OUT_OF_SCOPE: 1 } });
    expect((await ticketRow(f.tIn)).priority).toBe('urgent');
    const after = await ticketRow(f.tOut);
    expect(after.priority).toBe(before.priority);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  runDb('a site-restricted caller cannot assign or change the status of an out-of-site ticket either', async () => {
    const before = await ticketRow(f.tOut);
    const assign = await bulk('restricted', { ticketIds: [f.tOut], assigneeId: f.userId });
    expect(assign).toMatchObject({ updated: 0, skipped: 1, skippedReasons: { OUT_OF_SCOPE: 1 } });
    const status = await bulk('restricted', { ticketIds: [f.tOut], status: 'closed' });
    expect(status).toMatchObject({ updated: 0, skipped: 1 });
    const after = await ticketRow(f.tOut);
    expect(after.assignedTo).toBe(before.assignedTo);
    expect(after.status).toBe(before.status);
    // control: the unrestricted org caller reaches it
    expect(await bulk('orgAll', { ticketIds: [f.tOut], priority: 'high' })).toMatchObject({ updated: 1 });
    expect((await ticketRow(f.tOut)).priority).toBe('high');
  });

  runDb("another partner's and another org's tickets are out of scope for an org token", async () => {
    const res = await bulk('orgAll', { ticketIds: [f.tIn, f.tO2, f.tQ], priority: 'low' });
    expect(res).toMatchObject({ updated: 1, skipped: 2, skippedReasons: { OUT_OF_SCOPE: 2 } });
    expect((await ticketRow(f.tO2)).priority).not.toBe('low');
    expect((await ticketRow(f.tQ)).priority).not.toBe('low');
  });

  runDb('a batch spanning two organizations of the caller is refused whole: nothing is written', async () => {
    const before = [await ticketRow(f.tIn), await ticketRow(f.tO2)];
    const res = await bulk('partnerAll', { ticketIds: [f.tIn, f.tO2], priority: 'urgent' });
    expect(res).toMatchObject({ code: 'MULTIPLE_ORGANIZATIONS' });
    expect((await ticketRow(f.tIn)).priority).toBe(before[0]!.priority);
    expect((await ticketRow(f.tO2)).priority).toBe(before[1]!.priority);
    // control: the same caller can bulk-update tickets of ONE org
    expect(await bulk('partnerAll', { ticketIds: [f.tIn, f.tNone], priority: 'urgent' })).toMatchObject({ updated: 2 });
    expect((await ticketRow(f.tNone)).priority).toBe('urgent');
  });

  runDb('another partner\'s admin sees nothing of this partner\'s tickets', async () => {
    const res = await bulk('adminQ', { ticketIds: [f.tIn, f.tO2], priority: 'urgent' });
    expect(res).toMatchObject({ updated: 0, skipped: 2, skippedReasons: { OUT_OF_SCOPE: 2 } });
    expect((await ticketRow(f.tIn)).priority).not.toBe('urgent');
  });

  runDb('assign: an assignee from another partner fails the request and changes no ticket', async () => {
    const res = await bulk('partnerAll', { ticketIds: [f.tIn], assigneeId: f.adminQId });
    expect(res).toMatchObject({ code: 'ASSIGNEE_PARTNER_MISMATCH' });
    expect((await ticketRow(f.tIn)).assignedTo).toBeNull();
    expect(await bulk('partnerAll', { ticketIds: [f.tIn], assigneeId: f.userId })).toMatchObject({ updated: 1 });
    expect((await ticketRow(f.tIn)).assignedTo).toBe(f.userId);
  });
});

describe('manage_ticket_attachments — site axis and org axis', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const att = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_ticket_attachments', input);

  async function seedAttachment(ticketId: string, orgId: string, over: Partial<typeof ticketAttachments.$inferInsert> = {}) {
    const bytes = Buffer.from('printer log: ok');
    const [row] = await db().insert(ticketAttachments).values({
      orgId, ticketId, commentId: null, uploadedByUserId: f.userId, storageBackend: 'db', data: bytes,
      contentType: 'text/plain', byteSize: bytes.length, originalFilename: 'printer.txt',
      sha256: createHash('sha256').update(bytes).digest('hex'), ...over,
    }).returning({ id: ticketAttachments.id });
    return row!.id;
  }

  runDb('every action on an out-of-site ticket is not found, and no attachment row changes', async () => {
    const id = await seedAttachment(f.tOut, f.o1);
    for (const input of [
      { action: 'list', ticketId: f.tOut },
      { action: 'read_content', ticketId: f.tOut, attachmentId: id },
      { action: 'delete', ticketId: f.tOut, attachmentId: id },
      { action: 'attach_from_artifact', ticketId: f.tOut, artifactId: randomUUID() },
    ]) {
      expect(await att('restricted', input), JSON.stringify(input)).toMatchObject({ code: 'TICKET_NOT_FOUND' });
    }
    expect(await db().select().from(ticketAttachments).where(eq(ticketAttachments.ticketId, f.tOut))).toHaveLength(1);
  });

  runDb("another org's and another partner's tickets are not found for an org token", async () => {
    for (const ticketId of [f.tO2, f.tQ]) {
      expect(await att('orgAll', { action: 'list', ticketId })).toMatchObject({ code: 'TICKET_NOT_FOUND' });
    }
  });

  runDb('in-site control: list shows the caller\'s pending file, read_content returns its text, a binary type is metadata only, delete removes it', async () => {
    const text = await seedAttachment(f.tIn, f.o1);
    const png = await seedAttachment(f.tIn, f.o1, { contentType: 'image/png', originalFilename: 'screen.png' });
    const list = await att('restricted', { action: 'list', ticketId: f.tIn });
    expect(list.attachments.map((a: { id: string; pending: boolean }) => `${a.id}:${a.pending}`).sort()).toEqual([`${text}:true`, `${png}:true`].sort());

    const read = await att('restricted', { action: 'read_content', ticketId: f.tIn, attachmentId: text });
    expect(read).toMatchObject({ contentReturned: true, text: 'printer log: ok' });
    const binary = await att('restricted', { action: 'read_content', ticketId: f.tIn, attachmentId: png });
    expect(binary).toMatchObject({ contentReturned: false });
    expect(binary).not.toHaveProperty('text');

    expect(await att('restricted', { action: 'delete', ticketId: f.tIn, attachmentId: text })).toEqual({ deleted: true, attachmentId: text });
    expect(await db().select().from(ticketAttachments).where(eq(ticketAttachments.id, text))).toHaveLength(0);
  });

  runDb('an attachment id of ANOTHER ticket is not found through an accessible ticket', async () => {
    const other = await seedAttachment(f.tNone, f.o1);
    expect(await att('restricted', { action: 'read_content', ticketId: f.tIn, attachmentId: other })).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(await att('restricted', { action: 'delete', ticketId: f.tIn, attachmentId: other })).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(await db().select().from(ticketAttachments).where(eq(ticketAttachments.id, other))).toHaveLength(1);
  });

  runDb("someone else's pending upload is invisible to read_content", async () => {
    const theirs = await seedAttachment(f.tIn, f.o1, { uploadedByUserId: f.adminQId });
    expect(await att('restricted', { action: 'read_content', ticketId: f.tIn, attachmentId: theirs })).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect((await att('restricted', { action: 'list', ticketId: f.tIn })).attachments.map((a: { id: string }) => a.id)).not.toContain(theirs);
  });
});

describe('manage_ticket_inbox — the ticket lands in the chosen org of the caller\'s partner only', () => {
  let f: Fixture;
  beforeEach(async () => { await clearPermissionCache(); f = await seedFixture(); });
  const inbox = (who: Who, input: Record<string, unknown>) => run(f, who, 'manage_ticket_inbox', input);

  async function seedQueueRow(partnerId: string, subject: string) {
    const [row] = await db().insert(ticketEmailInbound).values({
      partnerId, provider: 'mailgun', providerMessageId: `msg-${randomUUID()}`, fromAddress: 'sender@acme.example',
      toAddress: 'support@msp.example', subject, parseStatus: 'quarantined',
      raw: { bodyText: 'The printer is on fire', fromName: 'Pat Sender' },
    }).returning({ id: ticketEmailInbound.id });
    return row!.id;
  }
  const storedRow = async (id: string) => (await db().select().from(ticketEmailInbound).where(eq(ticketEmailInbound.id, id)))[0]!;

  runDb('an organization token never reaches the queue', async () => {
    const id = await seedQueueRow(f.partnerP, 'hello');
    expect(await inbox('orgAll', { action: 'list' })).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(await inbox('orgAll', { action: 'convert', id, orgId: f.o1 })).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect((await storedRow(id)).parseStatus).toBe('quarantined');
  });

  runDb("list shows only the caller partner's queue rows", async () => {
    const mine = await seedQueueRow(f.partnerP, 'mine');
    const theirs = await seedQueueRow(f.partnerQ, 'theirs');
    const p = await inbox('partnerAll', { action: 'list' });
    expect(p.emails.map((e: { id: string }) => e.id)).toEqual([mine]);
    const q = await inbox('adminQ', { action: 'list' });
    expect(q.emails.map((e: { id: string }) => e.id)).toEqual([theirs]);
  });

  runDb('convert creates the ticket in the chosen org (O2), as that org\'s ticket, and closes the queue row', async () => {
    const id = await seedQueueRow(f.partnerP, 'Printer on fire');
    const res = await inbox('partnerAll', { action: 'convert', id, orgId: f.o2 });
    expect(res.error, JSON.stringify(res)).toBeUndefined();
    const row = await storedRow(id);
    expect(row.parseStatus).toBe('created');
    expect(row.ticketId).toBeTruthy();
    const ticket = await ticketRow(row.ticketId!);
    expect(ticket).toMatchObject({ orgId: f.o2, partnerId: f.partnerP, source: 'email', subject: 'Printer on fire', submitterEmail: 'sender@acme.example' });
    // a second convert of the same row is refused and creates no second ticket
    expect(await inbox('partnerAll', { action: 'convert', id, orgId: f.o1 })).toMatchObject({ code: 'INBOUND_ROW_ALREADY_RESOLVED' });
    expect(await db().select().from(tickets).where(eq(tickets.subject, 'Printer on fire'))).toHaveLength(1);
  });

  runDb('convert into an org of ANOTHER partner is refused: the row stays in the queue and no ticket exists', async () => {
    const id = await seedQueueRow(f.partnerP, 'Cross partner attempt');
    const res = await inbox('partnerAll', { action: 'convert', id, orgId: f.q1 });
    expect(res).toMatchObject({ code: 'ORG_NOT_ACCESSIBLE' });
    const row = await storedRow(id);
    expect(row.parseStatus).toBe('quarantined');
    expect(row.ticketId).toBeNull();
    expect(await db().select().from(tickets).where(eq(tickets.subject, 'Cross partner attempt'))).toHaveLength(0);
  });

  runDb("another partner's admin can neither convert nor dismiss this partner's row", async () => {
    const id = await seedQueueRow(f.partnerP, 'Not yours');
    expect(await inbox('adminQ', { action: 'convert', id, orgId: f.q1 })).toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND' });
    expect(await inbox('adminQ', { action: 'dismiss', id })).toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND' });
    expect((await storedRow(id)).parseStatus).toBe('quarantined');
    // control: the owner can dismiss
    expect((await inbox('partnerAll', { action: 'dismiss', id })).error).toBeUndefined();
    expect((await storedRow(id)).parseStatus).toBe('ignored');
  });
});
