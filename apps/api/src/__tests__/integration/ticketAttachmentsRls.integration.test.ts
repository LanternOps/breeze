/**
 * ticket_attachments — RLS, org-move re-stamp, erasure order and db-backend
 * round-trip against real Postgres (W08 #3902).
 *
 * Migration under test: 2026-09-25-ticket-attachments.sql
 *
 * Shape 1 (direct org_id, RLS auto-discovered by rls-coverage). Everything
 * here runs through the REAL postgres.js driver as `breeze_app`
 * (rolbypassrls = false), so the policies are genuinely enforced; the mocked
 * unit suites prove statement SHAPE, this one proves Postgres agrees.
 *
 * Proves:
 *   1. cross-org INSERT forge raises 42501 — WITH the same-org positive
 *      control succeeding in the same test, so a malformed statement cannot
 *      masquerade as a passing isolation check.
 *   2. org A cannot SELECT an org-B attachment row (zero rows, not an error).
 *   3. portal isolation: the portal's app-layer filter (public, non-deleted
 *      parent comment) hides an internal-comment attachment and shows a
 *      public one; a pending row is invisible to both.
 *   4. moveTicketOrg re-stamps ticket_attachments.org_id.
 *   5. the device move-org rewrite (UPDATE ... WHERE ticket_id IN (SELECT id
 *      FROM tickets WHERE device_id = ...)) actually moves the row.
 *   6. org erasure deletes attachment OBJECTS before rows, and aborts
 *      rerunnably (rows intact) when the object store faults.
 *   7. with S3 unconfigured the `db` backend round-trips a byte-identical
 *      buffer through put -> insert -> claim -> openBytes.
 *   8. the portal DB-context precondition from Task 12: a portal-shaped
 *      withDbAccessContext({ scope: 'organization', orgId }) can read
 *      ticket_attachments. If this ever fails, the portal reads must move to
 *      a system context behind the app-layer filters — never the reverse.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, tickets, ticketComments } from '../../db/schema';
import { ticketAttachments, ATTACHMENT_META_COLUMNS } from '../../db/schema/ticketAttachments';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

// s3Storage is stubbed only at its object-delete primitive so the erasure
// pre-clear can be observed and faulted without a bucket. isS3Configured stays
// REAL — .env.test sets no S3 vars, which is exactly the self-hosted `db`
// backend the round-trip test below needs.
const { deleteObjectsMock } = vi.hoisted(() => ({ deleteObjectsMock: vi.fn(async () => undefined) }));
vi.mock('../../services/s3Storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/s3Storage')>()),
  deleteObjects: deleteObjectsMock,
}));

import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { addTicketComment, moveTicketOrg } from '../../services/ticketService';
import { openBytes, putBytes, selectBackend } from '../../services/ticketAttachmentStorage';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SHA = (seed: string) => seed.padEnd(64, '0').slice(0, 64);

/** Buffer covering every byte value — catches any bytea escaping mangling. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]);

function orgContext(orgId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

/**
 * Returns the postgres.js cause on an RLS rejection, or undefined when the
 * call unexpectedly succeeded (which is an isolation hole, not a pass).
 */
async function captureRlsCause(fn: () => Promise<unknown>) {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  deviceId: string;
  ticketA: string;
  ticketB: string;
}

/** partner P -> orgA + orgB, one device + one ticket in each org. */
async function seed(): Promise<Fixture> {
  const adminDb = getTestDb() as never as {
    insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<Array<{ id: string }>> } };
  };
  const unique = uid();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: null, email: `att-${unique}@example.test` });
  const siteA = await createSite({ orgId: orgA.id });

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `att-device-${unique}`,
    hostname: `att-host-${unique}`,
    osType: 'windows',
    osVersion: '10.0.19041',
    architecture: 'x64',
    agentVersion: '0.1.0',
  }).returning();

  const [ticketA] = await adminDb.insert(tickets).values({
    orgId: orgA.id,
    partnerId: partner.id,
    ticketNumber: `ATT-A-${unique}`,
    subject: 'attachment rls A',
    deviceId: device!.id,
    source: 'manual',
  }).returning();

  const [ticketB] = await adminDb.insert(tickets).values({
    orgId: orgB.id,
    partnerId: partner.id,
    ticketNumber: `ATT-B-${unique}`,
    subject: 'attachment rls B',
    source: 'manual',
  }).returning();

  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    deviceId: device!.id,
    ticketA: ticketA!.id,
    ticketB: ticketB!.id,
  };
}

/** Inserts an attachment row as the RLS-bypassing test superuser. */
async function seedAttachment(opts: {
  orgId: string;
  ticketId: string;
  commentId?: string | null;
  uploadedBy?: string | null;
  backend?: 's3' | 'db';
  storageKey?: string;
  filename?: string;
}): Promise<string> {
  const adminDb = getTestDb();
  const backend = opts.backend ?? 'db';
  const id = crypto.randomUUID();
  await adminDb.execute(sql`
    INSERT INTO ticket_attachments
      (id, org_id, ticket_id, comment_id, uploaded_by_user_id, storage_backend,
       storage_key, data, content_type, byte_size, original_filename, sha256, attached_at)
    VALUES (
      ${id}::uuid, ${opts.orgId}::uuid, ${opts.ticketId}::uuid,
      ${opts.commentId ?? null}, ${opts.uploadedBy ?? null},
      ${backend},
      ${backend === 's3' ? (opts.storageKey ?? `ticket-attachments/${id}`) : null},
      ${backend === 'db' ? PNG_BYTES : null},
      'image/png', ${PNG_BYTES.length}, ${opts.filename ?? 'shot.png'}, ${SHA(id.replace(/-/g, ''))},
      ${opts.commentId ? sql`now()` : sql`NULL`}
    )
  `);
  return id;
}

async function seedComment(ticketId: string, userId: string, isPublic: boolean, deleted = false): Promise<string> {
  const adminDb = getTestDb();
  const id = crypto.randomUUID();
  await adminDb.execute(sql`
    INSERT INTO ticket_comments (id, ticket_id, user_id, author_type, comment_type, content, is_public, deleted_at)
    VALUES (${id}::uuid, ${ticketId}::uuid, ${userId}::uuid, 'internal',
            ${isPublic ? 'comment' : 'internal'}, 'c', ${isPublic},
            ${deleted ? sql`now()` : sql`NULL`})
  `);
  return id;
}

beforeEach(() => {
  deleteObjectsMock.mockReset();
  deleteObjectsMock.mockResolvedValue(undefined);
});

describe('ticket_attachments RLS (real driver, breeze_app)', () => {
  it('rejects a cross-org forge with 42501 while the same-org control succeeds', async () => {
    const f = await seed();
    const ctxA = orgContext(f.orgA, f.userId);

    // POSITIVE CONTROL first: if this fails, the forge below proves nothing.
    const own = await withDbAccessContext(ctxA, () =>
      db.insert(ticketAttachments).values({
        orgId: f.orgA,
        ticketId: f.ticketA,
        uploadedByUserId: f.userId,
        storageBackend: 'db',
        data: PNG_BYTES,
        contentType: 'image/png',
        byteSize: PNG_BYTES.length,
        originalFilename: 'ok.png',
        sha256: SHA('control'),
      }).returning({ id: ticketAttachments.id })
    );
    expect(own).toHaveLength(1);

    const cause = await captureRlsCause(() =>
      withDbAccessContext(ctxA, () =>
        db.insert(ticketAttachments).values({
          orgId: f.orgB, // forged
          ticketId: f.ticketB,
          uploadedByUserId: f.userId,
          storageBackend: 'db',
          data: PNG_BYTES,
          contentType: 'image/png',
          byteSize: PNG_BYTES.length,
          originalFilename: 'forge.png',
          sha256: SHA('forge'),
        })
      )
    );
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/new row violates row-level security policy for table "ticket_attachments"/);
  });

  it('hides another org\'s attachment row from SELECT (zero rows, not an error)', async () => {
    const f = await seed();
    const attB = await seedAttachment({ orgId: f.orgB, ticketId: f.ticketB });

    const fromA = await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.select(ATTACHMENT_META_COLUMNS).from(ticketAttachments).where(eq(ticketAttachments.id, attB))
    );
    expect(fromA).toEqual([]);

    const fromB = await withDbAccessContext(orgContext(f.orgB, f.userId), () =>
      db.select(ATTACHMENT_META_COLUMNS).from(ticketAttachments).where(eq(ticketAttachments.id, attB))
    );
    expect(fromB).toHaveLength(1);
  });

  it('lets a portal-shaped organization context read its own rows (Task 12 precondition)', async () => {
    const f = await seed();
    const att = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA });

    // The portal wraps handlers in exactly this context shape. If this ever
    // returns zero rows the portal reads must move to a system context behind
    // the app-layer filters — never the other way round.
    const rows = await withDbAccessContext(orgContext(f.orgA, null), () =>
      db.select(ATTACHMENT_META_COLUMNS).from(ticketAttachments).where(eq(ticketAttachments.id, att))
    );
    expect(rows.map((r) => r.id)).toEqual([att]);
  });
});

describe('ticket_attachments portal visibility filter', () => {
  /** Mirrors routes/portal/tickets.ts: INNER JOIN + is_public + not deleted. */
  async function portalVisible(orgId: string, ticketId: string) {
    return withDbAccessContext(orgContext(orgId, null), () =>
      db
        .select({ id: ticketAttachments.id })
        .from(ticketAttachments)
        .innerJoin(ticketComments, eq(ticketComments.id, ticketAttachments.commentId))
        .where(and(
          eq(ticketAttachments.ticketId, ticketId),
          eq(ticketComments.isPublic, true),
          isNull(ticketComments.deletedAt)
        ))
    );
  }

  it('shows public-comment attachments and hides internal, deleted and pending ones', async () => {
    const f = await seed();
    const publicComment = await seedComment(f.ticketA, f.userId, true);
    const internalComment = await seedComment(f.ticketA, f.userId, false);
    const deletedComment = await seedComment(f.ticketA, f.userId, true, true);

    const visible = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: publicComment });
    await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: internalComment });
    await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: deletedComment });
    await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: null, uploadedBy: f.userId });

    const rows = await portalVisible(f.orgA, f.ticketA);
    expect(rows.map((r) => r.id)).toEqual([visible]);
  });
});

describe('ticket_attachments org re-stamp on move', () => {
  it('moveTicketOrg re-stamps org_id on the attachment row', async () => {
    const f = await seed();
    const att = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, uploadedBy: f.userId });

    await withSystemDbAccessContext(() => moveTicketOrg(f.ticketA, f.orgB, { userId: f.userId }));

    const [row] = await getTestDb().execute(sql`
      SELECT org_id FROM ticket_attachments WHERE id = ${att}::uuid
    `) as unknown as Array<{ org_id: string }>;
    expect(row?.org_id).toBe(f.orgB);
  });

  it('the device move-org rewrite moves attachments via the tickets join', async () => {
    const f = await seed();
    const att = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, uploadedBy: f.userId });

    // The statement routes/devices/moveOrg.ts issues inside its transaction.
    // The mocked route test asserts its SHAPE; this proves Postgres executes it
    // and that RLS admits the write under a system context.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ticket_attachments SET org_id = ${f.orgB}::uuid
       WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${f.deviceId}::uuid)
    `));

    const [row] = await getTestDb().execute(sql`
      SELECT org_id FROM ticket_attachments WHERE id = ${att}::uuid
    `) as unknown as Array<{ org_id: string }>;
    expect(row?.org_id).toBe(f.orgB);
  });
});

describe('ticket_attachments erasure order (spec D9)', () => {
  it('deletes the s3 objects before the rows, and issues no object call for a db-only org', async () => {
    const f = await seed();
    await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, backend: 's3', storageKey: 'ticket-attachments/k1' });
    await seedAttachment({ orgId: f.orgB, ticketId: f.ticketB, backend: 'db' });

    let rowsAtDeleteTime: number | null = null;
    deleteObjectsMock.mockImplementation(async () => {
      const [c] = await getTestDb().execute(sql`
        SELECT count(*)::int AS n FROM ticket_attachments WHERE org_id = ${f.orgA}::uuid
      `) as unknown as Array<{ n: number }>;
      rowsAtDeleteTime = c!.n;
      return undefined;
    });

    await cascadeDeleteOrg(f.orgA, f.userId, 'admin@example.test');

    expect(deleteObjectsMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectsMock).toHaveBeenCalledWith(['ticket-attachments/k1']);
    // The row was still there when the object went — objects before rows.
    expect(rowsAtDeleteTime).toBe(1);

    const [after] = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM ticket_attachments WHERE org_id = ${f.orgA}::uuid
    `) as unknown as Array<{ n: number }>;
    expect(after!.n).toBe(0);

    // Org B is untouched, and its db-backend row triggered no object call.
    const [orgBRows] = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM ticket_attachments WHERE org_id = ${f.orgB}::uuid
    `) as unknown as Array<{ n: number }>;
    expect(orgBRows!.n).toBe(1);
  });

  it('aborts rerunnably on an object-store fault, leaving every row intact', async () => {
    const f = await seed();
    await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, backend: 's3', storageKey: 'ticket-attachments/k2' });
    deleteObjectsMock.mockRejectedValue(new Error('bucket unreachable'));

    await expect(cascadeDeleteOrg(f.orgA, f.userId, 'admin@example.test')).rejects.toThrow(/rerunnable/i);

    const [rows] = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM ticket_attachments WHERE org_id = ${f.orgA}::uuid
    `) as unknown as Array<{ n: number }>;
    expect(rows!.n).toBe(1);
    const [org] = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM organizations WHERE id = ${f.orgA}::uuid
    `) as unknown as Array<{ n: number }>;
    expect(org!.n).toBe(1);
  });
});

describe('ticket_attachments db backend round-trip (S3 unconfigured)', () => {
  it('round-trips a byte-identical buffer through put -> insert -> claim -> open', async () => {
    expect(selectBackend()).toBe('db'); // control: .env.test configures no bucket
    const f = await seed();

    const attachmentId = crypto.randomUUID();
    const put = await putBytes(attachmentId, PNG_BYTES, 'image/png', SHA('roundtrip'));
    expect(put).toMatchObject({ backend: 'db', storageKey: null });
    expect(put.data?.equals(PNG_BYTES)).toBe(true);
    expect(deleteObjectsMock).not.toHaveBeenCalled();

    await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.insert(ticketAttachments).values({
        id: attachmentId,
        orgId: f.orgA,
        ticketId: f.ticketA,
        uploadedByUserId: f.userId,
        storageBackend: put.backend,
        storageKey: put.storageKey,
        data: put.data,
        contentType: 'image/png',
        byteSize: PNG_BYTES.length,
        originalFilename: 'round.png',
        sha256: SHA('roundtrip'),
      })
    );

    const { attachments } = await withSystemDbAccessContext(() =>
      addTicketComment(f.ticketA, { content: '', isPublic: true, attachmentIds: [attachmentId] }, { userId: f.userId })
    );
    expect(attachments.map((a) => a.id)).toEqual([attachmentId]);
    // Meta only — the 10 MiB-capable blob never leaves the claim (spec D10).
    expect(attachments[0]).not.toHaveProperty('data');
    expect(attachments[0]).not.toHaveProperty('storageKey');

    const [stored] = await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.select({
        storageBackend: ticketAttachments.storageBackend,
        storageKey: ticketAttachments.storageKey,
        data: ticketAttachments.data,
        commentId: ticketAttachments.commentId,
      }).from(ticketAttachments).where(eq(ticketAttachments.id, attachmentId))
    );
    expect(stored?.commentId).toBeTruthy();

    const opened = await openBytes({
      storageBackend: stored!.storageBackend as 'db',
      storageKey: stored!.storageKey,
      data: stored!.data as Buffer,
    });
    expect(Buffer.isBuffer(opened.body)).toBe(true);
    expect((opened.body as Buffer).equals(PNG_BYTES)).toBe(true);
    expect(opened.contentLength).toBe(PNG_BYTES.length);
  });
});
