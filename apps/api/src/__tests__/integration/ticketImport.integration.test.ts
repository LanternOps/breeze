/**
 * Ticket import mode (#8313, wave 1b; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §4–§6) against real Postgres and Redis, as the unprivileged `breeze_app`
 * role: the writer opens its own partner context narrowed to the window's
 * orgs through the production `db`.
 *
 * Proves (§6 "1b"):
 *   - an importTicket round trip keeps the source's times, authors and
 *     numbers, writes no outbox row and no audit row and queues no event, and
 *     charges the window's bucket one unit per write;
 *   - a chunked ticket resumes after a mid-import close, in a new window;
 *   - resume refuses a live ticket's source id, a deleted ticket, and a
 *     ticket moved to an org outside the window;
 *   - another partner's org is refused, by the window check and by RLS;
 *   - search finds a ticket by its whole source number;
 *   - the throughput bucket refuses past writes_per_hour and refunds;
 *   - (deviation from §4.6) a resume re-applies header fields changed in the
 *     source, but never one a Breeze user set since.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

type Queued = { type: string; ticketId: string };
const queued = vi.hoisted(() => [] as Queued[]);
const audited = vi.hoisted(() => [] as Array<{ action: string; resourceId?: string | null }>);
const chargeHook = vi.hoisted(() => ({ calls: 0, before: null as null | ((call: number) => Promise<void>) }));

vi.mock('../../services/ticketEvents', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketEvents')>();
  const record = async (input: { type: string; ticketId: string }) => { queued.push({ type: input.type, ticketId: input.ticketId }); };
  return { ...actual, emitTicketEvent: record, enqueueTicketEvent: record };
});
vi.mock('../../services/auditService', async (orig) => {
  const actual = await orig<typeof import('../../services/auditService')>();
  return {
    ...actual,
    createAuditLogAsync: async (params: Parameters<typeof actual.createAuditLogAsync>[0]) => {
      audited.push({ action: params.action, resourceId: params.resourceId });
      return actual.createAuditLogAsync(params);
    },
  };
});
vi.mock('../../services/ticketImport/throughput', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketImport/throughput')>();
  return {
    ...actual,
    chargeWindowThroughput: async (window: { id: string; writesPerHour: number }, cost: number) => {
      chargeHook.calls += 1;
      if (chargeHook.before) await chargeHook.before(chargeHook.calls);
      return actual.chargeWindowThroughput(window, cost);
    },
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  auditLogs,
  migrationWindows,
  partnerServicePrincipals,
  ticketComments,
  ticketExternalRefs,
  ticketOutbox,
  tickets,
  users,
} from '../../db/schema';
import { closeMigrationWindow, openMigrationWindow } from '../../services/migrationWindows';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { importTicket } from '../../services/ticketImport/importWriter';
import type { ImportedTicket } from '../../services/ticketImport/importedTicket';
import { migrationWindowRateKey } from '../../services/ticketImport/throughput';
import { windowWriteContext } from '../../services/ticketImport/windowLock';
import { ticketSearchCondition } from '../../services/ticketSearch';
import { assignTicket, createTicket, updateTicketFields } from '../../services/ticketService';
import type { OpenWindow } from '../../services/ticketWriteMode';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY = 86_400_000;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

const T0 = new Date('2021-03-04T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

async function seed() {
  const admin = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgOutside = await createOrganization({ partnerId: partner.id });
  const owner = await createUser({ partnerId: partner.id, orgId: null, email: `${uniq('owner')}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role!.id, [
    { resource: 'organizations', action: 'write' },
    { resource: 'tickets', action: 'write' },
    { resource: 'tickets', action: 'read' },
  ]);
  await assignUserToPartner(owner.id, partner.id, role!.id, 'all');
  // A former agent: deactivated, partner staff. And a current one.
  const formerAgent = await createUser({ partnerId: partner.id, orgId: null, email: `${uniq('former')}@example.test`, status: 'disabled' });
  const agent = await createUser({ partnerId: partner.id, orgId: null, email: `${uniq('agent')}@example.test` });
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: uniq('Zammad import'),
    scopes: ['tickets:read', 'tickets:write'],
    createdBy: owner.id,
    updatedBy: owner.id,
  }).returning();
  const ownerContext = (): DbAccessContext => ({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id, orgB.id, orgOutside.id],
    accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id,
    userId: owner.id,
  });
  return { partner, orgA, orgB, orgOutside, owner, formerAgent, agent, principal: principal!, ownerContext };
}

type Fx = Awaited<ReturnType<typeof seed>>;

async function openWindow(fx: Fx, overrides: Partial<Parameters<typeof openMigrationWindow>[0]> = {}) {
  const [epochs] = await getTestDb().select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
    .from(users).where(eq(users.id, fx.owner.id));
  return withDbAccessContext(fx.ownerContext(), () => openMigrationWindow({
    partnerId: fx.partner.id,
    principalId: fx.principal.id,
    orgIds: [fx.orgA.id, fx.orgB.id],
    endsAt: new Date(Date.now() + 2 * DAY),
    sourceLabel: 'zammad',
    opener: { userId: fx.owner.id, authEpoch: epochs!.authEpoch, mfaEpoch: epochs!.mfaEpoch },
    stepUp: null,
    ...overrides,
  }));
}

async function closeWindow(fx: Fx, windowId: string) {
  await withSystemDbAccessContext(() => db.transaction((tx) => closeMigrationWindow(tx, {
    windowId, partnerId: fx.partner.id, reason: 'closed_by_admin', closedBy: fx.owner.id,
  })));
}

function source(fx: Fx, overrides: Partial<ImportedTicket> = {}): ImportedTicket {
  return {
    sourceId: uniq('zammad-ticket'),
    sourceNumber: `ZM-${seq++}41023`,
    sourceUrl: 'https://helpdesk.example.test/#ticket/zoom/41023',
    orgId: fx.orgA.id,
    createdAt: T0,
    updatedAt: minutes(300),
    subject: 'Printer on floor 3 jams',
    description: 'It jams on every second page.',
    priority: 'normal',
    tags: ['printer'],
    source: 'email',
    requester: { name: 'Maya Customer', email: 'maya@customer.example' },
    assigneeUserId: fx.formerAgent.id,
    finalStatus: 'closed',
    resolvedAt: minutes(200),
    closedAt: minutes(260),
    resolutionNote: 'Replaced the fuser.',
    comments: [
      { sourceId: uniq('article'), createdAt: minutes(10), isPublic: true, author: { kind: 'requester', name: 'Maya Customer', email: 'maya@customer.example' }, content: 'Still jamming.' },
      { sourceId: uniq('article'), createdAt: minutes(30), isPublic: false, author: { kind: 'staff', name: 'Former Agent', email: 'former@msp.example' }, content: 'Ordered a fuser.' },
      { sourceId: uniq('article'), createdAt: minutes(45), isPublic: true, author: { kind: 'staff', name: 'Former Agent', email: 'former@msp.example' }, content: 'Fixed, please confirm.' },
    ],
    ...overrides,
  };
}

async function bucketSize(windowId: string): Promise<number> {
  return Number(await getRedis()!.zcard(migrationWindowRateKey(windowId)));
}

async function outboxFor(ticketId: string) {
  return getTestDb().select().from(ticketOutbox).where(eq(ticketOutbox.ticketId, ticketId));
}

async function auditFor(ticketId: string) {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.resourceId, ticketId));
}

describe('ticket import mode (real Postgres, as breeze_app)', () => {
  beforeEach(() => {
    queued.length = 0;
    audited.length = 0;
    chargeHook.calls = 0;
    chargeHook.before = null;
  });
  afterEach(() => {
    chargeHook.before = null;
  });

  runDb('a round trip keeps the source history and produces no outbox row, no audit row and no queued event', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx);

    const result = await importTicket(window.id, ticket, { partnerId: fx.partner.id });
    expect(result).toEqual({ ticketId: expect.any(String), outcome: 'created', commentsWritten: 3, commentsSkipped: 0, fieldsUpdated: 0 });

    const [row] = await getTestDb().select().from(tickets).where(eq(tickets.id, result.ticketId));
    expect(row).toMatchObject({
      orgId: fx.orgA.id,
      partnerId: fx.partner.id,
      migrationWindowId: window.id,
      createdAt: T0,
      status: 'closed',
      resolvedAt: minutes(200),
      closedAt: minutes(260),
      closedBy: null,
      resolutionNote: 'Replaced the fuser.',
      // §4.3: no SLA, and the restamp can never give it one.
      responseSlaMinutes: null,
      resolutionSlaMinutes: null,
      // Only the public STAFF reply is a first response, at its source time.
      firstResponseAt: minutes(45),
      assignedTo: fx.formerAgent.id,
      source: 'email',
      submitterName: 'Maya Customer',
      submitterEmail: 'maya@customer.example',
      requesterContactId: null,
      tags: ['printer'],
      ticketType: 'incident',
    });
    expect(row!.internalNumber).toMatch(/^T-2021-\d{4}$/);
    expect(row!.fieldProvenance).toMatchObject({ responseSlaMinutes: 'service_principal', resolutionSlaMinutes: 'service_principal' });
    // updated_at follows the history, never "now".
    expect(row!.updatedAt.getTime()).toBe(minutes(260).getTime());

    const rows = await getTestDb().select().from(ticketComments)
      .where(eq(ticketComments.ticketId, result.ticketId)).orderBy(ticketComments.createdAt);
    expect(rows.every((c) => c.migrationWindowId === window.id && c.originPrincipalId === fx.principal.id && c.userId === null)).toBe(true);
    const imported = rows.filter((c) => c.importSourceId);
    expect(imported.map((c) => [c.importSourceId, c.authorName, c.authorType, c.originalAuthorKind, c.originalAuthorEmail, c.createdAt.getTime()]))
      .toEqual(ticket.comments.map((c) => [
        c.sourceId, c.author.name, c.author.kind === 'staff' ? 'internal' : 'email', c.author.kind, c.author.email, c.createdAt.getTime(),
      ]));
    // The feed reads in historic order: assignment at creation, resolved, closed.
    const feed = rows.filter((c) => !c.importSourceId).map((c) => [c.commentType, c.newValue, c.createdAt.getTime()]);
    expect(feed).toEqual([
      ['assignment', fx.formerAgent.id, T0.getTime()],
      ['status_change', 'resolved', minutes(200).getTime()],
      ['status_change', 'closed', minutes(260).getTime()],
    ]);

    const [ref] = await getTestDb().select().from(ticketExternalRefs).where(eq(ticketExternalRefs.ticketId, result.ticketId));
    expect(ref).toMatchObject({ partnerServicePrincipalId: fx.principal.id, externalId: ticket.sourceId, externalNumber: ticket.sourceNumber, externalUrl: ticket.sourceUrl });

    // §4.5: no side effect beyond the rows.
    expect(await outboxFor(result.ticketId)).toEqual([]);
    expect(queued.filter((e) => e.ticketId === result.ticketId)).toEqual([]);
    expect(audited.filter((a) => a.resourceId === result.ticketId)).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await auditFor(result.ticketId)).toEqual([]);

    // §4.7: one unit per write — create, ref, assign, 3 comments, resolved, closed.
    expect(await bucketSize(window.id)).toBe(8);

    // A second run resumes and finds nothing to do: no write, no charge.
    const again = await importTicket(window.id, ticket, { partnerId: fx.partner.id });
    expect(again).toEqual({ ticketId: result.ticketId, outcome: 'resumed', commentsWritten: 0, commentsSkipped: 3, fieldsUpdated: 0 });
    expect(await bucketSize(window.id)).toBe(8);
    expect(await getTestDb().select().from(ticketComments).where(eq(ticketComments.ticketId, result.ticketId))).toHaveLength(rows.length);

    // The window's close counts what it imported.
    await closeWindow(fx, window.id);
    const [closed] = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, window.id));
    expect(closed!.summary).toMatchObject({ ticketsImported: 1, commentsImported: 3 });
  });

  runDb('a chunked ticket closed mid-import resumes in the next window', async () => {
    const fx = await seed();
    const first = await openWindow(fx);
    const comments = Array.from({ length: 5 }, (_, i) => ({
      sourceId: uniq(`article-${i}`),
      createdAt: minutes(10 + i),
      isPublic: i % 2 === 0,
      author: { kind: 'staff' as const, name: 'Former Agent' },
      content: `Article ${i}`,
    }));
    const ticket = source(fx, { comments, assigneeUserId: undefined });
    // Transactions: header (create + ref), chunk 1, chunk 2, chunk 3 + status.
    // Close the window just before the third charge.
    chargeHook.before = async (call) => {
      if (call === 3) await closeWindow(fx, first.id);
    };
    await expect(importTicket(first.id, ticket, { chunkSize: 2, partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_NOT_OPEN', status: 409 });
    chargeHook.before = null;

    const [partial] = await getTestDb().select().from(tickets)
      .where(eq(tickets.migrationWindowId, first.id));
    expect(partial).toMatchObject({ status: 'new' });
    const written = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, partial!.id), sql`${ticketComments.importSourceId} IS NOT NULL`));
    expect(written.map((c) => c.importSourceId).sort()).toEqual(comments.slice(0, 2).map((c) => c.sourceId).sort());

    const second = await openWindow(fx);
    const resumed = await importTicket(second.id, ticket, { chunkSize: 2, partnerId: fx.partner.id });
    expect(resumed).toEqual({ ticketId: partial!.id, outcome: 'resumed', commentsWritten: 3, commentsSkipped: 2, fieldsUpdated: 0 });
    const all = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, partial!.id), sql`${ticketComments.importSourceId} IS NOT NULL`));
    expect(all).toHaveLength(5);
    // The ticket keeps the window that created it; the new comments carry the new one.
    expect(all.filter((c) => c.migrationWindowId === second.id).map((c) => c.importSourceId).sort())
      .toEqual(comments.slice(2).map((c) => c.sourceId).sort());
    const [done] = await getTestDb().select().from(tickets).where(eq(tickets.id, partial!.id));
    expect(done).toMatchObject({ migrationWindowId: first.id, status: 'closed', closedAt: minutes(260) });
    expect(await outboxFor(partial!.id)).toEqual([]);
  });

  runDb('resume refuses a live ticket, a deleted ticket and a ticket moved out of the window', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const admin = getTestDb();

    // A live ticket whose ref this principal holds (e.g. written before the window).
    const [live] = await admin.insert(tickets).values({
      orgId: fx.orgA.id, partnerId: fx.partner.id, ticketNumber: uniq('LIVE'), internalNumber: uniq('T'), subject: 'Live',
    }).returning();
    await admin.insert(ticketExternalRefs).values({
      ticketId: live!.id, orgId: fx.orgA.id, partnerId: fx.partner.id, partnerServicePrincipalId: fx.principal.id, externalId: 'LIVE-1',
    });
    await expect(importTicket(window.id, source(fx, { sourceId: 'LIVE-1' }), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_SOURCE_ID_IN_USE', status: 409, details: { reason: 'live_ticket' } });

    // A deleted imported ticket.
    const deleted = await importTicket(window.id, source(fx, { comments: [] }), { partnerId: fx.partner.id });
    await admin.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, deleted.ticketId));
    const deletedSource = await admin.select({ externalId: ticketExternalRefs.externalId }).from(ticketExternalRefs)
      .where(eq(ticketExternalRefs.ticketId, deleted.ticketId));
    await expect(importTicket(window.id, source(fx, { sourceId: deletedSource[0]!.externalId, comments: [] }), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_SOURCE_ID_IN_USE', details: { reason: 'deleted' } });

    // An imported ticket moved to an org of the partner that is not in the
    // window: RLS hides its ref, so the writer tries a create, the ref index
    // refuses it, and the create is rolled back.
    const moved = await importTicket(window.id, source(fx, { comments: [] }), { partnerId: fx.partner.id });
    await admin.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.update(tickets).set({ orgId: fx.orgOutside.id }).where(eq(tickets.id, moved.ticketId));
      await tx.update(ticketExternalRefs).set({ orgId: fx.orgOutside.id }).where(eq(ticketExternalRefs.ticketId, moved.ticketId));
    });
    const [movedRef] = await admin.select().from(ticketExternalRefs).where(eq(ticketExternalRefs.ticketId, moved.ticketId));
    const before = await admin.select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, fx.orgA.id));
    await expect(importTicket(window.id, source(fx, { sourceId: movedRef!.externalId, comments: [] }), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_SOURCE_ID_IN_USE', details: { reason: 'held_elsewhere' } });
    expect(await admin.select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, fx.orgA.id))).toHaveLength(before.length);
  });

  runDb("another partner's org is refused by the window check, and by RLS under the window's context", async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const other = await seed();
    await expect(importTicket(window.id, source(fx, { orgId: other.orgA.id }), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_ORG_NOT_ALLOWED', status: 403 });
    // A caller acting for another partner cannot write through this window.
    await expect(importTicket(window.id, source(fx), { partnerId: other.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_NOT_OPEN', status: 409 });
    // Even a forged OpenWindow that lists the foreign org cannot write it: the
    // import context's RLS only reaches the window's orgs.
    const forged = {
      id: window.id, partnerId: other.partner.id, principalId: fx.principal.id, principalName: 'forged', orgIds: new Set([other.orgA.id]),
    } as unknown as OpenWindow;
    const context = windowWriteContext({ id: window.id, partnerId: fx.partner.id, principalId: fx.principal.id, writesPerHour: 6000, orgIds: [fx.orgA.id, fx.orgB.id] });
    await expect(withDbAccessContext(context, () => createTicket(
      { orgId: other.orgA.id, subject: 'forged', source: 'manual' },
      { kind: 'service_principal', principalId: fx.principal.id, keyId: null, name: 'forged' },
      { kind: 'import', window: forged, at: T0 },
    ))).rejects.toMatchObject({ status: 404 });
    expect(await getTestDb().select().from(tickets).where(eq(tickets.orgId, other.orgA.id))).toEqual([]);
  });

  runDb('the staff search finds an imported ticket by its whole source number, case-insensitively, in visible orgs only', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const number = `ZM-${Date.now()}`;
    const imported = await importTicket(window.id, source(fx, { sourceNumber: number, subject: 'Unrelated subject', comments: [] }), { partnerId: fx.partner.id });
    const search = (term: string, orgIds: string[]) => withDbAccessContext(fx.ownerContext(), () => db
      .select({ id: tickets.id }).from(tickets)
      .where(and(inArray(tickets.orgId, orgIds), ticketSearchCondition(term, orgIds))));
    expect(await search(number.toLowerCase(), [fx.orgA.id, fx.orgB.id])).toEqual([{ id: imported.ticketId }]);
    expect(await search(`  ${number}  `, [fx.orgA.id])).toEqual([{ id: imported.ticketId }]);
    // Whole numbers only, and only through the caller's orgs.
    expect(await search(number.slice(0, -2), [fx.orgA.id])).toEqual([]);
    expect(await search(number, [fx.orgB.id])).toEqual([]);
  });

  runDb('the throughput bucket refuses past writes_per_hour, refunds the refused attempt, and writes nothing', async () => {
    const fx = await seed();
    const window = await openWindow(fx, { writesPerHour: 600 });
    // Spend the hour.
    await rateLimiter(getRedis(), migrationWindowRateKey(window.id), 600, 3600, 599);
    await expect(importTicket(window.id, source(fx, { comments: [] }), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_RATE_LIMITED', status: 429, details: { retryAfterSeconds: expect.any(Number) } });
    expect(await bucketSize(window.id)).toBe(599);
    expect(await getTestDb().select().from(tickets).where(eq(tickets.migrationWindowId, window.id))).toEqual([]);
  });

  runDb('a re-import in a later window converges the header on the source, except what a Breeze user changed', async () => {
    const fx = await seed();
    const first = await openWindow(fx);
    const userEdited = source(fx, { comments: [], finalStatus: 'open', resolvedAt: undefined, closedAt: undefined });
    const userReassigned = source(fx, { comments: [], finalStatus: 'open', resolvedAt: undefined, closedAt: undefined });
    const a = await importTicket(first.id, userEdited, { partnerId: fx.partner.id });
    const b = await importTicket(first.id, userReassigned, { partnerId: fx.partner.id });
    await closeWindow(fx, first.id);

    // Between the passes, technicians work in Breeze: one retitles ticket A,
    // another unassigns ticket B.
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    await withDbAccessContext(fx.ownerContext(), () => updateTicketFields(a.ticketId, { subject: 'Retitled in Breeze' }, tech));
    await withDbAccessContext(fx.ownerContext(), () => assignTicket(b.ticketId, null, tech));
    const outboxBefore = (await outboxFor(a.ticketId)).length + (await outboxFor(b.ticketId)).length;
    queued.length = 0;
    audited.length = 0;

    // The delta pass: the source changed subject, priority, tags and assignee.
    const second = await openWindow(fx);
    const delta = { subject: 'Changed in the source', priority: 'high' as const, tags: ['printer', 'vip'], assigneeUserId: fx.agent.id, updatedAt: minutes(500) };
    const ra = await importTicket(second.id, { ...userEdited, ...delta }, { partnerId: fx.partner.id });
    const rb = await importTicket(second.id, { ...userReassigned, ...delta }, { partnerId: fx.partner.id });

    // A: subject is the user's; priority, tags and assignee follow the source.
    expect(ra).toMatchObject({ outcome: 'resumed', fieldsUpdated: 3 });
    const [rowA] = await getTestDb().select().from(tickets).where(eq(tickets.id, a.ticketId));
    expect(rowA).toMatchObject({ subject: 'Retitled in Breeze', priority: 'high', tags: ['printer', 'vip'], assignedTo: fx.agent.id });
    expect(rowA!.fieldProvenance).toMatchObject({ subject: 'user', priority: 'service_principal', tags: 'service_principal' });
    // Still no SLA after a priority change (§4.3).
    expect(rowA).toMatchObject({ responseSlaMinutes: null, resolutionSlaMinutes: null });
    // B: the technician's unassignment stands; the rest follows the source.
    expect(rb).toMatchObject({ outcome: 'resumed', fieldsUpdated: 3 });
    const [rowB] = await getTestDb().select().from(tickets).where(eq(tickets.id, b.ticketId));
    expect(rowB).toMatchObject({ subject: 'Changed in the source', priority: 'high', assignedTo: null });

    // The re-applied writes are import writes too: stamped, silent.
    const feedA = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, a.ticketId), eq(ticketComments.migrationWindowId, second.id)));
    expect(feedA.map((c) => [c.commentType, c.createdAt.getTime()]).sort()).toEqual([
      ['assignment', minutes(500).getTime()],
      ['system', minutes(500).getTime()],
    ]);
    expect((await outboxFor(a.ticketId)).length + (await outboxFor(b.ticketId)).length).toBe(outboxBefore);
    expect(queued).toEqual([]);
    expect(audited).toEqual([]);
  });
  runDb('a ticket deleted between two of its transactions stops the import; a close-only source ticket keeps its note', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const comments = Array.from({ length: 3 }, (_, i) => ({
      sourceId: uniq(`article-${i}`), createdAt: minutes(10 + i), isPublic: false,
      author: { kind: 'staff' as const, name: 'Former Agent' }, content: `Note ${i}`,
    }));
    const ticket = source(fx, { comments, assigneeUserId: undefined });
    // Header, then chunk 1; a technician deletes the ticket before chunk 2.
    chargeHook.before = async (call) => {
      if (call !== 3) return;
      await getTestDb().update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.migrationWindowId, window.id));
    };
    await expect(importTicket(window.id, ticket, { chunkSize: 2, partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_SOURCE_ID_IN_USE', details: { reason: 'deleted' } });
    chargeHook.before = null;
    const [deleted] = await getTestDb().select().from(tickets).where(eq(tickets.migrationWindowId, window.id));
    expect(await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, deleted!.id), sql`${ticketComments.importSourceId} IS NOT NULL`))).toHaveLength(2);
    expect(deleted).toMatchObject({ status: 'new' });

    // Zammad has only close_at: the note survives through a resolve at the close time.
    const closeOnly = await importTicket(window.id, source(fx, {
      comments: [], assigneeUserId: undefined, resolvedAt: undefined, closedAt: minutes(260), resolutionNote: 'Replaced the fuser.',
    }), { partnerId: fx.partner.id });
    const [row] = await getTestDb().select().from(tickets).where(eq(tickets.id, closeOnly.ticketId));
    expect(row).toMatchObject({ status: 'closed', resolutionNote: 'Replaced the fuser.', resolvedAt: minutes(260), closedAt: minutes(260) });
  });
});
