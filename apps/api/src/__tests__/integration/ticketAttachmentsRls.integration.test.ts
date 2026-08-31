/**
 * ticket_attachments — RLS, org-move re-stamp, erasure order and db-backend
 * round-trip against real Postgres (W08 #3902).
 *
 * Migration under test: 2026-09-26-ticket-attachments.sql
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
import { Hono } from 'hono';
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
import { reapPendingAttachments } from '../../jobs/ticketAttachmentReaper';
import { ticketRoutes as portalTicketRoutes } from '../../routes/portal/tickets';

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

describe('portal attachment read path (REAL route, real Postgres)', () => {
  /**
   * Drives routes/portal/tickets.ts itself rather than re-implementing its
   * filter. The whole authz ladder on the byte route is SQL — there is no JS
   * branch — so a hand-mirrored query here could not fail when the route
   * changed, which is exactly how a dropped `is_public` rung would ship
   * unnoticed (W08A review). The mocked unit suite cannot cover it either:
   * its schema mock renders columns as plain strings, so the predicate is
   * unrecoverable from the SQL tree.
   */
  function buildPortalApp(user: { id: string; orgId: string }) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('portalAuth' as never, { user, token: 'tok', authMethod: 'bearer' } as never);
      await next();
    });
    app.route('/', portalTicketRoutes);
    return app;
  }

  /** GETs the byte route as `user`, inside the portal's own org RLS context. */
  async function getContent(
    user: { id: string; orgId: string },
    ticketId: string,
    attachmentId: string,
  ): Promise<Response> {
    const app = buildPortalApp(user);
    // `app.request` is typed `Response | Promise<Response>`; await it inside
    // the context so the RLS context is still open while the handler runs.
    return withDbAccessContext(orgContext(user.orgId, user.id), async () =>
      await app.request(`/tickets/${ticketId}/attachments/${attachmentId}/content`)
    );
  }

  /** tickets.submitted_by FKs portal_users, not users — a portal session IS a
   *  portal_user row. Returns the new portal user's id. */
  async function seedPortalUser(orgId: string): Promise<string> {
    const id = crypto.randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO portal_users (id, org_id, email, name)
      VALUES (${id}::uuid, ${orgId}::uuid, ${`portal-${uid()}@example.test`}, 'Portal User')
    `);
    return id;
  }

  async function setSubmitter(ticketId: string, portalUserId: string): Promise<void> {
    await getTestDb().execute(sql`
      UPDATE tickets SET submitted_by = ${portalUserId}::uuid WHERE id = ${ticketId}::uuid
    `);
  }

  it('serves a PUBLIC comment attachment and 404s internal, deleted and pending ones', async () => {
    const f = await seed();
    const portalUserId = await seedPortalUser(f.orgA);
    await setSubmitter(f.ticketA, portalUserId);
    const user = { id: portalUserId, orgId: f.orgA };

    const publicComment = await seedComment(f.ticketA, f.userId, true);
    const internalComment = await seedComment(f.ticketA, f.userId, false);
    const deletedComment = await seedComment(f.ticketA, f.userId, true, true);

    const visible = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: publicComment });
    const internal = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: internalComment });
    const deleted = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: deletedComment });
    const pending = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: null, uploadedBy: f.userId });

    // POSITIVE CONTROL first: without it every 404 below could be a broken rig.
    const ok = await getContent(user, f.ticketA, visible);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    expect(ok.headers.get('X-Content-Type-Options')).toBe('nosniff');

    // The rung that matters: a technician's INTERNAL note is not customer-readable.
    expect((await getContent(user, f.ticketA, internal)).status).toBe(404);
    expect((await getContent(user, f.ticketA, deleted)).status).toBe(404);
    expect((await getContent(user, f.ticketA, pending)).status).toBe(404);
  });

  it('404s an attachment on a ticket THIS portal session did not submit', async () => {
    const f = await seed();
    const mine = await seedPortalUser(f.orgA);
    const other = await seedPortalUser(f.orgA);
    await setSubmitter(f.ticketA, other); // someone else's ticket, same org
    const comment = await seedComment(f.ticketA, f.userId, true);
    const att = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: comment });

    const res = await getContent({ id: mine, orgId: f.orgA }, f.ticketA, att);
    expect(res.status).toBe(404);
  });

  it('404s an attachment on ANOTHER org\'s ticket even with a matching submitter', async () => {
    const f = await seed();
    const portalUserId = await seedPortalUser(f.orgB);
    await setSubmitter(f.ticketB, portalUserId); // org B's ticket, this user submitted it
    const comment = await seedComment(f.ticketB, f.userId, true);
    const att = await seedAttachment({ orgId: f.orgB, ticketId: f.ticketB, commentId: comment });

    // Session is scoped to org A; the ticket lookup's org_id rung must reject.
    const res = await getContent({ id: portalUserId, orgId: f.orgA }, f.ticketB, att);
    expect(res.status).toBe(404);
  });

  it('404s an attachment on a SOFT-DELETED ticket', async () => {
    const f = await seed();
    const portalUserId = await seedPortalUser(f.orgA);
    await setSubmitter(f.ticketA, portalUserId);
    await getTestDb().execute(sql`UPDATE tickets SET deleted_at = now() WHERE id = ${f.ticketA}::uuid`);
    const comment = await seedComment(f.ticketA, f.userId, true);
    const att = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId: comment });

    const res = await getContent({ id: portalUserId, orgId: f.orgA }, f.ticketA, att);
    expect(res.status).toBe(404);
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

/**
 * W08A review: the pending reaper's claim must be atomic. The original shape
 * (unlocked SELECT -> object delete -> re-checked row DELETE) protected the ROW
 * but not the OBJECT — a comment claiming the attachment during the object
 * round trip left a live comment pointing at destroyed bytes. These run against
 * real Postgres because the property under test IS the locking semantics; a
 * mocked db cannot express it.
 */
describe('ticket attachment pending reaper (real Postgres locking)', () => {
  /** Backdates a row past the 24h grace period. */
  async function backdate(attachmentId: string): Promise<void> {
    await getTestDb().execute(sql`
      UPDATE ticket_attachments SET created_at = now() - interval '48 hours'
      WHERE id = ${attachmentId}::uuid
    `);
  }

  async function exists(attachmentId: string): Promise<boolean> {
    const rows = await getTestDb().execute(sql`
      SELECT 1 AS n FROM ticket_attachments WHERE id = ${attachmentId}::uuid
    `) as unknown as Array<{ n: number }>;
    return rows.length === 1;
  }

  it('reaps ONLY abandoned pending rows — an attached row and a fresh upload survive', async () => {
    const f = await seed();
    const commentId = await seedComment(f.ticketA, f.userId, true);

    const abandoned = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, backend: 's3' });
    await backdate(abandoned);
    const attached = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, commentId, backend: 's3' });
    await backdate(attached); // old AND attached — the row this job must never touch
    const fresh = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, backend: 's3' });

    await reapPendingAttachments();

    expect(await exists(abandoned)).toBe(false);
    expect(await exists(attached)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    // ...and exactly one object was deleted: the abandoned row's.
    const deletedKeys = deleteObjectsMock.mock.calls.flatMap((c) => (c as unknown as [string[]])[0]);
    expect(deletedKeys).toContain(`ticket-attachments/${abandoned}`);
    expect(deletedKeys).not.toContain(`ticket-attachments/${attached}`);
    expect(deletedKeys).not.toContain(`ticket-attachments/${fresh}`);
  });

  it('SKIPS a row another transaction is mid-claim on, and never touches its object', async () => {
    const f = await seed();
    const contended = await seedAttachment({ orgId: f.orgA, ticketId: f.ticketA, backend: 's3' });
    await backdate(contended);

    // Stand in for addTicketComment's claim UPDATE holding the row lock: on the
    // pre-fix shape the reaper's unlocked SELECT still returned this row and
    // destroyed its object while the claim was in flight.
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const holder = withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT id FROM ticket_attachments WHERE id = ${contended}::uuid FOR UPDATE`);
      signalLocked();
      await held;
    });
    await locked;

    const reaped = await reapPendingAttachments();

    release();
    await holder;

    expect(reaped).toBe(0);
    expect(await exists(contended)).toBe(true);
    const deletedKeys = deleteObjectsMock.mock.calls.flatMap((c) => (c as unknown as [string[]])[0]);
    expect(deletedKeys).not.toContain(`ticket-attachments/${contended}`);
  });
});
