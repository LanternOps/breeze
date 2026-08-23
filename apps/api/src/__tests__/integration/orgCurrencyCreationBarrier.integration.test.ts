/**
 * Multi-currency wave 6 (#3778), Task 12 — the ORGANIZATION SHARED-LOCK
 * CREATION BARRIER, proved against real Postgres with two dedicated clients.
 *
 * WHY THIS EXISTS. `changeOrgCurrency` takes `organizations FOR UPDATE`. That
 * alone is not enough: every constructor that derives a stamp from the org
 * default used to read the org UNLOCKED and INSERT later, so this interleaving
 * was possible —
 *
 *     creator: SELECT organizations -> 'EUR'
 *     changer: UPDATE organizations SET currency_code = 'GBP' ; COMMIT
 *     creator: INSERT ... currency_code = 'EUR' ; COMMIT      <-- FORBIDDEN
 *
 * The row lands in the OLD currency, AFTER the change committed, and it was not
 * in the change's in-lock impact summary — invisible to both sides. The fix is
 * `readOrgStampingDefaults` (orgCurrencyCore.ts): every default-derived writer
 * takes `organizations FOR SHARE` as its transaction's first statement and
 * holds it to commit.
 *
 * The ONLY allowed outcomes are therefore:
 *   (a) the creator commits the OLD snapshot BEFORE the change commits — and
 *       the change's in-lock summary counts it; or
 *   (b) the creator WAITS on the org lock, rereads, and commits the NEW
 *       snapshot after the change.
 *
 * HARNESS. A dedicated postgres.js client pre-holds `organizations FOR UPDATE`
 * (exactly what changeOrgCurrency holds), the creator is started against the
 * app pool, and `pg_blocking_pids` proves the creator is genuinely BLOCKED
 * before the holder flips the currency and commits. `waitForBlockedBackends`
 * is the load-bearing assertion: without the barrier the creator never blocks,
 * so this step times out — this suite fails on the pre-fix code, it does not
 * silently pass. No sleeps, no polling of the creator's result.
 *
 * FIVE races, one per writer family (codex review, major 5):
 *   1. org change vs invoice / quote / contract creation
 *   2. org change vs ticket time-entry and part creation
 *   3. org change vs ticket org move (the cross-org, two-lock family)
 *   4. org change vs org ticket-rate upsert   (upsertOrgTicketSettings)
 *   5. org change vs catalog org-override upsert (setOrgPriceOverride)
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';

// Fire-and-forget BullMQ / event side effects are not the correctness under
// test (same rationale as the wave-6 gate slices). Everything monetary is real.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', () => ({ emitTicketEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  catalogItemOrgPricing, contracts, invoices, organizations, orgTicketSettings,
  quotes, ticketParts, tickets, timeEntries,
} from '../../db/schema';
import { createManualInvoice } from '../../services/invoiceService';
import { changeOrgCurrency } from '../../services/orgCurrencyService';
import { createQuote } from '../../services/quoteService';
import { createContract } from '../../services/contractService';
import { addTicketPart, createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { createTicket, moveTicketOrg } from '../../services/ticketService';
import { upsertOrgTicketSettings } from '../../services/ticketConfigService';
import { setOrgPriceOverride } from '../../services/catalogService';
import { createCatalogItemWithPrice, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const T0 = new Date('2026-07-01T09:00:00Z');
const T60 = new Date('2026-07-01T10:00:00Z');

// ---------------------------------------------------------------------------
// Race harness (pattern: invoiceIssueRace.integration.test.ts)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(clients.map((c) => c.end({ timeout: 1 })));
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, 'failed to close race client(s)');
}

/**
 * Wait until at least `min` backends are actively blocked on a lock. The holder
 * is idle-in-transaction (never blocked), so the only backend that can match is
 * the creator queued behind the org row lock. THIS is the barrier assertion:
 * a creator that reads the org unlocked never blocks, and this throws.
 */
async function waitForBlockedBackends(min: number, what: string): Promise<void> {
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
    if ((rows[0]?.waiting ?? 0) >= min) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: expected >= ${min} lock-blocked backend(s) within 10s — the writer read the ` +
        'organization WITHOUT the FOR SHARE barrier, so an old-currency row can commit unseen (#3778)'
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Runs `creator` while a dedicated client holds `organizations FOR UPDATE` on
 * `orgId` — the exact lock changeOrgCurrency holds. Asserts the creator BLOCKS,
 * then flips the currency to `newCurrency` and commits, then returns whatever
 * the creator produced once it drains.
 */
async function raceAgainstOrgCurrencyChange<T>(
  orgId: string, newCurrency: string, what: string, creator: () => Promise<T>,
): Promise<T> {
  const lockHeld = deferred<void>();
  const release = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`SELECT id FROM public.organizations WHERE id = ${orgId} FOR UPDATE`;
      lockHeld.resolve();
      await release.promise;
      // The "change" itself: committed while the creator is provably queued.
      await tx`UPDATE public.organizations SET currency_code = ${newCurrency} WHERE id = ${orgId}`;
    });
    await lockHeld.promise;

    const running = creator();
    // Load-bearing: the creator must be waiting on the org row, not past it.
    await waitForBlockedBackends(1, what);
    release.resolve();
    await holderWork;
    return await running;
  } finally {
    release.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    await closeRaceClients(holder);
  }
}

function timeActor(f: GateOrgFixture): TimeEntryActor {
  return { userId: f.userId, name: 'Barrier Tech', partnerId: f.partnerId, manageAll: true, accessibleOrgIds: [f.orgId] };
}
function ctx(f: GateOrgFixture, orgIds: string[] = [f.orgId]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [f.partnerId], userId: f.userId };
}
async function orgCurrency(orgId: string): Promise<string | undefined> {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1));
  return row?.currencyCode;
}

describe.runIf(RUN)('org currency change vs default-derived creation (#3778 barrier)', () => {
  // -------------------------------------------------------------------------
  // Race 1 — invoice / quote / contract creation
  // -------------------------------------------------------------------------
  it('(1a) createManualInvoice waits on the org lock and stamps the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const inv = await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'createManualInvoice', () =>
      withDbAccessContext(ctx(f), () => createManualInvoice({ orgId: f.orgId, notes: 'barrier' }, f.actor)));

    expect(await orgCurrency(f.orgId)).toBe('GBP');
    // FORBIDDEN outcome asserted explicitly: an old-currency row committed
    // after the change, unseen by the change's in-lock summary.
    expect(inv.currencyCode, 'invoice stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(inv.currencyCode).toBe('GBP');
  });

  it('(1b) createQuote waits on the org lock and stamps the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const quote = await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'createQuote', () =>
      withDbAccessContext(ctx(f), () => createQuote({ orgId: f.orgId, title: 'barrier' } as never, f.actor)));

    expect(quote.currencyCode, 'quote stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(quote.currencyCode).toBe('GBP');
    const [persisted] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: quotes.currencyCode }).from(quotes).where(eq(quotes.id, quote.id)).limit(1));
    expect(persisted?.currencyCode).toBe('GBP');
  });

  it('(1c) createContract waits on the org lock and stamps the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const contract = await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'createContract', () =>
      withDbAccessContext(ctx(f), () => createContract({
        orgId: f.orgId, name: 'Barrier MSA', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01',
      }, f.actor)));

    expect(contract.currencyCode, 'contract stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(contract.currencyCode).toBe('GBP');
    const [persisted] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: contracts.currencyCode }).from(contracts).where(eq(contracts.id, contract.id)).limit(1));
    expect(persisted?.currencyCode).toBe('GBP');
  });

  // -------------------------------------------------------------------------
  // Race 2 — ticket child creation (time entry, part)
  // -------------------------------------------------------------------------
  it('(2a) createTimeEntry waits on the org lock and stamps the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const ticket = await withSystemDbAccessContext(() => createTicket(
      { orgId: f.orgId, subject: 'barrier', source: 'manual' }, { userId: f.userId, name: 'Barrier Tech' }));

    const entry = await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'createTimeEntry', () =>
      withDbAccessContext(ctx(f), () => createTimeEntry(
        { ticketId: ticket.id, startedAt: T0, endedAt: T60, isBillable: true, hourlyRate: 90 }, timeActor(f))));

    const [row] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: timeEntries.currencyCode }).from(timeEntries).where(eq(timeEntries.id, entry.id)).limit(1));
    expect(row?.currencyCode, 'time entry stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(row?.currencyCode).toBe('GBP');
  });

  it('(2b) addTicketPart waits on the org lock and stamps the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const ticket = await withSystemDbAccessContext(() => createTicket(
      { orgId: f.orgId, subject: 'barrier part', source: 'manual' }, { userId: f.userId, name: 'Barrier Tech' }));

    const part = await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'addTicketPart', () =>
      withDbAccessContext(ctx(f), () => addTicketPart(
        ticket.id, { description: 'SSD', quantity: 1, unitPrice: 120, isBillable: true } as never, timeActor(f))));

    const [row] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: ticketParts.currencyCode }).from(ticketParts).where(eq(ticketParts.id, part.id)).limit(1));
    expect(row?.currencyCode, 'ticket part stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(row?.currencyCode).toBe('GBP');
  });

  // -------------------------------------------------------------------------
  // Race 3 — ticket org move (locks BOTH orgs FOR SHARE, ascending UUID)
  // -------------------------------------------------------------------------
  it('(3) moveTicketOrg locks BOTH orgs and blocks on the TARGET\'s NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const target = await createOrganization({ partnerId: f.partnerId, currencyCode: 'EUR' });
    const ticket = await withSystemDbAccessContext(() => createTicket(
      { orgId: f.orgId, subject: 'barrier move', source: 'manual' }, { userId: f.userId, name: 'Barrier Tech' }));
    // One unbilled EUR billable, so a CROSS-currency move is refused outright.
    await withDbAccessContext(ctx(f), () => createTimeEntry(
      { ticketId: ticket.id, startedAt: T0, endedAt: T60, isBillable: true, hourlyRate: 90 }, timeActor(f)));

    // The target flips to GBP mid-move. With the barrier the move waits, sees
    // GBP, and its guard REFUSES the cross-currency move. Without the barrier it
    // compares the stale EUR/EUR pair and silently "succeeds" as a same-currency
    // move, stranding a EUR billable under a GBP org.
    const outcome = await raceAgainstOrgCurrencyChange(target.id, 'GBP', 'moveTicketOrg', () =>
      withSystemDbAccessContext(() => moveTicketOrg(ticket.id, target.id, { userId: f.userId, name: 'Barrier Tech' }))
        .then(() => 'moved' as const, (err: unknown) => err));

    expect(await orgCurrency(target.id)).toBe('GBP');
    expect(outcome, 'the move compared a STALE currency pair — the org SHARE barrier did not hold')
      .not.toBe('moved');
    expect((outcome as { code?: string }).code).toBe('TICKET_MOVE_CURRENCY_BLOCKED');
    // The move rolled back entirely: the ticket stays on the source org.
    const [row] = await withSystemDbAccessContext(() => db
      .select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticket.id)).limit(1));
    expect(row?.orgId).toBe(f.orgId);
  });

  // -------------------------------------------------------------------------
  // Race 4 — org ticket-rate upsert (the route's old pre-transaction read)
  // -------------------------------------------------------------------------
  it('(4) upsertOrgTicketSettings waits on the org lock and stamps rate_currency with the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'upsertOrgTicketSettings', () =>
      withSystemDbAccessContext(() => upsertOrgTicketSettings(
        f.orgId, { defaultHourlyRate: 95, defaultBillable: true })));

    const [row] = await withSystemDbAccessContext(() => db
      .select({ rateCurrency: orgTicketSettings.rateCurrency, defaultHourlyRate: orgTicketSettings.defaultHourlyRate })
      .from(orgTicketSettings).where(eq(orgTicketSettings.orgId, f.orgId)).limit(1));
    expect(row?.rateCurrency, 'org rate stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(row?.rateCurrency).toBe('GBP');
    expect(row?.defaultHourlyRate).toBe('95.00');
  });

  // -------------------------------------------------------------------------
  // Race 5 — catalog org override (item lock used to come FIRST)
  // -------------------------------------------------------------------------
  it('(5) setOrgPriceOverride waits on the org lock and stamps the NEW currency', async () => {
    const f = await seedGateOrg('EUR');
    const item = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
      partnerId: f.partnerId, name: 'Barrier Widget', currencyCode: 'EUR', unitPrice: '100.00',
    }));
    const catalogActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };

    const override = await raceAgainstOrgCurrencyChange(f.orgId, 'GBP', 'setOrgPriceOverride', () =>
      withSystemDbAccessContext(() => setOrgPriceOverride(item.id, f.orgId, { unitPrice: 9 }, catalogActor)));

    expect(override.currencyCode, 'override stamped the OLD currency after the change committed').not.toBe('EUR');
    expect(override.currencyCode).toBe('GBP');
    const [row] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: catalogItemOrgPricing.currencyCode })
      .from(catalogItemOrgPricing).where(eq(catalogItemOrgPricing.catalogItemId, item.id)).limit(1));
    expect(row?.currencyCode).toBe('GBP');
  });

  // -------------------------------------------------------------------------
  // The OTHER allowed outcome: the creator commits FIRST and the change's
  // in-lock summary counts it. Proves the barrier does not merely serialize —
  // a draft that beats the change is visible to it.
  // -------------------------------------------------------------------------
  it('(6) a draft that commits BEFORE the change is counted by the change\'s in-lock summary', async () => {
    const f = await seedGateOrg('EUR');
    await withDbAccessContext(ctx(f), () => createManualInvoice({ orgId: f.orgId, notes: 'pre-change' }, f.actor));

    const result = await withDbAccessContext(ctx(f), () => changeOrgCurrency(
      f.orgId, { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true }, f.actor));

    const eurGroup = result.impact.impactsByCurrency.find((g) => g.currencyCode === 'EUR');
    expect(eurGroup, 'the pre-change EUR draft must appear in the in-lock summary').toBeDefined();
    expect(eurGroup!.documents.draftInvoices).toBe(1);
    expect(await orgCurrency(f.orgId)).toBe('GBP');
    // Future-only: the pre-change draft keeps its EUR stamp.
    const rows = await withSystemDbAccessContext(() => db
      .select({ currencyCode: invoices.currencyCode }).from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(rows.map((r) => r.currencyCode)).toEqual(['EUR']);
  });
});
