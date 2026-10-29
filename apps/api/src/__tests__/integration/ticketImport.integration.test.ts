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
 *     source, but never one a Breeze user set since; the final status follows
 *     the same rule, keyed on the latest status_change row;
 *   - a comment already imported under a ticket the window cannot see is
 *     skipped on its unique-index conflict, and the rest of its chunk commits;
 *   - another partner's window is not found, whatever its state;
 *   - (#8313 W0, spec 2026-10-19 §5.3) a display-only requester may have no
 *     email; a resume reports, and does not apply, a changed requester, org,
 *     edited or flipped comment and a comment deleted in the source;
 *   - (#8313 W0, not in the spec) a ticket this principal imported and a
 *     technician merged in Breeze (#8972) is skipped as merged_in_breeze,
 *     also when the merge commits mid-ticket; a ref the merge moved onto a
 *     live ticket or another principal's import is refused, never resumed;
 *   - a survivor of a native merge decides Breeze-wins on its own feed rows
 *     only, and keeps the tags the merge wrote.
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
import { mergeTickets } from '../../services/ticketMerge';
import { windowWriteContext } from '../../services/ticketImport/windowLock';
import { ticketSearchCondition } from '../../services/ticketSearch';
import { assignTicket, changeTicketStatus, createTicket, editTicketComment, updateTicketFields } from '../../services/ticketService';
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

/** A resume's report-only fields when the source changed nothing (and a first import's). */
const NOTHING_CHANGED = { requesterChanged: false, orgChanged: false, commentsChangedInSource: [], commentsMissingInSource: [] };
/** The attachment fields of a ticket with no files (#8313 W1; files: ticketImportAttachments.integration.test.ts). */
const NO_FILES = { attachmentsWritten: 0, attachmentsSkipped: [], attachmentBytes: 0 };

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
    expect(result).toEqual({ ticketId: expect.any(String), outcome: 'created', commentsWritten: 3, commentsSkipped: 0, fieldsUpdated: 0, statusSkipped: false, ...NO_FILES, ...NOTHING_CHANGED });

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
    expect(again).toEqual({ ticketId: result.ticketId, outcome: 'resumed', commentsWritten: 0, commentsSkipped: 3, fieldsUpdated: 0, statusSkipped: false, ...NO_FILES, ...NOTHING_CHANGED });
    expect(await bucketSize(window.id)).toBe(8);
    expect(await getTestDb().select().from(ticketComments).where(eq(ticketComments.ticketId, result.ticketId))).toHaveLength(rows.length);

    // The window's close counts what it imported.
    await closeWindow(fx, window.id);
    const [closed] = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, window.id));
    expect(closed!.summary).toMatchObject({ ticketsImported: 1, commentsImported: 3 });
  });

  runDb('a display-only requester with no email is imported with its name and a NULL submitter email', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const result = await importTicket(window.id, source(fx, { requester: { name: 'Walk-in Customer' }, comments: [] }), { partnerId: fx.partner.id });
    expect(result).toMatchObject({ outcome: 'created' });
    const [row] = await getTestDb().select().from(tickets).where(eq(tickets.id, result.ticketId));
    expect(row).toMatchObject({ source: 'email', submitterName: 'Walk-in Customer', submitterEmail: null, requesterContactId: null });
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
    expect(resumed).toEqual({ ticketId: partial!.id, outcome: 'resumed', commentsWritten: 3, commentsSkipped: 2, fieldsUpdated: 0, statusSkipped: false, ...NO_FILES, ...NOTHING_CHANGED });
    const all = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, partial!.id), sql`${ticketComments.importSourceId} IS NOT NULL`));
    expect(all).toHaveLength(5);
    // The ticket keeps the window that created it; the new comments carry the new one.
    expect(all.filter((c) => c.migrationWindowId === second.id).map((c) => c.importSourceId).sort())
      .toEqual(comments.slice(2).map((c) => c.sourceId).sort());
    // No status_change row yet, so the resume still applies the final status.
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

  runDb('a resume reports what changed in the source and applies none of it: requester, org, edited, flipped and deleted comments', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const article = (i: number, isPublic: boolean, content: string) => ({
      sourceId: uniq(`article-${i}`), createdAt: minutes(10 + i), isPublic,
      author: { kind: 'staff' as const, name: 'Former Agent' }, content,
    });
    const edited = article(1, true, 'First reply.');
    const flipped = article(2, true, 'Customer phone: 555-0100.');
    const deleted = article(3, false, 'Will be deleted in the source.');
    const editedInBreeze = article(4, true, 'Typo in teh reply.');
    const timeNote = { ...article(5, false, 'Time accounted: 3h.'), sourceId: `${uniq('zammad-ticket')}:time` };
    const open = { assigneeUserId: undefined, finalStatus: 'open' as const, resolvedAt: undefined, closedAt: undefined, resolutionNote: undefined };
    const first = source(fx, { ...open, comments: [edited, flipped, deleted, editedInBreeze, timeNote] });
    const created = await importTicket(window.id, first, { partnerId: fx.partner.id });
    expect(created).toMatchObject({ outcome: 'created', commentsWritten: 5, ...NOTHING_CHANGED });

    // A technician fixes a typo in Breeze.
    const [breezeEdited] = await getTestDb().select({ id: ticketComments.id }).from(ticketComments)
      .where(eq(ticketComments.importSourceId, editedInBreeze.sourceId));
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    await withDbAccessContext(fx.ownerContext(), () => editTicketComment(breezeEdited!.id, { content: 'Typo in the reply.' }, tech, { canManageAny: true }));
    const snapshot = async () => ({
      ticket: (await getTestDb().select().from(tickets).where(eq(tickets.id, created.ticketId)))[0],
      comments: await getTestDb().select().from(ticketComments)
        .where(eq(ticketComments.ticketId, created.ticketId)).orderBy(ticketComments.createdAt, ticketComments.id),
    });
    const before = await snapshot();
    const charged = await bucketSize(window.id);

    // The delta: the source moved the ticket to org B, changed the
    // requester's address, edited one article, made another internal, deleted
    // a third, and stopped composing the time note; the article Breeze edited
    // was edited in the source too. One new article.
    const added = article(6, false, 'New note.');
    const isSourceArticleId = (id: string) => !id.endsWith(':time');
    const resumed = await importTicket(window.id, {
      ...first,
      orgId: fx.orgB.id,
      requester: { name: 'Maya Customer', email: 'maya.new@customer.example' },
      comments: [{ ...edited, content: 'First reply, edited.' }, { ...flipped, isPublic: false }, { ...editedInBreeze, content: 'Typo in teh reply!' }, added],
    }, { partnerId: fx.partner.id, isSourceArticleId });

    expect(resumed).toEqual({
      ticketId: created.ticketId,
      outcome: 'resumed',
      commentsWritten: 1,
      commentsSkipped: 3,
      fieldsUpdated: 0,
      statusSkipped: false,
      ...NO_FILES,
      requesterChanged: true,
      orgChanged: true,
      // The flipped flag is listed; the Breeze edit wins, so its source edit is not.
      commentsChangedInSource: [
        { sourceId: edited.sourceId, contentChanged: true, visibility: null },
        { sourceId: flipped.sourceId, contentChanged: false, visibility: 'made_internal' },
      ],
      // The composed time note is not an article.
      commentsMissingInSource: [deleted.sourceId],
    });

    // None of it was applied: only the new article was written, and charged.
    const after = await snapshot();
    expect(after.ticket).toMatchObject({ orgId: fx.orgA.id, submitterEmail: 'maya@customer.example', requesterContactId: null });
    const withoutAdded = after.comments.filter((c) => c.importSourceId !== added.sourceId);
    expect(withoutAdded.map((c) => [c.id, c.content, c.isPublic, c.deletedAt]))
      .toEqual(before.comments.map((c) => [c.id, c.content, c.isPublic, c.deletedAt]));
    expect(after.comments.filter((c) => c.importSourceId === added.sourceId)).toHaveLength(1);
    expect(await bucketSize(window.id)).toBe(charged + 1);

    // Without isSourceArticleId, nothing is counted missing.
    const again = await importTicket(window.id, { ...first, comments: [] }, { partnerId: fx.partner.id });
    expect(again).toMatchObject({ commentsMissingInSource: [], requesterChanged: false, orgChanged: false });
  });

  runDb('a re-import applies the source status only while the import set it last: a Breeze status change wins', async () => {
    const fx = await seed();
    const first = await openWindow(fx);
    const open = { comments: [], assigneeUserId: undefined, finalStatus: 'open' as const, resolvedAt: undefined, closedAt: undefined, resolutionNote: undefined };
    const techChanged = source(fx, open);
    const untouched = source(fx, open);
    const requesterReopened = source(fx, { comments: [], assigneeUserId: undefined, finalStatus: 'resolved', resolvedAt: minutes(200), closedAt: undefined });
    const raced = source(fx, open);
    const a = await importTicket(first.id, techChanged, { partnerId: fx.partner.id });
    const b = await importTicket(first.id, untouched, { partnerId: fx.partner.id });
    const c = await importTicket(first.id, requesterReopened, { partnerId: fx.partner.id });
    const d = await importTicket(first.id, raced, { partnerId: fx.partner.id });
    await closeWindow(fx, first.id);

    // Between the passes: a technician puts A on pending; the requester's
    // email reopens the resolved C (the inbound pipeline's system actor).
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    await withDbAccessContext(fx.ownerContext(), () => changeTicketStatus(a.ticketId, { status: 'pending' }, {}, tech));
    await withSystemDbAccessContext(() => changeTicketStatus(
      c.ticketId, { status: 'open' }, {}, { kind: 'system', source: 'inbound_email', name: 'Inbound Email' },
    ));
    const outboxBefore = (await outboxFor(a.ticketId)).length + (await outboxFor(c.ticketId)).length;
    queued.length = 0;
    audited.length = 0;

    // The delta pass: the source closed every ticket, and added a note to A,
    // so A's status is decided again under the lock in its comment chunk.
    const second = await openWindow(fx);
    const closed = { finalStatus: 'closed' as const, resolvedAt: minutes(400), closedAt: minutes(450), resolutionNote: 'Closed in the source.', updatedAt: minutes(450) };
    const note = { sourceId: uniq('article'), createdAt: minutes(420), isPublic: false, author: { kind: 'staff' as const, name: 'Former Agent' }, content: 'Closing.' };
    const ra = await importTicket(second.id, { ...techChanged, ...closed, comments: [note] }, { partnerId: fx.partner.id });
    const rb = await importTicket(second.id, { ...untouched, ...closed }, { partnerId: fx.partner.id });
    const rc = await importTicket(second.id, { ...requesterReopened, ...closed }, { partnerId: fx.partner.id });

    // A and C keep the Breeze status, and the result says so; B, whose
    // status only the import ever set, converges on the source.
    expect(ra).toMatchObject({ outcome: 'resumed', commentsWritten: 1, statusSkipped: true });
    expect(rc).toMatchObject({ outcome: 'resumed', statusSkipped: true });
    expect(rb).toMatchObject({ outcome: 'resumed', statusSkipped: false });
    // Why each was kept: who owns the status, and both statuses.
    expect(ra.statusSkip).toEqual({ statusOwner: { kind: 'user', principalId: null }, sourceStatus: 'closed', currentStatus: 'pending' });
    expect(rc.statusSkip).toEqual({ statusOwner: { kind: 'user', principalId: null }, sourceStatus: 'closed', currentStatus: 'open' });
    expect(rb).not.toHaveProperty('statusSkip');
    const statusOf = async (id: string) => (await getTestDb().select().from(tickets).where(eq(tickets.id, id)))[0]!;
    expect(await statusOf(a.ticketId)).toMatchObject({ status: 'pending', closedAt: null });
    expect(await statusOf(c.ticketId)).toMatchObject({ status: 'open', closedAt: null });
    expect(await statusOf(b.ticketId)).toMatchObject({ status: 'closed', resolvedAt: minutes(400), closedAt: minutes(450), resolutionNote: 'Closed in the source.' });

    // Through the second window, A got its note and nothing else, C got
    // nothing, and nothing left the import: no outbox row, no event, no audit.
    const viaSecond = async (ids: string[]) => (await getTestDb().select().from(ticketComments)
      .where(and(inArray(ticketComments.ticketId, ids), eq(ticketComments.migrationWindowId, second.id))))
      .map((r) => [r.ticketId, r.importSourceId]);
    expect(await viaSecond([a.ticketId, c.ticketId])).toEqual([[a.ticketId, note.sourceId]]);
    expect((await outboxFor(a.ticketId)).length + (await outboxFor(c.ticketId)).length).toBe(outboxBefore);
    expect(await outboxFor(b.ticketId)).toEqual([]);
    expect(queued).toEqual([]);
    expect(audited).toEqual([]);
    // Charged: A's note plus its two status steps (planned as a skip, still
    // charged because its transaction decides again under the lock), B's two
    // status writes; nothing for C, whose predicted skip opens no transaction.
    expect(await bucketSize(second.id)).toBe(5);

    // A technician changes D's status after the plan, just before its status
    // transaction: decided again under the lock, the Breeze status is kept.
    chargeHook.calls = 0;
    chargeHook.before = async (call) => {
      if (call === 1) await withDbAccessContext(fx.ownerContext(), () => changeTicketStatus(d.ticketId, { status: 'on_hold' }, {}, tech));
    };
    const rd = await importTicket(second.id, { ...raced, ...closed }, { partnerId: fx.partner.id });
    chargeHook.before = null;
    expect(rd).toMatchObject({ outcome: 'resumed', statusSkipped: true });
    expect(rd.statusSkip).toEqual({ statusOwner: { kind: 'user', principalId: null }, sourceStatus: 'closed', currentStatus: 'on_hold' });
    expect(await statusOf(d.ticketId)).toMatchObject({ status: 'on_hold', closedAt: null });
    expect(await viaSecond([d.ticketId])).toEqual([]);
    // Charged as planned: a status kept under the lock overcharges, never undercharges.
    expect(await bucketSize(second.id)).toBe(7);
  });

  runDb('a first import reports statusSkipped when a Breeze change lands between its header and its last transaction', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, { assigneeUserId: undefined });
    // Transactions: header (create + ref), then the three comments and the
    // final status. A technician puts the new ticket on hold in between.
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    chargeHook.before = async (call) => {
      if (call !== 2) return;
      const [created] = await getTestDb().select({ id: tickets.id }).from(tickets).where(eq(tickets.migrationWindowId, window.id));
      await withDbAccessContext(fx.ownerContext(), () => changeTicketStatus(created!.id, { status: 'on_hold' }, {}, tech));
    };
    const result = await importTicket(window.id, ticket, { partnerId: fx.partner.id });
    chargeHook.before = null;

    expect(result).toMatchObject({ outcome: 'created', commentsWritten: 3, statusSkipped: true });
    expect(result.statusSkip).toEqual({ statusOwner: { kind: 'user', principalId: null }, sourceStatus: 'closed', currentStatus: 'on_hold' });
    const [row] = await getTestDb().select().from(tickets).where(eq(tickets.id, result.ticketId));
    expect(row).toMatchObject({ status: 'on_hold', resolvedAt: null, closedAt: null });
    // The import wrote no status row of its own.
    const statusRows = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, result.ticketId), eq(ticketComments.commentType, 'status_change')));
    expect(statusRows.map((r) => [r.newValue, r.originPrincipalKind])).toEqual([['on_hold', 'user']]);
  });

  runDb('a comment another ticket already holds is skipped mid-chunk on resume, and the rest of the chunk commits', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const article = (i: number, extra: Partial<ImportedTicket['comments'][number]> = {}) => ({
      sourceId: uniq(`article-${i}`), createdAt: minutes(10 + i), isPublic: false,
      author: { kind: 'staff' as const, name: 'Former Agent' }, content: `Article ${i}`, ...extra,
    });
    const held = article(2);
    // The source merged ticket X's article into Y. X was imported with it and
    // has since moved to an org outside the window, so the window's RLS hides
    // the article from the writer's presence checks: only the unique index
    // ticket_comments_import_source_uq sees it, inside the chunk transaction.
    const x = await importTicket(window.id, source(fx, { comments: [held], assigneeUserId: undefined }), { partnerId: fx.partner.id });
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.update(tickets).set({ orgId: fx.orgOutside.id }).where(eq(tickets.id, x.ticketId));
      await tx.update(ticketExternalRefs).set({ orgId: fx.orgOutside.id }).where(eq(ticketExternalRefs.ticketId, x.ticketId));
    });

    // Precondition: the window's own context cannot see the held article, so
    // only the unique index can stop it.
    const descriptor = { id: window.id, partnerId: fx.partner.id, principalId: fx.principal.id, writesPerHour: 6000, orgIds: [fx.orgA.id, fx.orgB.id] };
    expect(await withDbAccessContext(windowWriteContext(descriptor), () => db.select({ id: ticketComments.id }).from(ticketComments)
      .where(eq(ticketComments.importSourceId, held.sourceId)))).toEqual([]);

    const open = { assigneeUserId: undefined, finalStatus: 'open' as const, resolvedAt: undefined, closedAt: undefined, resolutionNote: undefined };
    const c0 = article(0);
    const y = source(fx, { ...open, comments: [c0] });
    const created = await importTicket(window.id, y, { partnerId: fx.partner.id });

    // The delta pass brings two new articles around the held one, all in one
    // chunk, and the final status rides on that chunk's transaction.
    const c1 = article(1, { isPublic: true });
    const c3 = article(3);
    const resumed = await importTicket(window.id, {
      ...y, comments: [c0, c1, held, c3], finalStatus: 'resolved', resolvedAt: minutes(100), resolutionNote: 'Fixed.',
    }, { partnerId: fx.partner.id });

    expect(resumed).toMatchObject({ ticketId: created.ticketId, outcome: 'resumed', commentsWritten: 2, commentsSkipped: 2 });
    const yComments = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.ticketId, created.ticketId), sql`${ticketComments.importSourceId} IS NOT NULL`));
    expect(yComments.map((r) => r.importSourceId).sort()).toEqual([c0.sourceId, c1.sourceId, c3.sourceId].sort());
    // The held article stays where it was, once.
    const heldRows = await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.originPrincipalId, fx.principal.id), eq(ticketComments.importSourceId, held.sourceId)));
    expect(heldRows.map((r) => r.ticketId)).toEqual([x.ticketId]);
    // The statements after the conflict ran in the same transaction: the
    // public staff reply stamped the first response, and the status applied.
    expect((await getTestDb().select().from(tickets).where(eq(tickets.id, created.ticketId)))[0])
      .toMatchObject({ status: 'resolved', resolvedAt: minutes(100), resolutionNote: 'Fixed.', firstResponseAt: minutes(11) });
    expect(await outboxFor(created.ticketId)).toEqual([]);
  });

  runDb("another partner's window is not found, whether it is open or closed", async () => {
    const fx = await seed();
    const other = await seed();
    const closed = await openWindow(fx);
    await closeWindow(fx, closed.id);
    const open = await openWindow(fx);
    for (const windowId of [open.id, closed.id]) {
      await expect(importTicket(windowId, source(other), { partnerId: other.partner.id }))
        .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_NOT_OPEN', status: 409, details: { reason: 'not_found' } });
    }
    // Its own partner still learns that the window is closed.
    await expect(importTicket(closed.id, source(fx), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_NOT_OPEN', details: { reason: 'closed' } });
    expect(await getTestDb().select().from(tickets).where(inArray(tickets.orgId, [other.orgA.id, fx.orgA.id]))).toEqual([]);
  });

  runDb('a ticket merged in Breeze between two passes is skipped as merged_in_breeze; a ref the merge moved is refused; nothing is written or charged', async () => {
    const fx = await seed();
    const first = await openWindow(fx);
    const open = { assigneeUserId: undefined, finalStatus: 'open' as const, resolvedAt: undefined, closedAt: undefined, resolutionNote: undefined };
    const article = (i: number) => ({
      sourceId: uniq(`article-${i}`), createdAt: minutes(10 + i), isPublic: true,
      author: { kind: 'requester' as const, name: 'Maya Customer' }, content: `Article ${i}`,
    });
    // Pass 1 imports five tickets: A and B, C, D, E. A live ticket L exists
    // in Breeze, and another import principal brought in X.
    const a = source(fx, { ...open, comments: [article(1)] });
    const b = source(fx, { ...open, comments: [article(2)] });
    const c = source(fx, { ...open, comments: [article(3)] });
    const d = source(fx, { ...open, comments: [article(4)] });
    const e = source(fx, { ...open, comments: [article(8)] });
    const [ra, rb, rc, rd, re] = [
      await importTicket(first.id, a, { partnerId: fx.partner.id }),
      await importTicket(first.id, b, { partnerId: fx.partner.id }),
      await importTicket(first.id, c, { partnerId: fx.partner.id }),
      await importTicket(first.id, d, { partnerId: fx.partner.id }),
      await importTicket(first.id, e, { partnerId: fx.partner.id }),
    ];
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    const live = await withDbAccessContext(fx.ownerContext(), () => createTicket({ orgId: fx.orgA.id, subject: 'Printer, again', source: 'manual' }, tech));
    await closeWindow(fx, first.id);
    const [otherPrincipal] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: fx.partner.id, name: uniq('Other import'), scopes: ['tickets:read', 'tickets:write'], createdBy: fx.owner.id, updatedBy: fx.owner.id,
    }).returning();
    const otherWindow = await openWindow(fx, { principalId: otherPrincipal!.id });
    const rx = await importTicket(otherWindow.id, source(fx, { ...open, comments: [article(9)] }), { partnerId: fx.partner.id });
    await closeWindow(fx, otherWindow.id);

    // Between the passes a technician merges A into B (both this principal's
    // imports: A's ref stays on the tombstone), C into the live L and E into
    // the other principal's X (neither survivor has a ref from this
    // principal, so the merge moves the ref onto it).
    const merge = (src: string, dst: string) => withDbAccessContext(fx.ownerContext(), () => mergeTickets({ sourceTicketId: src, intoTicketId: dst, notifyRequester: false }, tech));
    await merge(ra.ticketId, rb.ticketId);
    await merge(rc.ticketId, live.id);
    await merge(re.ticketId, rx.ticketId);
    const refOf = async (sourceId: string) => (await getTestDb().select().from(ticketExternalRefs)
      .where(and(eq(ticketExternalRefs.partnerServicePrincipalId, fx.principal.id), eq(ticketExternalRefs.externalId, sourceId))))[0]!.ticketId;
    expect(await refOf(a.sourceId)).toBe(ra.ticketId);
    expect(await refOf(c.sourceId)).toBe(live.id);
    expect(await refOf(e.sourceId)).toBe(rx.ticketId);

    const touched = [ra.ticketId, rb.ticketId, rc.ticketId, rd.ticketId, re.ticketId, live.id, rx.ticketId];
    const snapshot = async () => ({
      tickets: await getTestDb().select().from(tickets).where(inArray(tickets.id, touched)).orderBy(tickets.id),
      comments: (await getTestDb().select({ id: ticketComments.id, ticketId: ticketComments.ticketId }).from(ticketComments)
        .where(inArray(ticketComments.ticketId, touched))).map((r) => `${r.ticketId}:${r.id}`).sort(),
    });
    const before = await snapshot();

    // Pass 2, in a new window: the source has a new article on A, C and E.
    const second = await openWindow(fx);
    const resumedA = await importTicket(second.id, { ...a, comments: [...a.comments, article(5)] }, { partnerId: fx.partner.id });
    expect(resumedA).toEqual({
      ticketId: ra.ticketId,
      outcome: 'skipped',
      skip: { reason: 'merged_in_breeze', mergedIntoTicketId: rb.ticketId },
      commentsWritten: 0, commentsSkipped: 0, fieldsUpdated: 0, statusSkipped: false, ...NO_FILES, ...NOTHING_CHANGED,
    });
    // A moved ref resolves to a ticket this principal did not import: refused,
    // never resumed onto it (the known limit: on every pass).
    await expect(importTicket(second.id, { ...c, comments: [...c.comments, article(6)] }, { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_SOURCE_ID_IN_USE', status: 409, details: { reason: 'live_ticket', ticketId: live.id } });
    await expect(importTicket(second.id, { ...e, comments: [...e.comments, article(10)] }, { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_SOURCE_ID_IN_USE', status: 409, details: { reason: 'other_principal_ticket', ticketId: rx.ticketId } });
    expect(await snapshot()).toEqual(before);
    expect(await bucketSize(second.id)).toBe(0);

    // The survivor B still resumes, and A's articles the merge moved onto it
    // are not reported missing from B's source ticket.
    const resumedB = await importTicket(second.id, b, { partnerId: fx.partner.id, isSourceArticleId: () => true });
    expect(resumedB).toMatchObject({ ticketId: rb.ticketId, outcome: 'resumed', commentsWritten: 0, ...NOTHING_CHANGED });

    // A merge that commits after the plan, just before D's first transaction,
    // is answered under the lock: nothing is written; that transaction's
    // charge was taken before it opened, and is spent.
    const before2 = await snapshot();
    chargeHook.calls = 0;
    chargeHook.before = async (call) => {
      if (call === 1) await merge(rd.ticketId, rb.ticketId);
    };
    const resumedD = await importTicket(second.id, { ...d, comments: [...d.comments, article(7)] }, { partnerId: fx.partner.id });
    chargeHook.before = null;
    expect(resumedD).toMatchObject({
      ticketId: rd.ticketId, outcome: 'skipped', skip: { reason: 'merged_in_breeze', mergedIntoTicketId: rb.ticketId }, commentsWritten: 0,
    });
    const after2 = await snapshot();
    // Only the merge itself changed rows (D's comments moved to B, its tombstone
    // and B's merge notes); no imported article 7 anywhere.
    expect(after2.comments.length).toBe(before2.comments.length + 2);
    expect(await getTestDb().select().from(ticketComments)
      .where(and(eq(ticketComments.originPrincipalId, fx.principal.id), eq(ticketComments.migrationWindowId, second.id)))).toEqual([]);
    expect(await bucketSize(second.id)).toBe(1);
  });

  runDb('a survivor of a native merge keeps its own Breeze-wins history: moved feed rows do not decide, and the merged tags stay', async () => {
    const fx = await seed();
    const first = await openWindow(fx);
    const open = { comments: [], assigneeUserId: undefined, finalStatus: 'open' as const, resolvedAt: undefined, closedAt: undefined, resolutionNote: undefined };
    // S1 absorbs T1, S2 absorbs T2; all four are this principal's imports.
    const s1 = source(fx, { ...open, tags: ['printer'] });
    const t1 = source(fx, { ...open, tags: ['vip'] });
    const s2 = source(fx, { ...open });
    const t2 = source(fx, { ...open });
    const [rs1, rt1, rs2, rt2] = [
      await importTicket(first.id, s1, { partnerId: fx.partner.id }),
      await importTicket(first.id, t1, { partnerId: fx.partner.id }),
      await importTicket(first.id, s2, { partnerId: fx.partner.id }),
      await importTicket(first.id, t2, { partnerId: fx.partner.id }),
    ];
    await closeWindow(fx, first.id);

    // A technician puts S1 and T2 on hold.
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    await withDbAccessContext(fx.ownerContext(), () => changeTicketStatus(rs1.ticketId, { status: 'on_hold' }, {}, tech));
    await withDbAccessContext(fx.ownerContext(), () => changeTicketStatus(rt2.ticketId, { status: 'on_hold' }, {}, tech));
    // A delta pass then moves T1 to pending in the source, at a source time
    // after the technician's change: T1's newest status row is the import's.
    const second = await openWindow(fx);
    await importTicket(second.id, { ...t1, finalStatus: 'pending', updatedAt: new Date() }, { partnerId: fx.partner.id });

    // The technician merges T1 into S1 and T2 into S2: each tombstone's feed
    // rows move onto its survivor, and S1 gets the tag union.
    const merge = (src: string, dst: string) => withDbAccessContext(fx.ownerContext(), () => mergeTickets({ sourceTicketId: src, intoTicketId: dst, notifyRequester: false }, tech));
    await merge(rt1.ticketId, rs1.ticketId);
    await merge(rt2.ticketId, rs2.ticketId);
    const ticketRow = async (id: string) => (await getTestDb().select().from(tickets).where(eq(tickets.id, id)))[0]!;
    expect((await ticketRow(rs1.ticketId)).tags).toEqual(['printer', 'vip']);

    // The next pass resolves both in the source, and S1's source still says ['printer'].
    const resolved = { finalStatus: 'resolved' as const, resolvedAt: minutes(400), updatedAt: minutes(400) };
    const r1 = await importTicket(second.id, { ...s1, ...resolved }, { partnerId: fx.partner.id });
    const r2 = await importTicket(second.id, { ...s2, ...resolved }, { partnerId: fx.partner.id });

    // S1: its own newest status row is the technician's; T1's newer import
    // row, moved in, does not make the status the import's.
    expect(r1).toMatchObject({ outcome: 'resumed', fieldsUpdated: 0, statusSkipped: true });
    expect(r1.statusSkip).toEqual({ statusOwner: { kind: 'user', principalId: null }, sourceStatus: 'resolved', currentStatus: 'on_hold' });
    expect(await ticketRow(rs1.ticketId)).toMatchObject({ status: 'on_hold', tags: ['printer', 'vip'] });
    // S2: the technician's row moved in from T2 does not keep S2's status;
    // S2's own newest row is the import's, so the source status applies.
    expect(r2).toMatchObject({ outcome: 'resumed', statusSkipped: false });
    expect(await ticketRow(rs2.ticketId)).toMatchObject({ status: 'resolved', resolvedAt: minutes(400) });
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
