/**
 * #8972 W0 (spec §3.5): a ticket-child writer locks the TICKET row first.
 *
 * Shape of every case, with two real connections:
 *   B — a ticket-first writer (what ticket merge and moveTicketOrg do): opens a
 *       transaction and takes `tickets … FOR UPDATE`.
 *   A — the writer under test, started WITHOUT awaiting, in the DB context its
 *       request path uses (`withDbAccessContext`, the production `breeze_app`
 *       pool). We wait until A is blocked behind B.
 *   B — then writes A's child row and commits.
 * A writer that locks its child row before the ticket now holds the row B
 * wants while waiting for the ticket B holds: Postgres kills one side with
 * 40P01 (deadlock detected). A ticket-first writer just queues behind B.
 */
import './setup';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts, partnerServicePrincipals, ticketAlertLinks, ticketChecklistItems, ticketChecklistTemplateItems,
  ticketChecklistTemplates, ticketComments, ticketEmailLinks, ticketExternalRefs, tickets,
} from '../../db/schema';
import {
  addTicketComment, changeTicketStatus, deleteTicketComment, editTicketComment, linkAlertToTicket, unlinkAlertFromTicket,
  updateTicketFields, type TicketActor,
} from '../../services/ticketService';
import { applyChecklistTemplateToTicket } from '../../services/ticketChecklistTemplateService';
import { claimMessageLink } from '../../services/ticketEmailLinks';
import { upsertTicketExternalRef } from '../../services/ticketExternalRefs';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 30_000;

type Tx = Parameters<Parameters<ReturnType<typeof getTestDb>['transaction']>[0]>[0];

async function seed() {
  const partner = await createPartner({ name: 'LockOrder-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'LockOrder-Org' });
  const ctx: DbAccessContext = {
    scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [],
    currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TicketActor = { kind: 'user', userId: user.id, name: 'Tech' };
  return { partner, org, user, ctx, actor };
}

async function insertTicket(orgId: string, partnerId: string, extra: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await getTestDb().insert(tickets).values({
    orgId, partnerId, subject: 'lock order', source: 'api', priority: 'normal',
    ticketNumber: `LCK-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  }).returning({ id: tickets.id });
  return row!.id;
}

async function insertComment(ticketId: string, userId: string, content = 'original') {
  const [row] = await getTestDb().insert(ticketComments).values({
    ticketId, userId, authorType: 'internal', commentType: 'internal', content, isPublic: false,
  }).returning({ id: ticketComments.id });
  return row!.id;
}

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** `<SQLSTATE> <message>` of a failed side, so a red names the deadlock rather than just "rejected". */
function describeFailure(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } } | null;
  return `${sqlState(err) ?? 'error'} ${e?.cause?.message ?? e?.message ?? String(err)}`;
}

/** Poll (from a third connection) until some backend waits on a lock `holderPid` holds. */
async function waitUntilBlockedBehind(holderPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
    `)) as unknown as Array<{ n: number }>;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing blocked behind backend ${holderPid} within 10s`);
}

/**
 * B holds the ticket row, A runs, B waits until A is blocked behind it, then
 * runs `afterA` on its own transaction and commits. Returns both outcomes.
 */
async function raceAgainstTicketHolder<T>(
  ticketId: string,
  writerA: () => Promise<T>,
  afterA: (tx: Tx) => Promise<unknown>,
): Promise<{ a: PromiseSettledResult<T>; b: PromiseSettledResult<unknown> }> {
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
    await afterA(tx);
  });
  await lockedP;
  const a = writerA();
  // Settle-tracking only: the outcome is asserted below.
  a.catch(() => undefined);
  try {
    await waitUntilBlockedBehind(holderPid);
  } finally {
    go();
  }
  const [aRes, bRes] = await Promise.allSettled([a, b]);
  return { a: aRes, b: bRes };
}

function expectNoDeadlock(
  r: { a: PromiseSettledResult<unknown>; b: PromiseSettledResult<unknown> },
  // A's own domain answer to what B committed first (e.g. 409 "already
  // linked") is a correct outcome; a deadlock never is.
  aMayRefuse: (err: unknown) => boolean = () => false,
) {
  const codes = [r.a, r.b].map((s, i) => {
    if (s.status === 'fulfilled') return 'ok';
    if (i === 0 && aMayRefuse(s.reason)) return 'ok';
    return describeFailure(s.reason);
  });
  expect(codes, 'writer A / ticket holder B').toEqual(['ok', 'ok']);
}

async function seedAlert(orgId: string) {
  const site = await createSite({ orgId });
  const device = await createDevice({ orgId, siteId: site.id });
  const [alert] = await getTestDb().insert(alerts).values({
    orgId, deviceId: device.id, severity: 'medium', title: 'lock order alert',
  }).returning({ id: alerts.id });
  return alert!.id;
}

describe('ticket-child writers lock the ticket row first (#8972 W0)', () => {
  runDb('comment edit does not deadlock against a ticket-first writer', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const commentId = await insertComment(ticketId, f.user.id);

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => editTicketComment(commentId, { content: 'edited' }, f.actor, { canManageAny: false })),
      (tx) => tx.execute(sql`UPDATE ticket_comments SET ticket_id = ticket_id WHERE id = ${commentId}::uuid`),
    );
    expectNoDeadlock(r);
    const [row] = await getTestDb().select({ content: ticketComments.content }).from(ticketComments).where(eq(ticketComments.id, commentId));
    expect(row?.content).toBe('edited');
  }, CASE_TIMEOUT);

  runDb('comment delete does not deadlock against a ticket-first writer', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const commentId = await insertComment(ticketId, f.user.id);

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => deleteTicketComment(commentId, f.actor, { canManageAny: false })),
      (tx) => tx.execute(sql`UPDATE ticket_comments SET ticket_id = ticket_id WHERE id = ${commentId}::uuid`),
    );
    expectNoDeadlock(r);
    const [row] = await getTestDb().select({ deletedAt: ticketComments.deletedAt }).from(ticketComments).where(eq(ticketComments.id, commentId));
    expect(row?.deletedAt).not.toBeNull();
  }, CASE_TIMEOUT);

  runDb('comment add does not deadlock against a ticket-first writer', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => addTicketComment(ticketId, { content: 'added', isPublic: false }, f.actor)),
      (tx) => tx.execute(sql`UPDATE tickets SET updated_at = now() WHERE id = ${ticketId}::uuid`),
    );
    expectNoDeadlock(r);
    const rows = await getTestDb().select({ content: ticketComments.content }).from(ticketComments).where(eq(ticketComments.ticketId, ticketId));
    expect(rows.map((x) => x.content)).toEqual(['added']);
  }, CASE_TIMEOUT);

  runDb('comment add decides the first-response stamp on the LOCKED ticket row', async () => {
    // B stamps first_response_at while A waits; A must see it under its lock
    // and keep it, not overwrite it from its unlocked pre-read.
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const stampedAt = new Date('2026-01-02T03:04:05.000Z');

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => addTicketComment(ticketId, { content: 'public reply', isPublic: true }, f.actor)),
      (tx) => tx.execute(sql`UPDATE tickets SET first_response_at = ${stampedAt.toISOString()}::timestamp WHERE id = ${ticketId}::uuid`),
    );
    expectNoDeadlock(r);
    const [row] = await getTestDb().select({ firstResponseAt: tickets.firstResponseAt }).from(tickets).where(eq(tickets.id, ticketId));
    expect(row?.firstResponseAt?.toISOString()).toBe(stampedAt.toISOString());
  }, CASE_TIMEOUT);

  // ── T0.3: the remaining writers that could deadlock ──────────────────────

  runDb('alert unlink does not deadlock against a ticket-first writer of the same link', async () => {
    // Before: DELETE the link (row lock), then the feed comment, whose FK and
    // trigger wait on the ticket B holds; B then touches the link A holds.
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const alertId = await seedAlert(f.org.id);
    await getTestDb().insert(ticketAlertLinks).values({ ticketId, orgId: f.org.id, alertId, linkType: 'attached' });

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => unlinkAlertFromTicket(ticketId, alertId, f.actor)),
      (tx) => tx.execute(sql`UPDATE ticket_alert_links SET link_type = link_type WHERE ticket_id = ${ticketId}::uuid AND alert_id = ${alertId}::uuid`),
    );
    expectNoDeadlock(r);
    expect(await getTestDb().select().from(ticketAlertLinks).where(eq(ticketAlertLinks.ticketId, ticketId))).toHaveLength(0);
  }, CASE_TIMEOUT);

  runDb('alert link does not deadlock against a ticket-first writer inserting the same link', async () => {
    // Before: A's speculative INSERT holds the unique key while its FK check
    // waits on the ticket; B, holding the ticket, inserts the same key.
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const alertId = await seedAlert(f.org.id);

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => linkAlertToTicket(ticketId, alertId, f.actor)),
      (tx) => tx.insert(ticketAlertLinks).values({ ticketId, orgId: f.org.id, alertId, linkType: 'auto' }),
    );
    // B linked it first, so A answers its existing 409 "already linked".
    expectNoDeadlock(r, (err) => (err as { status?: number }).status === 409);
    expect(await getTestDb().select().from(ticketAlertLinks).where(eq(ticketAlertLinks.ticketId, ticketId))).toHaveLength(1);
  }, CASE_TIMEOUT);

  runDb('external ref upsert does not deadlock against a ticket-first writer of the same ref', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const [principal] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: f.partner.id, name: `LockOrder ${crypto.randomUUID()}`, scopes: ['tickets:read', 'tickets:write'],
      sourceCidrs: [], expiresAt: null, createdBy: f.user.id, updatedBy: f.user.id,
    }).returning({ id: partnerServicePrincipals.id });
    const partnerCtx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [f.org.id], accessiblePartnerIds: [f.partner.id],
      currentPartnerId: f.partner.id, userId: null,
    };

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(partnerCtx, () => upsertTicketExternalRef({
        principalId: principal!.id, partnerId: f.partner.id, ticketId, externalId: 'EXT-A',
      })),
      (tx) => tx.insert(ticketExternalRefs).values({
        ticketId, orgId: f.org.id, partnerId: f.partner.id, partnerServicePrincipalId: principal!.id, externalId: 'EXT-B',
      }),
    );
    expectNoDeadlock(r);
    const rows = await getTestDb().select({ externalId: ticketExternalRefs.externalId }).from(ticketExternalRefs).where(eq(ticketExternalRefs.ticketId, ticketId));
    expect(rows.map((x) => x.externalId)).toEqual(['EXT-A']);
  }, CASE_TIMEOUT);

  runDb('email link claim does not deadlock against a ticket-first writer claiming the same message', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const messageId = `<lock-order-${crypto.randomUUID()}@example.test>`;

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => claimMessageLink({
        ticketId, orgId: f.org.id, partnerId: f.partner.id, messageId, origin: 'addin_link', visibility: 'internal',
        linkedBy: f.user.id,
      })),
      (tx) => tx.insert(ticketEmailLinks).values({
        ticketId, orgId: f.org.id, partnerId: f.partner.id, messageId, origin: 'inbound', visibility: 'public',
      }),
    );
    expectNoDeadlock(r);
    expect(r.a.status === 'fulfilled' && r.a.value).toMatchObject({ created: false });
  }, CASE_TIMEOUT);

  runDb('checklist template replace does not deadlock against a ticket-first writer of an unticked item', async () => {
    // Before: DELETE the unticked items (row locks), then INSERT the template
    // steps, whose FK check waits on the ticket B holds; B then updates the
    // item A deleted.
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const [template] = await getTestDb().insert(ticketChecklistTemplates).values({
      orgId: f.org.id, name: `LockOrder ${crypto.randomUUID()}`, createdBy: f.user.id,
    }).returning({ id: ticketChecklistTemplates.id });
    await getTestDb().insert(ticketChecklistTemplateItems).values({ templateId: template!.id, orgId: f.org.id, label: 'from template' });
    const [item] = await getTestDb().insert(ticketChecklistItems).values({
      orgId: f.org.id, ticketId, label: 'old step', position: 0, source: 'manual', createdBy: f.user.id,
    }).returning({ id: ticketChecklistItems.id });
    const templateActor = {
      userId: f.user.id, partnerId: f.partner.id, accessibleOrgIds: [f.org.id], scope: 'organization' as const,
    };

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => applyChecklistTemplateToTicket(
        { id: ticketId, orgId: f.org.id }, { templateId: template!.id, mode: 'replace_unticked' }, templateActor,
      )),
      (tx) => tx.execute(sql`UPDATE ticket_checklist_items SET label = label WHERE id = ${item!.id}::uuid`),
    );
    expectNoDeadlock(r);
    const labels = await getTestDb().select({ label: ticketChecklistItems.label }).from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, ticketId));
    expect(labels.map((x) => x.label)).toEqual(['from template']);
  }, CASE_TIMEOUT);

  // ── #8973 W3 hand-off: SLA deadlines are recomputed from the LOCKED row ──
  // A first response (B here; addTicketComment / sendTicketDraft in
  // production) freezes the response deadline. A writer that recomputes the
  // unfrozen arms must judge "frozen" on the row it holds locked, or it
  // overwrites the frozen deadline from its unlocked pre-read.

  const FROZEN_DUE = new Date('2026-01-05T10:00:00.000Z');
  const FROZEN_WARN = new Date('2026-01-05T09:00:00.000Z');
  /** B's first response: stamps first_response_at and freezes the response arm. */
  const stampFirstResponse = (ticketId: string) => (tx: Tx) => tx.execute(sql`
    UPDATE tickets SET first_response_at = now(),
      response_due_at = ${FROZEN_DUE.toISOString()}::timestamp,
      response_warn_at = ${FROZEN_WARN.toISOString()}::timestamp
    WHERE id = ${ticketId}::uuid`);
  const responseArm = async (ticketId: string) => {
    const [row] = await getTestDb().select({ due: tickets.responseDueAt, warn: tickets.responseWarnAt })
      .from(tickets).where(eq(tickets.id, ticketId));
    return { due: row?.due?.toISOString(), warn: row?.warn?.toISOString() };
  };

  runDb('a pause end keeps a response deadline frozen while it waited for the ticket lock', async () => {
    const f = await seed();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const ticketId = await insertTicket(f.org.id, f.partner.id, {
      status: 'pending', createdAt: hoursAgo(3), slaPausedAt: hoursAgo(2), responseSlaMinutes: 60,
      responseDueAt: hoursAgo(2), responseWarnAt: hoursAgo(2.2),
    });

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => changeTicketStatus(ticketId, { status: 'open' }, {}, f.actor)),
      stampFirstResponse(ticketId),
    );
    expectNoDeadlock(r);
    const [row] = await getTestDb().select({ status: tickets.status, slaPausedAt: tickets.slaPausedAt })
      .from(tickets).where(eq(tickets.id, ticketId));
    expect(row).toMatchObject({ status: 'open', slaPausedAt: null });
    expect(await responseArm(ticketId)).toEqual({ due: FROZEN_DUE.toISOString(), warn: FROZEN_WARN.toISOString() });
  }, CASE_TIMEOUT);

  runDb('an SLA override keeps a response deadline frozen while it waited for the ticket lock', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id, { status: 'open', responseSlaMinutes: 60 });

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => updateTicketFields(ticketId, { responseSlaMinutes: 240 }, f.actor)),
      stampFirstResponse(ticketId),
    );
    expectNoDeadlock(r);
    const [row] = await getTestDb().select({ minutes: tickets.responseSlaMinutes }).from(tickets).where(eq(tickets.id, ticketId));
    expect(row?.minutes).toBe(240);
    expect(await responseArm(ticketId)).toEqual({ due: FROZEN_DUE.toISOString(), warn: FROZEN_WARN.toISOString() });
  }, CASE_TIMEOUT);

  runDb('a priority change does not restamp SLA targets once a first response landed while it waited', async () => {
    // #6691: targets restamp only while the ticket has no first response. The
    // gate must be judged on the locked row, not the unlocked pre-read.
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id, {
      status: 'open', responseSlaMinutes: 241, resolutionSlaMinutes: 1441,
    });

    const r = await raceAgainstTicketHolder(
      ticketId,
      () => withDbAccessContext(f.ctx, () => updateTicketFields(ticketId, { priority: 'urgent' }, f.actor)),
      stampFirstResponse(ticketId),
    );
    expectNoDeadlock(r);
    const [row] = await getTestDb().select({
      priority: tickets.priority, response: tickets.responseSlaMinutes, resolution: tickets.resolutionSlaMinutes,
    }).from(tickets).where(eq(tickets.id, ticketId));
    expect(row).toEqual({ priority: 'urgent', response: 241, resolution: 1441 });
  }, CASE_TIMEOUT);

  runDb('an edit still answers 404 for a comment of another ticket, and still edits nothing', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const otherTicketId = await insertTicket(f.org.id, f.partner.id);
    const commentId = await insertComment(ticketId, f.user.id);
    const err = await withDbAccessContext(f.ctx, () =>
      editTicketComment(commentId, { content: 'nope' }, f.actor, { canManageAny: false, expectedTicketId: otherTicketId }),
    ).then(() => null, (e: unknown) => e);
    expect((err as { status?: number; message?: string } | null)).toMatchObject({ status: 404, message: 'Comment not found' });
    const [row] = await getTestDb().select({ content: ticketComments.content }).from(ticketComments).where(eq(ticketComments.id, commentId));
    expect(row?.content).toBe('original');
    // The production pool is the unprivileged role (RLS really applied above).
    const [role] = await withDbAccessContext(f.ctx, () => db.execute(sql`SELECT current_user::text AS r`)) as unknown as Array<{ r: string }>;
    expect(role?.r).toBe('breeze_app');
  }, CASE_TIMEOUT);
});
