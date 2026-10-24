/**
 * Attachments in import mode (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4, §8 W1 row) against real Postgres and Redis, as the unprivileged
 * `breeze_app` role through the production `db`.
 *
 * The test stack has no object store, so S3 is faked at its lowest boundary,
 * services/s3Storage.ts: `isS3Configured` answers a flag and
 * `putObjectBuffer` / `deleteObjects` work on an in-memory map. Everything
 * above it (blobStorage, ticketAttachmentStorage.putBytes, selectBackend,
 * the reaper) is the real code.
 *
 * Proves:
 *   - a round trip writes attached rows (the sniffed type, real size and
 *     digest, the source time, the three import columns) with no outbox row,
 *     no audit row and no event; skipped files are named in the note and
 *     never reserved when the source declares them oversize; a resume writes
 *     and fetches nothing, and does not report the note as a source change;
 *     the window summary and its event count the attached files;
 *   - a transient file failure fails the ticket and keeps its pending row,
 *     and the next run reuses that row and attaches the file, without
 *     fetching an attached file again; a file already attached is not
 *     duplicated when the source sends it again;
 *   - a crash after the put leaves a pending row and its object; a later
 *     pass attaches it, or, past the grace, the reaper deletes both and a
 *     later pass reserves again;
 *   - a live comment cannot claim an import reservation, and an import
 *     cannot claim a live upload;
 *   - no S3: refused before anything is written;
 *   - RLS: the reservation cannot reach another org's ticket, a forged row
 *     for it is 42501, and the shape CHECK holds;
 *   - the reservation locks the ticket first: no deadlock against a
 *     ticket-first writer (the ticketChildLockOrder shape);
 *   - the byte bucket's Lua script against real Redis;
 *   - a summary frozen before W1 publishes attachmentsImported 0.
 */
import './setup';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const queued = vi.hoisted(() => [] as Array<{ type: string; ticketId: string }>);
const audited = vi.hoisted(() => [] as Array<{ action: string; resourceId?: string | null }>);
const published = vi.hoisted(() => [] as Array<{ type: string; orgId: string; payload: Record<string, unknown> }>);
const chargeHook = vi.hoisted(() => ({ costs: [] as number[], before: null as null | ((call: number) => Promise<void>) }));
const s3 = vi.hoisted(() => ({
  configured: true,
  objects: new Map<string, { body: Buffer; contentType: string; sha256: string }>(),
  puts: [] as string[],
  deleted: [] as string[],
}));

vi.mock('../../services/s3Storage', async (orig) => ({
  ...(await orig<typeof import('../../services/s3Storage')>()),
  isS3Configured: () => s3.configured,
  putObjectBuffer: async (key: string, body: Buffer, contentType: string, sha256: string) => {
    s3.puts.push(key);
    s3.objects.set(key, { body: Buffer.from(body), contentType, sha256 });
  },
  deleteObjects: async (keys: readonly string[]) => {
    for (const key of keys) {
      s3.deleted.push(key);
      s3.objects.delete(key);
    }
  },
}));
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
vi.mock('../../services/eventBus', async (orig) => ({
  ...(await orig<typeof import('../../services/eventBus')>()),
  publishEvent: async (type: string, orgId: string, payload: Record<string, unknown>, _source: string, options?: { eventId?: string }) => {
    published.push({ type, orgId, payload });
    return options?.eventId ?? 'evt';
  },
}));
vi.mock('../../services/ticketImport/throughput', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketImport/throughput')>();
  return {
    ...actual,
    chargeWindowThroughput: async (window: { id: string; writesPerHour: number }, cost: number) => {
      chargeHook.costs.push(cost);
      if (chargeHook.before) await chargeHook.before(chargeHook.costs.length);
      return actual.chargeWindowThroughput(window, cost);
    },
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  auditLogs,
  migrationWindows,
  partnerServicePrincipals,
  ticketAttachments,
  ticketComments,
  ticketExternalRefs,
  ticketOutbox,
  tickets,
  users,
} from '../../db/schema';
import { reapPendingAttachments } from '../../jobs/ticketAttachmentReaper';
import { closeMigrationWindow, getMigrationWindow, openMigrationWindow, publishPendingWindowSummaries } from '../../services/migrationWindows';
import { getRedis } from '../../services/redis';
import { reserveImportAttachments } from '../../services/ticketImport/importAttachments';
import { ImportAttachmentFetchError, importTicket } from '../../services/ticketImport/importWriter';
import type { ImportedTicket } from '../../services/ticketImport/importedTicket';
import { chargeWindowBytes, migrationWindowBytesKey, migrationWindowRateKey } from '../../services/ticketImport/throughput';
import { lockOpenWindowForWrite, windowWriteContext } from '../../services/ticketImport/windowLock';
import { addTicketComment, type TicketActor } from '../../services/ticketService';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY = 86_400_000;
const MIB = 1024 * 1024;
const CASE_TIMEOUT = 60_000;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

const T0 = new Date('2021-03-04T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 9)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300, 5)]);

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
  return { partner, orgA, orgB, orgOutside, owner, principal: principal!, ownerContext };
}

type Fx = Awaited<ReturnType<typeof seed>>;

async function openWindow(fx: Fx) {
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
  }));
}

async function closeWindow(fx: Fx, windowId: string) {
  await withSystemDbAccessContext(() => db.transaction((tx) => closeMigrationWindow(tx, {
    windowId, partnerId: fx.partner.id, reason: 'closed_by_admin', closedBy: fx.owner.id,
  })));
}

function descriptorOf(fx: Fx, windowId: string) {
  return { id: windowId, partnerId: fx.partner.id, principalId: fx.principal.id, writesPerHour: 6000, orgIds: [fx.orgA.id, fx.orgB.id].sort() };
}

type File = NonNullable<ImportedTicket['comments'][number]['attachments']>[number];
const file = (sourceId: string, filename: string, declaredBytes?: number, inline = false): File => ({
  sourceId, filename, inline, ...(declaredBytes !== undefined ? { declaredBytes } : {}),
});

function comment(sourceId: string, at: number, content: string, attachments?: File[]): ImportedTicket['comments'][number] {
  return {
    sourceId, createdAt: minutes(at), isPublic: true,
    author: { kind: 'requester', name: 'Maya Customer', email: 'maya@customer.example' },
    content,
    ...(attachments ? { attachments } : {}),
  };
}

function source(fx: Fx, comments: ImportedTicket['comments']): ImportedTicket {
  return {
    sourceId: uniq('zammad-ticket'),
    orgId: fx.orgA.id,
    createdAt: T0,
    updatedAt: minutes(300),
    subject: 'Scanner output is garbled',
    description: 'See the attached samples.',
    priority: 'normal',
    source: 'email',
    requester: { name: 'Maya Customer', email: 'maya@customer.example' },
    finalStatus: 'open',
    comments,
  };
}

/** The module's fetchAttachment over `bytes`; an unknown id is gone from the source. */
function fetcher(bytes: Record<string, Buffer | Error>) {
  return vi.fn(async (sourceId: string, _maxBytes: number): Promise<Uint8Array> => {
    const value = bytes[sourceId];
    if (value instanceof Error) throw value;
    if (!value) throw new ImportAttachmentFetchError('not_found');
    return value;
  });
}

const attachmentsOf = (ticketId: string) => getTestDb().select().from(ticketAttachments)
  .where(eq(ticketAttachments.ticketId, ticketId)).orderBy(ticketAttachments.importSourceId);
const bySource = (principalId: string, sourceId: string) => getTestDb().select().from(ticketAttachments)
  .where(and(eq(ticketAttachments.originPrincipalId, principalId), eq(ticketAttachments.importSourceId, sourceId)));
const commentsOf = (ticketId: string) => getTestDb().select().from(ticketComments)
  .where(eq(ticketComments.ticketId, ticketId)).orderBy(ticketComments.createdAt);

/** Moves an imported ticket and its org-stamped children to the org outside the window (as a ticket org move would). */
async function moveOutside(fx: Fx, ticketId: string) {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    await tx.update(tickets).set({ orgId: fx.orgOutside.id }).where(eq(tickets.id, ticketId));
    await tx.update(ticketExternalRefs).set({ orgId: fx.orgOutside.id }).where(eq(ticketExternalRefs.ticketId, ticketId));
    await tx.update(ticketAttachments).set({ orgId: fx.orgOutside.id }).where(eq(ticketAttachments.ticketId, ticketId));
  });
}

async function bucketSize(windowId: string): Promise<number> {
  return Number(await getRedis()!.zcard(migrationWindowRateKey(windowId)));
}

describe('ticket import attachments (real Postgres and Redis, as breeze_app)', () => {
  beforeEach(() => {
    queued.length = 0;
    audited.length = 0;
    published.length = 0;
    chargeHook.costs.length = 0;
    chargeHook.before = null;
    s3.configured = true;
    s3.objects.clear();
    s3.puts.length = 0;
    s3.deleted.length = 0;
    delete process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR;
  });
  afterEach(() => {
    chargeHook.before = null;
    delete process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR;
  });

  runDb('a round trip attaches the files with their real metadata and the source time, and produces no outbox row, audit row or event', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, [
      comment('a1', 10, 'Samples attached.', [
        file('f-png', 'scan.png', PNG.length),
        file('f-zip', 'logs.zip', ZIP.length),
        file('f-exe', 'driver.EXE.', 300),
        file('f-big', 'video.mp4', 11 * MIB),
        file('f-gone', 'old.pdf', 1000),
      ]),
      comment('a2', 20, 'Inline screenshot.', [file('f-inline', 'image001.png', PNG2.length, true)]),
      comment('a3', 30, 'No files here.'),
    ]);
    const fetchAttachment = fetcher({ 'f-png': PNG, 'f-zip': ZIP, 'f-inline': PNG2 });

    const result = await importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment });

    expect(result).toMatchObject({
      outcome: 'created',
      commentsWritten: 3,
      attachmentsWritten: 3,
      attachmentBytes: PNG.length + ZIP.length + PNG2.length,
      attachmentsSkipped: [
        { sourceId: 'f-exe', reason: 'blocked_type' },
        { sourceId: 'f-big', reason: 'too_large' },
        { sourceId: 'f-gone', reason: 'not_found' },
      ],
    });
    // A declared-oversize or denylisted file is never fetched (nor reserved: see the units below).
    expect(fetchAttachment.mock.calls).toEqual([['f-png', 10 * MIB], ['f-zip', 10 * MIB], ['f-gone', 10 * MIB], ['f-inline', 10 * MIB]]);

    const feed = await commentsOf(result.ticketId);
    const a1 = feed.find((c) => c.importSourceId === 'a1')!;
    const a2 = feed.find((c) => c.importSourceId === 'a2')!;
    expect(a1.content).toBe('Samples attached.\n\n[Attachments not imported: driver.EXE. (blocked file type); video.mp4 (over the 10 MB limit); old.pdf (not found in the source)]');
    expect(a2.content).toBe('Inline screenshot.');

    const rows = await attachmentsOf(result.ticketId);
    expect(rows.map((r) => r.importSourceId)).toEqual(['f-inline', 'f-png', 'f-zip']);
    for (const row of rows) {
      expect(row).toMatchObject({
        orgId: fx.orgA.id,
        uploadedByUserId: null,
        originPrincipalId: fx.principal.id,
        migrationWindowId: window.id,
        storageBackend: 's3',
        storageKey: `ticket-attachments/${row.id}`,
        data: null,
        artifactId: null,
      });
    }
    const [inline, png, zip] = rows;
    expect(png).toMatchObject({ commentId: a1.id, contentType: 'image/png', byteSize: PNG.length, sha256: sha(PNG), originalFilename: 'scan.png', createdAt: minutes(10), attachedAt: minutes(10) });
    expect(zip).toMatchObject({ commentId: a1.id, contentType: 'application/octet-stream', byteSize: ZIP.length, sha256: sha(ZIP), originalFilename: 'logs.zip' });
    expect(inline).toMatchObject({ commentId: a2.id, contentType: 'image/png', byteSize: PNG2.length, createdAt: minutes(20), attachedAt: minutes(20) });
    // The objects are the original bytes, at the reserved keys, with their digests.
    for (const [row, bytes] of [[png!, PNG], [zip!, ZIP], [inline!, PNG2]] as const) {
      expect(s3.objects.get(row.storageKey!)).toEqual({ body: bytes, contentType: row.contentType, sha256: sha(bytes) });
    }
    // Neither the skipped files nor the deleted reservation of f-gone left a row.
    expect(await bySource(fx.principal.id, 'f-gone')).toEqual([]);
    expect(await bySource(fx.principal.id, 'f-big')).toEqual([]);
    expect(await bySource(fx.principal.id, 'f-exe')).toEqual([]);

    // Spec §4.5: header 2 (create, ref); the reservation of the four fetchable files, one unit each; the chunk 3 + 1 status.
    expect(chargeHook.costs).toEqual([2, 4, 4]);
    expect(await bucketSize(window.id)).toBe(10);
    expect(await getRedis()!.hexists(migrationWindowBytesKey(window.id), 'tokens')).toBe(1);

    // No side effect beyond the rows.
    expect(await getTestDb().select().from(ticketOutbox).where(eq(ticketOutbox.ticketId, result.ticketId))).toEqual([]);
    expect(queued.filter((e) => e.ticketId === result.ticketId)).toEqual([]);
    expect(audited.filter((a) => a.resourceId === result.ticketId)).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await getTestDb().select().from(auditLogs).where(eq(auditLogs.resourceId, result.ticketId))).toEqual([]);

    // A resume finds everything imported: nothing fetched, charged or written,
    // and the note is not a change in the source.
    fetchAttachment.mockClear();
    const again = await importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment });
    expect(again).toMatchObject({ outcome: 'resumed', commentsWritten: 0, commentsSkipped: 3, attachmentsWritten: 0, attachmentsSkipped: [], commentsChangedInSource: [] });
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(await bucketSize(window.id)).toBe(10);
    expect(await attachmentsOf(result.ticketId)).toHaveLength(3);

    // The window counts the attached files per org, and its event carries them.
    await closeWindow(fx, window.id);
    const [closed] = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.id, window.id));
    expect(closed!.summary).toMatchObject({ ticketsImported: 1, commentsImported: 3, attachmentsImported: 3 });
    expect(closed!.summary!.orgs.find((o) => o.orgId === fx.orgA.id)).toMatchObject({ attachmentsImported: 3 });
    await publishPendingWindowSummaries();
    const events = published.filter((e) => e.payload.windowId === window.id);
    expect(events.find((e) => e.orgId === fx.orgA.id)!.payload).toMatchObject({ attachmentsImported: 3 });
    expect(events.find((e) => e.orgId === fx.orgB.id)!.payload).toMatchObject({ attachmentsImported: 0 });
  }, CASE_TIMEOUT);

  runDb('a transient failure fails the ticket and keeps its pending row; the next run reuses it, and never fetches an attached file again', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, [
      comment('c1', 10, 'First.', [file('f1', 'one.png', PNG.length)]),
      comment('c2', 20, 'Second.', [file('f2', 'two.zip', ZIP.length)]),
    ]);
    const flaky = fetcher({ f1: PNG, f2: new Error('ETIMEDOUT') });
    await expect(importTicket(window.id, ticket, { partnerId: fx.partner.id, chunkSize: 1, fetchAttachment: flaky }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE', status: 503, details: { attachmentSourceId: 'f2', stage: 'fetch' } });

    const [ref] = await getTestDb().select().from(ticketExternalRefs).where(eq(ticketExternalRefs.externalId, ticket.sourceId));
    const ticketId = ref!.ticketId;
    // c1 and its file are in; c2 is not, and f2 waits as a reservation with provisional metadata.
    expect((await commentsOf(ticketId)).filter((c) => c.importSourceId).map((c) => c.importSourceId)).toEqual(['c1']);
    const [pending] = await bySource(fx.principal.id, 'f2');
    expect(pending).toMatchObject({
      ticketId, commentId: null, attachedAt: null, uploadedByUserId: null, storageBackend: 's3',
      contentType: 'application/octet-stream', sha256: '0'.repeat(64), byteSize: ZIP.length, migrationWindowId: window.id,
    });
    // Never historic, or the reaper would take it at once.
    expect(Date.now() - pending!.createdAt.getTime()).toBeLessThan(60_000);
    const [f1Before] = await bySource(fx.principal.id, 'f1');

    const healed = fetcher({ f1: PNG, f2: ZIP });
    const result = await importTicket(window.id, ticket, { partnerId: fx.partner.id, chunkSize: 1, fetchAttachment: healed });
    expect(result).toMatchObject({ outcome: 'resumed', commentsWritten: 1, commentsSkipped: 1, attachmentsWritten: 1, attachmentBytes: ZIP.length });
    expect(healed.mock.calls.map((c) => c[0])).toEqual(['f2']);
    const [f2] = await bySource(fx.principal.id, 'f2');
    expect(f2).toMatchObject({ id: pending!.id, contentType: 'application/octet-stream', byteSize: ZIP.length, sha256: sha(ZIP), createdAt: minutes(20) });
    expect(f2!.commentId).not.toBeNull();
    expect(await bySource(fx.principal.id, 'f1')).toEqual([f1Before]);

    // Another source ticket sends the attached f1 again (an id the source
    // reused, or an article a merge in the source moved): it is not
    // reserved, fetched or duplicated; the comment's own new file is.
    const other = source(fx, [comment('c9', 30, 'Again.', [file('f1', 'one.png', PNG.length), file('f4', 'four.png', PNG2.length)])]);
    const third = fetcher({ f1: PNG, f4: PNG2 });
    const after = await importTicket(window.id, other, { partnerId: fx.partner.id, fetchAttachment: third });
    expect(after).toMatchObject({ outcome: 'created', commentsWritten: 1, attachmentsWritten: 1, attachmentsSkipped: [] });
    expect(third.mock.calls.map((c) => c[0])).toEqual(['f4']);
    expect(await bySource(fx.principal.id, 'f1')).toEqual([f1Before]);
    expect((await attachmentsOf(after.ticketId)).map((r) => r.importSourceId)).toEqual(['f4']);
    expect((await attachmentsOf(ticketId)).map((r) => r.importSourceId)).toEqual(['f1', 'f2']);
  }, CASE_TIMEOUT);

  runDb('a crash after the put leaves a pending row and its object, which a later pass attaches', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, [comment('c1', 10, 'Crash test.', [file('f1', 'one.png', PNG.length)])]);
    // Header (1st charge), reservation (2nd), then the process dies before the chunk transaction (3rd).
    chargeHook.before = async (call) => {
      if (call === 3) throw new Error('simulated crash');
    };
    await expect(importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: PNG }) })).rejects.toThrow('simulated crash');
    chargeHook.before = null;
    const [pending] = await bySource(fx.principal.id, 'f1');
    expect(pending).toMatchObject({ commentId: null, contentType: 'application/octet-stream' });
    expect(s3.objects.get(pending!.storageKey!)?.body).toEqual(PNG);

    const result = await importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: PNG }) });
    expect(result).toMatchObject({ outcome: 'resumed', commentsWritten: 1, attachmentsWritten: 1 });
    const [attached] = await bySource(fx.principal.id, 'f1');
    expect(attached).toMatchObject({ id: pending!.id, storageKey: pending!.storageKey, contentType: 'image/png', sha256: sha(PNG) });
    expect(attached!.commentId).not.toBeNull();
    // The re-put overwrote the same key: one object.
    expect(s3.puts.filter((k) => k === pending!.storageKey)).toHaveLength(2);
    // An attached row is never reaped.
    await getTestDb().update(ticketAttachments).set({ createdAt: new Date(Date.now() - 2 * DAY) }).where(eq(ticketAttachments.id, attached!.id));
    await reapPendingAttachments();
    expect(await bySource(fx.principal.id, 'f1')).toHaveLength(1);
  }, CASE_TIMEOUT);

  runDb('past the grace the reaper deletes a crashed reservation and its object, and a later pass reserves again', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, [comment('c1', 10, 'Crash test.', [file('f1', 'one.png', PNG.length)])]);
    chargeHook.before = async (call) => {
      if (call === 3) throw new Error('simulated crash');
    };
    await expect(importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: PNG }) })).rejects.toThrow('simulated crash');
    chargeHook.before = null;
    const [pending] = await bySource(fx.principal.id, 'f1');
    await getTestDb().update(ticketAttachments).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(ticketAttachments.id, pending!.id));

    expect(await reapPendingAttachments()).toBeGreaterThanOrEqual(1);
    expect(await bySource(fx.principal.id, 'f1')).toEqual([]);
    expect(s3.deleted).toContain(pending!.storageKey);
    expect(s3.objects.has(pending!.storageKey!)).toBe(false);

    const result = await importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: PNG }) });
    expect(result).toMatchObject({ commentsWritten: 1, attachmentsWritten: 1 });
    const [again] = await bySource(fx.principal.id, 'f1');
    expect(again!.id).not.toBe(pending!.id);
    expect(again!.commentId).not.toBeNull();
    expect(s3.objects.get(again!.storageKey!)?.body).toEqual(PNG);
  }, CASE_TIMEOUT);

  runDb('a live comment cannot claim an import reservation, and an import cannot claim a live upload', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, [comment('c1', 10, 'Pending.', [file('f1', 'one.png', PNG.length)])]);
    await expect(importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: new Error('503') }) }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE' });
    const [reservation] = await bySource(fx.principal.id, 'f1');
    const ticketId = reservation!.ticketId;

    // A technician's live comment names the import reservation: refused, and rolled back.
    const technician: TicketActor = { kind: 'user', userId: fx.owner.id, name: 'Owner' };
    await expect(withDbAccessContext(fx.ownerContext(), () => addTicketComment(ticketId, { content: 'claiming it', isPublic: false, attachmentIds: [reservation!.id] }, technician)))
      .rejects.toMatchObject({ status: 409, code: 'ATTACHMENT_NOT_CLAIMABLE' });
    expect((await commentsOf(ticketId)).some((c) => c.content === 'claiming it')).toBe(false);
    expect((await bySource(fx.principal.id, 'f1'))[0]).toMatchObject({ commentId: null, uploadedByUserId: null });

    // The technician's own pending upload, named by an import comment: refused.
    const [upload] = await getTestDb().insert(ticketAttachments).values({
      orgId: fx.orgA.id, ticketId, uploadedByUserId: fx.owner.id, storageBackend: 'db', data: PNG,
      contentType: 'image/png', byteSize: PNG.length, originalFilename: 'mine.png', sha256: sha(PNG),
    }).returning();
    const principal: TicketActor = { kind: 'service_principal', principalId: fx.principal.id, keyId: null, name: 'Zammad import' };
    await expect(withDbAccessContext(windowWriteContext(descriptorOf(fx, window.id)), async () => {
      const open = await lockOpenWindowForWrite(window.id, fx.orgA.id);
      return addTicketComment(ticketId, {
        content: 'import claims a live upload',
        isPublic: false,
        imported: {
          sourceId: uniq('article'),
          author: { kind: 'staff', name: 'Former Agent' },
          attachments: [{ id: upload!.id, contentType: 'image/png', byteSize: PNG.length, sha256: sha(PNG) }],
        },
      }, principal, { kind: 'import', window: open, at: minutes(40) });
    })).rejects.toMatchObject({ status: 409, code: 'ATTACHMENT_NOT_CLAIMABLE' });
    const [still] = await getTestDb().select().from(ticketAttachments).where(eq(ticketAttachments.id, upload!.id));
    expect(still).toMatchObject({ commentId: null, uploadedByUserId: fx.owner.id, originPrincipalId: null, importSourceId: null });

    // The live claim still works for the technician's own upload.
    const live = await withDbAccessContext(fx.ownerContext(), () => addTicketComment(ticketId, { content: 'my photo', isPublic: false, attachmentIds: [upload!.id] }, technician));
    expect(live.attachments).toHaveLength(1);
  }, CASE_TIMEOUT);

  runDb('with no object storage a ticket with files is refused before anything is written', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    s3.configured = false;
    const ticket = source(fx, [comment('c1', 10, 'Files.', [file('f1', 'one.png', PNG.length)])]);
    const fetchAttachment = fetcher({ f1: PNG });
    await expect(importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED', status: 409 });
    expect(await getTestDb().select().from(ticketExternalRefs).where(eq(ticketExternalRefs.externalId, ticket.sourceId))).toEqual([]);
    expect(await bySource(fx.principal.id, 'f1')).toEqual([]);
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(chargeHook.costs).toEqual([]);
    // Without files, the same window imports on the db backend as before.
    await expect(importTicket(window.id, source(fx, [comment('c2', 10, 'No files.')]), { partnerId: fx.partner.id })).resolves.toMatchObject({ outcome: 'created' });
  }, CASE_TIMEOUT);

  runDb("RLS: the reservation cannot reach another org's ticket, a forged import row for it is 42501, and the shape CHECK holds", async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const admin = getTestDb();
    const [inWindow] = await admin.insert(tickets).values({ orgId: fx.orgA.id, partnerId: fx.partner.id, subject: 'in window', source: 'api', priority: 'normal', ticketNumber: uniq('IW'), migrationWindowId: window.id }).returning();
    const [outside] = await admin.insert(tickets).values({ orgId: fx.orgOutside.id, partnerId: fx.partner.id, subject: 'outside', source: 'api', priority: 'normal', ticketNumber: uniq('OUT'), migrationWindowId: window.id }).returning();
    const context = windowWriteContext(descriptorOf(fx, window.id));

    await expect(withDbAccessContext(context, () => reserveImportAttachments({
      ticketId: outside!.id, windowId: window.id, principalId: fx.principal.id, files: [{ sourceId: 'x1', filename: 'a.png', declaredBytes: 10 }],
    }))).rejects.toThrow(/not visible to its window/);
    // Positive control: the same statement on the window's ticket reserves.
    const reserved = await withDbAccessContext(context, () => reserveImportAttachments({
      ticketId: inWindow!.id, windowId: window.id, principalId: fx.principal.id, files: [{ sourceId: 'x1', filename: 'a.png', declaredBytes: 10 }],
    }));
    expect(reserved).toEqual([{ id: expect.any(String), sourceId: 'x1', inserted: true }]);

    const forged = (ticketId: string, orgId: string, sourceId: string) => {
      const id = crypto.randomUUID();
      return {
        id, orgId, ticketId, storageBackend: 's3' as const, storageKey: `ticket-attachments/${id}`, contentType: 'application/octet-stream',
        byteSize: 1, originalFilename: 'f', sha256: '0'.repeat(64), migrationWindowId: window.id, originPrincipalId: fx.principal.id, importSourceId: sourceId,
      };
    };
    const forge = await withDbAccessContext(context, () => db.insert(ticketAttachments).values(forged(outside!.id, fx.orgOutside.id, 'x2'))).catch((e: unknown) => e);
    expect((forge as { cause?: { code?: string }; code?: string }).cause?.code ?? (forge as { code?: string }).code).toBe('42501');
    await withDbAccessContext(context, () => db.insert(ticketAttachments).values(forged(inWindow!.id, fx.orgA.id, 'x3')));

    // ticket_attachments_import_shape_chk (validated): an import row has no
    // uploader, has its window, lives in s3; a source id needs a principal.
    const bad = async (overrides: Record<string, unknown>) => {
      const err = await admin.insert(ticketAttachments).values({ ...forged(inWindow!.id, fx.orgA.id, uniq('bad')), ...overrides } as never).catch((e: unknown) => e);
      const pg = err as { cause?: { code?: string; constraint_name?: string }; code?: string; constraint_name?: string };
      return [pg.cause?.code ?? pg.code, pg.cause?.constraint_name ?? pg.constraint_name];
    };
    expect(await bad({ uploadedByUserId: fx.owner.id })).toEqual(['23514', 'ticket_attachments_import_shape_chk']);
    expect(await bad({ migrationWindowId: null })).toEqual(['23514', 'ticket_attachments_import_shape_chk']);
    expect(await bad({ originPrincipalId: null })).toEqual(['23514', 'ticket_attachments_import_shape_chk']);
    expect(await bad({ storageBackend: 'db', storageKey: null, data: PNG })).toEqual(['23514', 'ticket_attachments_import_shape_chk']);
    const [check] = (await admin.execute(sql`
      SELECT convalidated FROM pg_constraint WHERE conname = 'ticket_attachments_import_shape_chk'
    `)) as unknown as Array<{ convalidated: boolean }>;
    expect(check?.convalidated).toBe(true);
    // The resume key: one row per (principal, source id).
    const dup = await admin.insert(ticketAttachments).values(forged(inWindow!.id, fx.orgA.id, 'x3')).catch((e: unknown) => e);
    expect((dup as { cause?: { code?: string } }).cause?.code ?? (dup as { code?: string }).code).toBe('23505');
  }, CASE_TIMEOUT);

  runDb("a resume key held by a pending reservation in an org outside the window is present elsewhere, not a 42501", async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    // A pass leaves f1 pending on its ticket (a transient failure), then the
    // ticket is moved to an org outside the window.
    const first = source(fx, [comment('c1', 10, 'First.', [file('f1', 'one.png', PNG.length)])]);
    await expect(importTicket(window.id, first, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: new Error('503') }) }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE' });
    const [pending] = await bySource(fx.principal.id, 'f1');
    await moveOutside(fx, pending!.ticketId);
    const [outside] = await bySource(fx.principal.id, 'f1');
    expect(outside).toMatchObject({ orgId: fx.orgOutside.id, commentId: null });

    // The source moved that article to another ticket of a window org.
    const moved = source(fx, [comment('c9', 20, 'Moved here.', [file('f1', 'one.png', PNG.length), file('f2', 'two.png', PNG2.length)])]);
    const fetchAttachment = fetcher({ f1: PNG, f2: PNG2 });
    const result = await importTicket(window.id, moved, { partnerId: fx.partner.id, fetchAttachment });
    expect(result).toMatchObject({ outcome: 'created', commentsWritten: 1, attachmentsWritten: 1 });
    expect(fetchAttachment.mock.calls.map((c) => c[0])).toEqual(['f2']);
    // The reservation outside the window is untouched (the reaper owns it).
    expect(await bySource(fx.principal.id, 'f1')).toEqual([outside]);
    expect((await attachmentsOf(result.ticketId)).map((r) => r.importSourceId)).toEqual(['f2']);
  }, CASE_TIMEOUT);

  runDb('a comment and its file imported on a ticket now outside the window (a cross-org source merge) are skipped, not a 42501', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const article = comment('c1', 10, 'Merged article.', [file('f1', 'one.png', PNG.length)]);
    const original = await importTicket(window.id, source(fx, [article]), { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: PNG }) });
    expect(original).toMatchObject({ attachmentsWritten: 1 });
    await moveOutside(fx, original.ticketId);

    // The survivor in the source now carries the article; its ticket is new here.
    const fetchAttachment = fetcher({ f1: PNG });
    const survivor = await importTicket(window.id, source(fx, [article]), { partnerId: fx.partner.id, fetchAttachment });
    expect(survivor).toMatchObject({ outcome: 'created', commentsWritten: 0, commentsSkipped: 1, attachmentsWritten: 0 });
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(await bySource(fx.principal.id, 'f1')).toHaveLength(1);
    expect(await attachmentsOf(survivor.ticketId)).toEqual([]);
  }, CASE_TIMEOUT);

  runDb('the reservation locks the ticket first: no deadlock against a ticket-first writer', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    const ticket = source(fx, [comment('c1', 10, 'Lock order.', [file('f1', 'one.png', PNG.length)])]);
    await expect(importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: new Error('503') }) }))
      .rejects.toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE' });
    const [pending] = await bySource(fx.principal.id, 'f1');
    const ticketId = pending!.ticketId;

    // B holds the ticket row; A (the resume) reserves f1 again, which re-points
    // its pending row. B, once A is blocked, writes that child row and commits.
    // A reservation that took the child row before the ticket would deadlock.
    let holderPid = 0;
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    let go!: () => void;
    const goP = new Promise<void>((r) => { go = r; });
    const b = getTestDb().transaction(async (tx) => {
      const [pid] = (await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as Array<{ pid: number }>;
      holderPid = pid!.pid;
      await tx.execute(sql`SELECT id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`);
      locked();
      await goP;
      await tx.execute(sql`UPDATE ticket_attachments SET ticket_id = ticket_id WHERE id = ${pending!.id}::uuid`);
    });
    await lockedP;
    const a = importTicket(window.id, ticket, { partnerId: fx.partner.id, fetchAttachment: fetcher({ f1: PNG }) });
    a.catch(() => undefined);
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = (await getTestDb().execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
        `)) as unknown as Array<{ n: number }>;
        if ((row?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('the reservation never waited on the ticket row');
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      go();
    }
    const [aRes, bRes] = await Promise.allSettled([a, b]);
    expect([aRes.status, bRes.status]).toEqual(['fulfilled', 'fulfilled']);
    expect(aRes.status === 'fulfilled' && aRes.value).toMatchObject({ commentsWritten: 1, attachmentsWritten: 1 });
    const [attached] = await bySource(fx.principal.id, 'f1');
    expect(attached).toMatchObject({ id: pending!.id });
    expect(attached!.commentId).not.toBeNull();
  }, CASE_TIMEOUT);

  runDb('the byte bucket admits up to an hour of bytes, then refuses with when to retry (Lua on real Redis)', async () => {
    process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR = String(10 * MIB);
    const window = { id: crypto.randomUUID() };
    await chargeWindowBytes(window, 10 * MIB);
    const refusal = await chargeWindowBytes(window, MIB).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'MIGRATION_WINDOW_RATE_LIMITED', status: 429, details: { kind: 'bytes', bytesPerHour: 10 * MIB } });
    // 1 MiB at 10 MiB an hour: about six minutes.
    const retry = (refusal as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    expect(retry).toBeGreaterThan(300);
    expect(retry).toBeLessThanOrEqual(361);
    // A refusal takes nothing: the bucket still holds what it had.
    const tokens = Number(await getRedis()!.hget(migrationWindowBytesKey(window.id), 'tokens'));
    expect(tokens).toBeLessThan(MIB);
    expect(await getRedis()!.pttl(migrationWindowBytesKey(window.id))).toBeGreaterThan(3_600_000);
    // Another window's bucket is its own.
    await expect(chargeWindowBytes({ id: crypto.randomUUID() }, 10 * MIB)).resolves.toBeUndefined();
  });

  runDb('a summary frozen before W1 reads and publishes attachmentsImported 0', async () => {
    const fx = await seed();
    const window = await openWindow(fx);
    await closeWindow(fx, window.id);
    // Drop the field, as a window closed before W1 stored it.
    await getTestDb().execute(sql`
      UPDATE migration_windows
         SET summary = jsonb_set(summary - 'attachmentsImported', '{orgs}',
               (SELECT jsonb_agg(o - 'attachmentsImported') FROM jsonb_array_elements(summary->'orgs') o))
       WHERE id = ${window.id}::uuid
    `);
    const view = await withDbAccessContext(fx.ownerContext(), () => getMigrationWindow(fx.partner.id, window.id));
    expect(view!.counts).toMatchObject({ attachmentsImported: 0 });
    expect(view!.counts.orgs.every((o) => o.attachmentsImported === 0)).toBe(true);
    await publishPendingWindowSummaries();
    const events = published.filter((e) => e.payload.windowId === window.id);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.payload.attachmentsImported === 0)).toBe(true);
  }, CASE_TIMEOUT);
});
