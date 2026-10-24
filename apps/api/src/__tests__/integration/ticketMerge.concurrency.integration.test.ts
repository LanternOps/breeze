/**
 * #8972 W1 Task 1.7 (spec §3.5): merge against every writer it can meet.
 *
 * Deterministic interleaving with real connections: a holder H takes the
 * SOURCE ticket's row lock; the FIRST operation starts and blocks behind H;
 * the SECOND starts and blocks (behind H or the first); H commits. Both
 * orders are run for each pair. A writer whose lock order disagrees with
 * merge's (links lock → org SHARE → pre-ticket children → tickets ascending →
 * comments → TICKET_CHILD_ORG_REWRITE_LOCK_ORDER) forms an AB-BA cycle and
 * Postgres kills one side with 40P01. Merge retries once on 40P01; a retried
 * deadlock is still a failure here (`[merge]` 40P01 is counted through the
 * pg_stat_database deadlock counter).
 *
 * Every case also asserts a consistent end state: nothing a writer did lands
 * on the tombstone, and the writer either succeeded (its row then moved to
 * the survivor) or was refused with a domain answer (TICKET_MERGED, a 404, a
 * 409 refusal) — never a deadlock.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { invoiceLines } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { runHourBlockCloseOutSweep } from '../../services/contractHourBlockClose';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { issueInvoice } from '../../services/invoiceService';
import { sweepTicketSlaBreaches } from '../../jobs/ticketSlaWorker';
import { mergeTickets } from '../../services/ticketMerge';
import { addTicketLink } from '../../services/ticketLinkService';
import {
  addTicketComment, editTicketComment, moveTicketOrg, sendTicketDraft, type TicketActor,
} from '../../services/ticketService';
import { stopTimer, type TimeEntryActor } from '../../services/timeEntryService';
import { claimPeriod, seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { uniqueInternalNumber } from '../../services/inboundEmail/fixtureNumbering';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 60_000;
const at = (d: string) => new Date(`${d}T06:00:00Z`);
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const q = async <R>(query: ReturnType<typeof sql>): Promise<R[]> => (await getTestDb().execute(query)) as unknown as R[];
const one = async <R>(query: ReturnType<typeof sql>): Promise<R> => (await q<R>(query))[0]!;

afterEach(() => { vi.restoreAllMocks(); });

// ── harness ─────────────────────────────────────────────────────────────────

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

function outcome(s: PromiseSettledResult<unknown>): string {
  if (s.status === 'fulfilled') return 'ok';
  const e = s.reason as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const state = sqlState(s.reason);
  if (state === '40P01') return `40P01 ${e?.cause?.message ?? e?.message ?? ''}`;
  // A domain refusal (TICKET_MERGED, MERGE_*, a 404/409 service error) is an answer, not a failure.
  return `refused:${e?.code ?? state ?? (e as { name?: string })?.name ?? 'error'}`;
}

async function deadlockCount(): Promise<number> {
  const r = await one<{ n: string }>(sql`SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`);
  return Number(r.n);
}

/** Backends (other than the poller) waiting on a lock. */
async function waitingBackends(): Promise<number> {
  const r = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`);
  return r.n;
}

async function waitForWaiting(n: number, ms = 8_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await waitingBackends()) >= n) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * H holds `ticketId` FOR UPDATE; `first` starts and blocks behind it; then
 * `second` starts and (usually) blocks; H commits. Returns both outcomes and
 * whether Postgres recorded a deadlock meanwhile (merge's own 40P01 retry
 * would otherwise hide one).
 */
async function raceHeld(ticketId: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const deadlocksBefore = await deadlockCount();
  // mergeTickets logs every retry; a retried 40P01 is still a deadlock.
  const warn = vi.spyOn(console, 'warn');
  let locked!: () => void;
  const lockedP = new Promise<void>((r) => { locked = r; });
  let go!: () => void;
  const goP = new Promise<void>((r) => { go = r; });
  const h = getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`);
    locked();
    await goP;
  });
  await lockedP;
  const a = first();
  a.catch(() => undefined);
  let b: Promise<unknown> = Promise.resolve();
  let firstBlocked = false;
  let secondBlocked = false;
  try {
    firstBlocked = await waitForWaiting(1);
    b = second();
    b.catch(() => undefined);
    secondBlocked = await waitForWaiting(2, 3_000);
  } finally {
    go();
  }
  const [aRes, bRes] = await Promise.allSettled([a, b]);
  await h;
  const mergeRetries = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[ticketMerge] retrying'));
  warn.mockRestore();
  // pg_stat_database is flushed asynchronously (backup signal only; the retry log is primary).
  await new Promise((r) => setTimeout(r, 1_100));
  return {
    first: outcome(aRes), second: outcome(bRes), firstBlocked, secondBlocked, mergeRetries,
    deadlocks: (await deadlockCount()) - deadlocksBefore,
  };
}

type RaceResult = Awaited<ReturnType<typeof raceHeld>>;

/**
 * No deadlock surfaced, none hidden by merge's one retry, and the interleaving
 * actually happened: the first operation queued behind the holder, and (unless
 * the pair cannot block, e.g. a SKIP LOCKED sweep) so did the second.
 */
function expectNoDeadlock(r: RaceResult, opts: { secondBlocks?: boolean } = {}) {
  expect([r.first, r.second].filter((o) => o.startsWith('40P01')), JSON.stringify(r)).toEqual([]);
  expect(r.mergeRetries, `merge retried (a hidden 40P01): ${JSON.stringify(r)}`).toEqual([]);
  expect(r.deadlocks, `Postgres deadlock counter: ${JSON.stringify(r)}`).toBe(0);
  expect(r.firstBlocked, `first operation never queued behind the holder: ${JSON.stringify(r)}`).toBe(true);
  if (opts.secondBlocks !== false) expect(r.secondBlocked, `second operation never queued: ${JSON.stringify(r)}`).toBe(true);
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function insertTicket(orgId: string, partnerId: string, extra: { deviceId?: string | null; id?: string } = {}): Promise<string> {
  return (await one<{ id: string }>(sql`
    INSERT INTO tickets (id, org_id, partner_id, subject, source, priority, ticket_number, internal_number, device_id)
    VALUES (${extra.id ?? crypto.randomUUID()}::uuid, ${orgId}::uuid, ${partnerId}::uuid, 'merge race', 'api', 'normal',
            ${`MRC-${crypto.randomUUID().slice(0, 8)}`},
            ${uniqueInternalNumber()}, ${extra.deviceId ?? null}::uuid)
    RETURNING id`)).id;
}

/** Two fresh ids, in the requested order (merge locks its tickets ascending). */
function idPair(order: 'src<dst' | 'src>dst'): { srcId: string; dstId: string } {
  const [lo, hi] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  return order === 'src<dst' ? { srcId: lo!, dstId: hi! } : { srcId: hi!, dstId: lo! };
}

async function seed(order: 'src<dst' | 'src>dst' = 'src<dst') {
  const ids = idPair(order);
  const partner = await createPartner({ name: 'MergeRace-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'MergeRace-Org' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'MergeRace-OrgB' });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id, orgB.id], accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TicketActor = { kind: 'user', userId: user.id, name: 'Tech' };
  const dst = await insertTicket(org.id, partner.id, { id: ids.dstId });
  const src = await insertTicket(org.id, partner.id, { id: ids.srcId });
  return { partner, user, org, orgB, ctx, actor, src, dst };
}

type Seed = Awaited<ReturnType<typeof seed>>;
const merge = (s: Pick<Seed, 'ctx' | 'actor'>, src: string, dst: string) =>
  withDbAccessContext(s.ctx, () => mergeTickets({ sourceTicketId: src, intoTicketId: dst, notifyRequester: false }, s.actor));
const asUser = <T>(s: Pick<Seed, 'ctx'>, fn: () => Promise<T>) => withDbAccessContext(s.ctx, fn);

async function insertComment(ticketId: string, userId: string, content: string): Promise<string> {
  return (await one<{ id: string }>(sql`
    INSERT INTO ticket_comments (ticket_id, user_id, author_type, comment_type, content, is_public)
    VALUES (${ticketId}::uuid, ${userId}::uuid, 'internal', 'comment', ${content}, true) RETURNING id`)).id;
}

/** Nothing but merge's own note may sit on a tombstone. */
async function expectNothingOnTombstone(tombstone: string) {
  expect(await one(sql`
    SELECT count(*)::int AS n FROM ticket_comments WHERE ticket_id = ${tombstone}::uuid AND comment_type <> 'system'`)).toEqual({ n: 0 });
  expect(await one(sql`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = ${tombstone}::uuid`)).toEqual({ n: 0 });
  expect(await one(sql`
    SELECT count(*)::int AS n FROM ticket_links WHERE source_ticket_id = ${tombstone}::uuid OR target_ticket_id = ${tombstone}::uuid`)).toEqual({ n: 0 });
}

const ORDERS = [['writer first', true], ['merge first', false]] as const;
const ID_ORDERS = ['src<dst', 'src>dst'] as const;

// ── pairs ───────────────────────────────────────────────────────────────────

describe('merge vs every writer it can meet (#8972 W1, spec §3.5)', () => {
  describe.each(ID_ORDERS.flatMap((o) => ORDERS.map(([l, w]) => [`${l}, ${o}`, w, o] as const)))('%s', (_label, writerFirst, order) => {
    const seed0 = seed;
    const seedHere = () => seed0(order);
    // The holder sits on the row both sides need first: the source for writers
    // of the source, the survivor for movers of the survivor.
    const pair = (s: Seed, writer: () => Promise<unknown>, hold: string = s.src) => writerFirst
      ? raceHeld(hold, writer, () => merge(s, s.src, s.dst))
      : raceHeld(hold, () => merge(s, s.src, s.dst), writer);

    runDb('comment edit', async () => {
      const s = await seedHere();
      const c = await insertComment(s.src, s.user.id, 'before');
      const r = await pair(s, () => asUser(s, () => editTicketComment(c, { content: 'after' }, s.actor, { canManageAny: true })));
      expectNoDeadlock(r);
      expect(await one(sql`SELECT ticket_id FROM ticket_comments WHERE id = ${c}::uuid`)).toEqual({ ticket_id: s.dst });
      await expectNothingOnTombstone(s.src);
    }, CASE_TIMEOUT);

    runDb('comment add (source side)', async () => {
      const s = await seedHere();
      const r = await pair(s, () => asUser(s, () => addTicketComment(s.src, { content: 'racing', isPublic: true }, s.actor)));
      expectNoDeadlock(r);
      await expectNothingOnTombstone(s.src);
    }, CASE_TIMEOUT);

    runDb('draft send', async () => {
      const s = await seedHere();
      const d = await one<{ id: string }>(sql`
        INSERT INTO ticket_drafts (org_id, ticket_id, kind, content) VALUES (${s.org.id}::uuid, ${s.src}::uuid, 'reply', 'draft') RETURNING id`);
      const r = await pair(s, () => asUser(s, () => sendTicketDraft(s.src, d.id, undefined, s.actor)));
      expectNoDeadlock(r);
      await expectNothingOnTombstone(s.src);
      expect(await q(sql`SELECT 1 FROM ticket_drafts WHERE ticket_id = ${s.src}::uuid`)).toEqual([]);
    }, CASE_TIMEOUT);

    runDb('timer stop', async () => {
      const s = await seedHere();
      const e = await one<{ id: string }>(sql`
        INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, currency_code)
        VALUES (${s.partner.id}::uuid, ${s.org.id}::uuid, ${s.src}::uuid, ${s.user.id}::uuid, now() - interval '10 minutes', 'USD') RETURNING id`);
      const timeActor: TimeEntryActor = {
        userId: s.user.id, partnerId: s.partner.id, accessibleOrgIds: [s.org.id, s.orgB.id], manageAll: true, manageBilling: false,
      };
      const r = await pair(s, () => asUser(s, () => stopTimer({}, timeActor)));
      expectNoDeadlock(r);
      expect(await one(sql`SELECT ticket_id FROM time_entries WHERE id = ${e.id}::uuid`)).toEqual({ ticket_id: s.dst });
    }, CASE_TIMEOUT);

    runDb('link add', async () => {
      const s = await seedHere();
      const x = await insertTicket(s.org.id, s.partner.id);
      const r = await pair(s, () => asUser(s, () => addTicketLink({
        source: { id: s.src, orgId: s.org.id }, target: { id: x, orgId: s.org.id }, linkType: 'caused_by',
      }, s.actor)));
      expectNoDeadlock(r);
      await expectNothingOnTombstone(s.src);
    }, CASE_TIMEOUT);

    runDb('moveTicketOrg of the survivor', async () => {
      const s = await seedHere();
      const r = await pair(s, () => sys(() => moveTicketOrg(s.dst, s.orgB.id, s.actor)), s.dst);
      expectNoDeadlock(r);
      const rows = await q<{ id: string; org_id: string }>(sql`SELECT id, org_id FROM tickets WHERE id IN (${s.src}::uuid, ${s.dst}::uuid)`);
      const merged = await one<{ m: string | null }>(sql`SELECT merged_into_ticket_id AS m FROM tickets WHERE id = ${s.src}::uuid`);
      const mergeOutcome = writerFirst ? r.second : r.first;
      if (merged.m) {
        // Merge committed: the pair is still together — the move either carried
        // the tombstone along or refused the changed survivor (CAS 409).
        expect(new Set(rows.map((x) => x.org_id)).size).toBe(1);
      } else {
        // The move won: merge re-checked under its locks and refused the cross-org pair.
        expect(mergeOutcome).toBe('refused:MERGE_CROSS_ORG');
      }
    }, CASE_TIMEOUT);

    runDb('moveTicketOrg of the source', async () => {
      const s = await seedHere();
      const r = await pair(s, () => sys(() => moveTicketOrg(s.src, s.orgB.id, s.actor)));
      expectNoDeadlock(r);
      const src = await one<{ org_id: string; m: string | null }>(sql`SELECT org_id, merged_into_ticket_id AS m FROM tickets WHERE id = ${s.src}::uuid`);
      // Exactly one of them won.
      expect(src.m === null ? src.org_id === s.orgB.id : src.org_id === s.org.id).toBe(true);
    }, CASE_TIMEOUT);

    runDb('device move of the survivor\'s device', async () => {
      const s = await seedHere();
      const siteA = await createSite({ orgId: s.org.id });
      const siteB = await createSite({ orgId: s.orgB.id });
      const device = await createDevice({ orgId: s.org.id, siteId: siteA.id });
      await getTestDb().execute(sql`UPDATE tickets SET device_id = ${device.id}::uuid WHERE id = ${s.dst}::uuid`);
      const r = await pair(s, () => sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
        deviceId: device.id, sourceOrgId: s.org.id, targetOrgId: s.orgB.id, targetSiteId: siteB.id,
        targetOrgName: 'B', deviceLinkGroupId: null, acceptCurrencyMismatch: false,
        actor: { userId: s.user.id, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
      }))), s.dst);
      expectNoDeadlock(r);
      const merged = await one<{ m: string | null }>(sql`SELECT merged_into_ticket_id AS m FROM tickets WHERE id = ${s.src}::uuid`);
      const rows = await q<{ org_id: string }>(sql`SELECT org_id FROM tickets WHERE id IN (${s.src}::uuid, ${s.dst}::uuid)`);
      const mergeOutcome = writerFirst ? r.second : r.first;
      if (merged.m) expect(new Set(rows.map((x) => x.org_id)).size).toBe(1);
      else expect(mergeOutcome).toBe('refused:MERGE_CROSS_ORG');
    }, CASE_TIMEOUT);

    runDb('SLA sweep tick', async () => {
      const s = await seedHere();
      await getTestDb().execute(sql`
        UPDATE tickets SET response_sla_minutes = 1, response_due_at = now() - interval '1 hour',
                           created_at = now() - interval '2 hours'
         WHERE id = ${s.src}::uuid`);
      const r = await pair(s, () => sys(() => sweepTicketSlaBreaches()));
      // The sweep claims rows with SKIP LOCKED: it never queues behind the holder.
      expect([r.first, r.second].filter((o) => o.startsWith('40P01'))).toEqual([]);
      expect(r.mergeRetries).toEqual([]);
      // Merge first: the sweep never stamps the (now merged) tombstone. Sweep
      // first: a breach stamped before the merge stays as history.
      if (!writerFirst) {
        expect(await one(sql`SELECT sla_breached_at IS NULL AS clean FROM tickets WHERE id = ${s.src}::uuid`)).toEqual({ clean: true });
      }
    }, CASE_TIMEOUT);
  });

  describe('Review Focus #2: survivor-side chain A→B→C racing a comment on B', () => {
    describe.each(ORDERS)('%s', (_label, writerFirst) => {
      runDb('the comment lands on C or is refused, never on tombstone B', async () => {
        const s = await seed();
        const a = s.src;
        const b = await insertTicket(s.org.id, s.partner.id);
        const c = s.dst;
        await merge(s, a, b);
        const add = () => asUser(s, () => addTicketComment(b, { content: 'on B', isPublic: true }, s.actor));
        const r = writerFirst
          ? await raceHeld(b, add, () => merge(s, b, c))
          : await raceHeld(b, () => merge(s, b, c), add);
        expectNoDeadlock(r);
        const where = await q<{ ticket_id: string }>(sql`SELECT ticket_id FROM ticket_comments WHERE content = 'on B'`);
        expect(where.every((w) => w.ticket_id === c)).toBe(true);
        expect(await one(sql`SELECT merged_into_ticket_id FROM tickets WHERE id = ${a}::uuid`)).toEqual({ merged_into_ticket_id: c });
      }, CASE_TIMEOUT);
    });
  });

  describe('W0\'s billing order (merge never enters it)', () => {
    async function billingSeed(f: BlockFixture) {
      const ctx: DbAccessContext = {
        scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId],
        currentPartnerId: f.partnerId, userId: f.userId,
      };
      const actor: TicketActor = { kind: 'user', userId: f.userId, name: 'Tech' };
      const dst = await insertTicket(f.orgId, f.partnerId);
      const src = await insertTicket(f.orgId, f.partnerId);
      return { ctx, actor, src, dst };
    }

    describe.each(ORDERS)('%s', (_label, writerFirst) => {
      runDb('invoice issue vs merge of a ticket whose time is on the invoice', async () => {
        const f = await seedBlockFixture({ timing: 'arrears' });
        const gen = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-08-01')));
        expect(gen.generated).toBe(true);
        const s = await billingSeed(f);
        const entryId = await seedEntry(f, { minutes: 60, endedAt: '2026-08-10T12:00:00Z', ticketId: s.src });
        const [contractLine] = await getTestDb().select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)).limit(1);
        const { id: _id, ...base } = contractLine!;
        await getTestDb().insert(invoiceLines).values({
          ...base, sourceType: 'time_entry', sourceId: entryId, sourceContractId: null, ticketId: s.src,
          description: 'Work', quantity: '1.00', unitPrice: '120.00', lineTotal: '120.00',
        });
        const issue = () => withSystemDbAccessContext(() => issueInvoice(gen.invoiceId!, f.actor));
        const r = writerFirst
          ? await raceHeld(s.src, issue, () => merge(s, s.src, s.dst))
          : await raceHeld(s.src, () => merge(s, s.src, s.dst), issue);
        expectNoDeadlock(r);
        const entry = await one<{ ticket_id: string; billing_status: string }>(sql`
          SELECT ticket_id, billing_status::text FROM time_entries WHERE id = ${entryId}::uuid`);
        if (r.second === 'ok' && r.first === 'ok') expect(entry).toEqual({ ticket_id: s.dst, billing_status: 'billed' });
        expect(await one(sql`SELECT count(*)::int AS n FROM invoice_lines WHERE source_id = ${entryId}::uuid AND ticket_id = ${s.src}::uuid`)).toEqual({ n: 1 });
      }, CASE_TIMEOUT);

      runDb('hour-block close vs merge of a ticket with block-drawn time', async () => {
        const f = await seedBlockFixture({ timing: 'arrears', status: 'cancelled', nextBillingAt: null });
        await claimPeriod(f, '2026-07-01', '2026-08-01');
        const s = await billingSeed(f);
        const entryId = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', ticketId: s.src });
        const close = () => runHourBlockCloseOutSweep(at('2026-08-02')).then((x) => {
          if (x.errors > 0) throw new Error(`close-out sweep reported ${x.errors} error(s)`);
          return x;
        });
        const r = writerFirst
          ? await raceHeld(s.src, close, () => merge(s, s.src, s.dst))
          : await raceHeld(s.src, () => merge(s, s.src, s.dst), close);
        expectNoDeadlock(r);
        expect(await one(sql`SELECT ticket_id FROM time_entries WHERE id = ${entryId}::uuid`)).toEqual({ ticket_id: s.dst });
      }, CASE_TIMEOUT);
    });
  });
});
