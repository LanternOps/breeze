/**
 * moveTicketOrg's optimistic check ignores the Partner API feed re-stamp
 * (partner API tickets wave 2).
 *
 * moveTicketOrg snapshots the ticket outside its transaction and, in the
 * UPDATE that moves it, refuses (409) if the row changed in between. Every
 * comment write re-stamps the parent ticket's `partner_feed_xid`
 * (`breeze_ticket_comments_touch_parent_feed`), which rewrites the row. When
 * the check compared `xmin`, a comment landing mid-move — a time-entry feed
 * line, a portal reply, an inbound email — aborted the move with a spurious
 * 409 (seen as timeEntryRace "(a) create vs move" turning flaky). The check
 * now compares the row's content minus that one column.
 *
 * Deterministic interleaving, no sleeps: a dedicated client holds the ticket
 * row lock, the move is started and observed blocked on its UPDATE (it took
 * its snapshot before blocking), then the holder writes inside the same
 * transaction and commits. Postgres re-checks the move's WHERE against the
 * committed row (EvalPlanQual), which is exactly the path under test.
 */
import './setup';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { tickets } from '../../db/schema';
import { moveTicketOrg, TicketServiceError } from '../../services/ticketService';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Wait until at least one backend in this database is blocked on a lock. */
async function waitForBlockedBackend(): Promise<void> {
  const admin = getTestDb();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await admin.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
        FROM pg_catalog.pg_stat_activity
       WHERE datname = current_database()
         AND state = 'active'
         AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
    `);
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    if (Date.now() > deadline) throw new Error('expected the move to block on the ticket row lock within 10s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seed() {
  const partner = await createPartner();
  const source = await createOrganization({ partnerId: partner.id });
  const target = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  const [ticket] = await getTestDb().insert(tickets).values({
    orgId: source.id, partnerId: partner.id, subject: 'move vs feed restamp', source: 'manual', priority: 'normal',
    ticketNumber: `MVF-${crypto.randomUUID().slice(0, 8)}`,
  }).returning({ id: tickets.id });
  return { partner, source, target, user, ticketId: ticket!.id };
}

/**
 * Hold the ticket row lock, start the move, wait until it is blocked, run
 * `whileHeld` in the holder's transaction, commit, and return the move's outcome.
 */
async function moveWhileHolderWrites(
  f: Awaited<ReturnType<typeof seed>>,
  whileHeld: (tx: Sql) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>> {
  const locked = deferred<void>();
  const release = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const holderWork = holder.begin(async (tx) => {
      await tx`SELECT id FROM public.tickets WHERE id = ${f.ticketId} FOR UPDATE`;
      locked.resolve();
      await release.promise;
      await whileHeld(tx as unknown as Sql);
    });
    await locked.promise;
    const move = withSystemDbAccessContext(() =>
      moveTicketOrg(f.ticketId, f.target.id, { kind: 'user' as const, userId: f.user.id }));
    await waitForBlockedBackend();
    release.resolve();
    await holderWork;
    const [outcome] = await Promise.allSettled([move]);
    return outcome!;
  } finally {
    release.resolve();
    await holder.end({ timeout: 1 });
  }
}

async function ticketRow(ticketId: string) {
  const [row] = (await getTestDb().execute(sql`
    SELECT org_id, subject, partner_feed_xid::text AS xid FROM tickets WHERE id = ${ticketId}
  `)) as unknown as Array<{ org_id: string; subject: string; xid: string }>;
  return row!;
}

describe.runIf(RUN)('moveTicketOrg vs the Partner API feed re-stamp', () => {
  it('a comment committed mid-move (feed-only re-stamp) does not abort the move', async () => {
    const f = await seed();
    const before = await ticketRow(f.ticketId);

    const outcome = await moveWhileHolderWrites(f, (tx) => tx`
      INSERT INTO public.ticket_comments (ticket_id, user_id, author_type, content, is_public)
      VALUES (${f.ticketId}, ${f.user.id}, 'internal', 'logged 15m while the ticket was moving', false)
    `);

    expect(outcome.status, outcome.status === 'rejected' ? String((outcome.reason as Error).message) : '').toBe('fulfilled');
    const after = await ticketRow(f.ticketId);
    expect(after.org_id).toBe(f.target.id);
    // The holder's comment did re-stamp the row (that is what used to break
    // the xmin check); the move's own UPDATE then re-stamped it again.
    expect(BigInt(after.xid)).toBeGreaterThan(BigInt(before.xid));
  });

  it('a real concurrent change to the ticket still aborts the move with 409', async () => {
    const f = await seed();

    const outcome = await moveWhileHolderWrites(f, (tx) => tx`
      UPDATE public.tickets SET subject = 'renamed while the move was blocked' WHERE id = ${f.ticketId}
    `);

    expect(outcome.status).toBe('rejected');
    const reason = (outcome as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(TicketServiceError);
    expect((reason as TicketServiceError).status).toBe(409);
    const after = await ticketRow(f.ticketId);
    expect(after.org_id).toBe(f.source.id);
    expect(after.subject).toBe('renamed while the move was blocked');
  });

  it('a concurrent change to updated_at alone is a real change, not a feed re-stamp', async () => {
    const f = await seed();

    const outcome = await moveWhileHolderWrites(f, (tx) => tx`
      UPDATE public.tickets SET updated_at = now() + interval '1 second' WHERE id = ${f.ticketId}
    `);

    expect(outcome.status).toBe('rejected');
    expect(((outcome as PromiseRejectedResult).reason as TicketServiceError).status).toBe(409);
    expect((await ticketRow(f.ticketId)).org_id).toBe(f.source.id);
  });
});
