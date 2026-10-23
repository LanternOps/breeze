/**
 * #8972 W0 review: the billing stampers' ticket locks against the billing
 * chain's own locks (contracts, other tickets).
 *
 * The billing run and the close-out sweep lock the CONTRACT row first (#3778,
 * generateDueInvoice's first statement), and the hour-block close then claims
 * time entries — ticket child rows — so it takes their tickets after the
 * contract. Invoice issue / void must therefore take the source tickets after
 * the contracts too, and the close must take all of its tickets in one
 * ascending batch rather than one batch per period.
 *
 * Shape: B (a second real connection) takes its first lock, A (the writer
 * under test, un-awaited) starts and blocks behind B, then B takes a second
 * lock and commits. A writer whose order disagrees with B's forms an AB-BA
 * cycle and Postgres kills one side with 40P01.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contracts, invoiceLines, tickets } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { runHourBlockCloseOutSweep } from '../../services/contractHourBlockClose';
import { issueInvoice } from '../../services/invoiceService';
import { claimPeriod, entryState, seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';
import { getTestDb } from './setup';

const CASE_TIMEOUT = 30_000;
const at = (d: string) => new Date(`${d}T06:00:00Z`);

afterEach(() => { vi.restoreAllMocks(); });

async function insertTicket(f: BlockFixture): Promise<string> {
  const [row] = await getTestDb().insert(tickets).values({
    orgId: f.orgId, partnerId: f.partnerId, subject: 'billing lock order', source: 'api', priority: 'normal',
    ticketNumber: `BLO-${crypto.randomUUID().slice(0, 8)}`,
  }).returning({ id: tickets.id });
  return row!.id;
}

/** Two tickets, returned as [lower id, higher id]. */
async function ticketPair(f: BlockFixture): Promise<[string, string]> {
  const ids = [await insertTicket(f), await insertTicket(f)].sort();
  return [ids[0]!, ids[1]!];
}

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

function describeFailure(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  return `${e?.cause?.code ?? e?.code ?? 'error'} ${e?.cause?.message ?? e?.message ?? String(err)}`;
}

/** B takes `first`, A runs until it blocks behind B, then B takes `second` and commits. */
async function race<T>(first: SQL, writerA: () => Promise<T>, second: SQL) {
  let holderPid = 0;
  let locked!: () => void;
  const lockedP = new Promise<void>((r) => { locked = r; });
  let go!: () => void;
  const goP = new Promise<void>((r) => { go = r; });
  const b = getTestDb().transaction(async (tx) => {
    const [pid] = (await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as Array<{ pid: number }>;
    holderPid = pid!.pid;
    await tx.execute(first);
    locked();
    await goP;
    await tx.execute(second);
  });
  await lockedP;
  const a = writerA();
  a.catch(() => undefined);
  try {
    await waitUntilBlockedBehind(holderPid);
  } finally {
    go();
  }
  const [aRes, bRes] = await Promise.allSettled([a, b]);
  return [aRes, bRes].map((s) => (s.status === 'fulfilled' ? 'ok' : describeFailure(s.reason)));
}

/** retryOnTransientLockError logs every lost race; a retried 40P01 is still a deadlock. */
function spyLockRetries() {
  const warn = vi.spyOn(console, 'warn');
  return () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('transient lock error'));
}

const lockTicket = (id: string) => sql`SELECT id FROM tickets WHERE id = ${id}::uuid FOR UPDATE`;
const lockContract = (id: string) => sql`SELECT id FROM contracts WHERE id = ${id}::uuid FOR UPDATE`;

describe('billing stampers take ticket locks in the billing chain\'s order (#8972 W0 review)', () => {
  it('invoice issue does not deadlock against the billing run (contract, then its tickets)', async () => {
    // A draft carrying the contract's block-fee line AND a time line on ticket T.
    const f = await seedBlockFixture({ timing: 'arrears' });
    const gen = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-08-01')));
    expect(gen.generated).toBe(true);
    const ticketId = await insertTicket(f);
    const entryId = await seedEntry(f, { minutes: 60, endedAt: '2026-08-10T12:00:00Z', ticketId });
    const [contractLine] = await getTestDb().select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, gen.invoiceId!)).limit(1);
    const { id: _id, ...base } = contractLine!;
    await getTestDb().insert(invoiceLines).values({
      ...base, sourceType: 'time_entry', sourceId: entryId, sourceContractId: null, ticketId,
      description: 'Work', quantity: '1.00', unitPrice: '120.00', lineTotal: '120.00',
    });
    const retries = spyLockRetries();

    // B is the next billing run on the same contract: contract row, then (the
    // hour-block close) the tickets of the entries it claims.
    const outcome = await race(
      lockContract(f.contractId),
      () => withSystemDbAccessContext(() => issueInvoice(gen.invoiceId!, f.actor)),
      lockTicket(ticketId),
    );
    expect({ outcome, retries: retries() }, 'issue A / billing run B').toEqual({ outcome: ['ok', 'ok'], retries: [] });
  }, CASE_TIMEOUT);

  it('the hour-block close locks every period\'s tickets in one ascending batch', async () => {
    // Two ended, claimed periods on a cancelled contract (the close-out sweep's
    // case): July's time on the HIGHER ticket id, August's on the LOWER one.
    const f = await seedBlockFixture({ timing: 'arrears', status: 'cancelled', nextBillingAt: null });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await claimPeriod(f, '2026-08-01', '2026-09-01');
    const [tLo, tHi] = await ticketPair(f);
    const july = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', ticketId: tHi });
    const august = await seedEntry(f, { minutes: 60, endedAt: '2026-08-10T12:00:00Z', ticketId: tLo });

    // B is any ascending multi-ticket writer (approveTimeEntries, a link add):
    // the lower ticket, then the higher one.
    const outcome = await race(
      lockTicket(tLo),
      () => runHourBlockCloseOutSweep(at('2026-09-02')).then((s) => {
        if (s.errors > 0) throw new Error(`close-out sweep reported ${s.errors} error(s)`);
        return s;
      }),
      lockTicket(tHi),
    );
    expect(outcome, 'close-out A / ascending writer B').toEqual(['ok', 'ok']);
    expect(await entryState(july)).toMatchObject({ billingStatus: 'contract' });
    expect(await entryState(august)).toMatchObject({ billingStatus: 'contract' });
    // The contract row is untouched by B; the sweep closed both periods.
    const [c] = await withSystemDbAccessContext(() => db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, f.contractId)));
    expect(c?.status).toBe('cancelled');
  }, CASE_TIMEOUT);
});
