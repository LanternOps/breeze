/**
 * Real-Postgres proof for #4219 (follow-up to #3828 / PR #4195): the
 * `ticket_outbox` row a ticket mutation writes must roll back WITH the
 * mutation itself when the surrounding request transaction later fails —
 * "hostile ticket" scenario: a ticket write succeeds and its outbox row is
 * inserted, but something else in the SAME request handler then throws, and
 * the whole thing must roll back as one unit.
 *
 * The branch review that opened this issue found the "rollback leaves no
 * outbox row" claim proven only STRUCTURALLY, by `ticketService.test.ts`'s
 * `ticket_outbox — same-transaction write (source guarantee)` describe block,
 * which greps `writeTicketOutbox`'s source for the ABSENCE of
 * `withSystemDbAccessContext`/`runOutsideDbContext` wrapping. That is a real
 * but indirect guarantee — it can't behaviorally distinguish "ran in the
 * ambient request tx" from "ran in a separately-opened system tx" because the
 * mocked unit harness stubs `db.transaction`/`withDbAccessContext` as identity
 * passthroughs and never touches a real Postgres transaction. This test
 * drives the REAL `withDbAccessContext` (the same wrapper `authMiddleware`
 * puts around every request — see `apps/api/src/middleware/auth.ts`'s
 * `dispatch` closure) around a real `changeTicketStatus` call, and forces the
 * SAME ambient transaction to fail immediately after that call returns —
 * exactly what a route handler with a hostile/malformed payload does when a
 * later step in the same handler throws.
 *
 * Two cases:
 *  1. Hostile rollback: `changeTicketStatus` writes its `ticket_outbox` row
 *     and returns successfully, then the request handler throws. Zero
 *     `ticket_outbox` rows and zero committed status changes must survive —
 *     proving both the outbox row and the ticket mutation it announces rolled
 *     back TOGETHER, not just structurally-argued to.
 *  2. Positive control (discriminates the test itself): the identical call
 *     WITHOUT the injected failure commits normally and leaves exactly one
 *     `ticket_outbox` row and the updated ticket status. Without this, case 1
 *     would pass vacuously if the fixture/query were wrong in a way that
 *     always finds zero rows regardless of what actually happened.
 *
 * What would make this test FAIL, precisely: `withDbAccessContext` early-
 * returns `fn()` unchanged when a context is ALREADY open (`dbContextStorage.
 * getStore()` truthy — see `apps/api/src/db/index.ts`), and
 * `withSystemDbAccessContext` delegates straight to it — so wrapping
 * `writeTicketOutbox`'s insert in `withSystemDbAccessContext` ALONE would
 * just NEST into this test's ambient transaction and still roll back
 * normally; that mis-wrap stays caught only by the structural grep above,
 * not behaviorally by this test. What THIS test behaviorally catches is the
 * `runOutsideDbContext` escape form — `runOutsideDbContext` actually exits
 * both AsyncLocalStorage stores, so `runOutsideDbContext(() =>
 * withSystemDbAccessContext(...))` opens a genuinely separate transaction.
 * If `writeTicketOutbox` were ever changed to that form, case 1's outbox row
 * would commit independently in its own short transaction BEFORE the
 * injected throw even runs, so it would SURVIVE the rollback — the
 * `toHaveLength(0)` assertion on `ticket_outbox` would see 1 row instead of
 * 0. (Verified directly: temporarily applying that exact mutation during
 * development made both non-control cases fail — with an FK violation, not
 * even a clean assertion mismatch, since the escaped transaction couldn't
 * see the not-yet-committed `tickets` row — then reverted before this PR.)
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, tickets, ticketOutbox } from '../../db/schema';
import { createPartner, createOrganization, createUser } from './db-utils';
import { createTicket, changeTicketStatus } from '../../services/ticketService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: null });

  const partnerContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId: user.id,
  };

  return { partner, org, user, partnerContext };
}

describe('ticket_outbox rollback atomicity (real Postgres, hostile-ticket scenario)', () => {
  runDb('a request handler that fails AFTER the outbox insert rolls the whole thing back — no outbox row, no committed status change', async () => {
    const { org, user, partnerContext } = await seedFixture();

    // Seed a real ticket (own transaction, commits normally) to mutate.
    const ticket = await withDbAccessContext(partnerContext, () =>
      createTicket({ orgId: org.id, subject: 'hostile-ticket rollback fixture', source: 'manual' }, { userId: user.id })
    );
    expect(ticket.status).toBe('new');

    // Sanity: the create itself already wrote a ticket_outbox row (its own
    // committed transaction) — confirms the table/fixture are wired up before
    // we go looking for the ABSENCE of a row below. Reads here run under
    // withSystemDbAccessContext — a read with NO db access context set is a
    // silent RLS DENY (zero rows), not a bypass, so every assertion query in
    // this file needs an explicit context.
    const afterCreate = await withSystemDbAccessContext(() =>
      db.select({ id: ticketOutbox.id }).from(ticketOutbox).where(eq(ticketOutbox.ticketId, ticket.id))
    );
    expect(afterCreate).toHaveLength(1);

    // The hostile scenario: changeTicketStatus runs to completion — including
    // its writeTicketOutbox('ticket.status_changed') call — and returns
    // normally, but the SAME request handler then throws. This mirrors
    // authMiddleware's dispatch(), which wraps the entire route handler
    // (not just the service call) in one withDbAccessContext/baseDb.transaction.
    const injectedError = new Error('injected: hostile ticket handler failure after outbox insert');
    // Captured outside the transaction callback (rather than asserted inside
    // it) so a genuine assertion failure here surfaces as itself, not as a
    // misleading "wrong error" from the .rejects.toThrow(injectedError) check
    // below swallowing an AssertionError instead of injectedError.
    let statusInsideTransaction: string | undefined;
    await expect(
      withDbAccessContext(partnerContext, async () => {
        const updated = await changeTicketStatus(ticket.id, { status: 'open' }, {}, { userId: user.id });
        statusInsideTransaction = updated!.status;
        throw injectedError;
      })
    ).rejects.toThrow(injectedError);

    // Prove the outbox write really happened before the tx blew up —
    // otherwise a no-op writeTicketOutbox could make case 1 pass vacuously.
    expect(statusInsideTransaction).toBe('open');

    // THE property under test: the status_changed outbox row must not survive
    // the rollback triggered by the handler's later failure.
    const statusChangedRows = await withSystemDbAccessContext(() =>
      db
        .select({ id: ticketOutbox.id, eventType: ticketOutbox.eventType })
        .from(ticketOutbox)
        .where(and(eq(ticketOutbox.ticketId, ticket.id), eq(ticketOutbox.eventType, 'ticket.status_changed')))
    );
    expect(statusChangedRows).toHaveLength(0);

    // Only the create's outbox row remains — the status-change one never
    // committed. If writeTicketOutbox ever escaped the ambient transaction
    // (e.g. via runOutsideDbContext(() => withSystemDbAccessContext(...))),
    // this would be 2, not 1 — see the file header for why
    // withSystemDbAccessContext ALONE would not trigger this.
    const allOutboxRows = await withSystemDbAccessContext(() =>
      db.select({ id: ticketOutbox.id }).from(ticketOutbox).where(eq(ticketOutbox.ticketId, ticket.id))
    );
    expect(allOutboxRows).toHaveLength(1);

    // The ticket mutation itself rolled back TOO — same ambient transaction,
    // same all-or-nothing guarantee. Still 'new', not 'open'.
    const ticketRows = await withSystemDbAccessContext(() =>
      db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id))
    );
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0]!.status).toBe('new');
  });

  runDb('positive control: the identical call WITHOUT the injected failure commits the outbox row and the status change', async () => {
    const { org, user, partnerContext } = await seedFixture();

    const ticket = await withDbAccessContext(partnerContext, () =>
      createTicket({ orgId: org.id, subject: 'hostile-ticket control fixture', source: 'manual' }, { userId: user.id })
    );

    const updated = await withDbAccessContext(partnerContext, () =>
      changeTicketStatus(ticket.id, { status: 'open' }, {}, { userId: user.id })
    );
    expect(updated!.status).toBe('open');

    const statusChangedRows = await withSystemDbAccessContext(() =>
      db
        .select({ id: ticketOutbox.id, payload: ticketOutbox.payload })
        .from(ticketOutbox)
        .where(and(eq(ticketOutbox.ticketId, ticket.id), eq(ticketOutbox.eventType, 'ticket.status_changed')))
    );
    expect(statusChangedRows).toHaveLength(1);
    expect(statusChangedRows[0]!.payload).toEqual({ from: 'new', to: 'open' });

    const ticketRows = await withSystemDbAccessContext(() =>
      db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticket.id))
    );
    expect(ticketRows[0]!.status).toBe('open');
  });

  // Guards the fixture's org RLS scoping isn't accidentally vacuous (e.g. a
  // typo'd accessibleOrgIds that happens to still pass because RLS is bypassed
  // somewhere): the org must be readable under the same context createTicket
  // used, or the whole scenario above never really exercised org-scoped RLS.
  runDb('fixture sanity: the seeded org is visible under partnerContext (RLS is actually engaged, not bypassed)', async () => {
    const { org, partnerContext } = await seedFixture();
    const rows = await withDbAccessContext(partnerContext, () =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, org.id))
    );
    expect(rows).toHaveLength(1);
  });
});
