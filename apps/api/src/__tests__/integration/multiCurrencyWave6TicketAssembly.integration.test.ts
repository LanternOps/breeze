/**
 * Wave-6 release gate, slice G4 (#3778): TICKET LABOR + PART -> ASSEMBLY
 * against a non-USD org on a USD partner, driven through the real write paths
 * (`createTicket` -> `createTimeEntry` / `addTicketPart` -> `assembleDraftFromTicket`
 * -> `issueInvoice`) rather than hand-inserted rows.
 *
 * Multi-currency rules under test (spec §7):
 *  - time entries and parts snapshot their currency at creation and are NEVER
 *    restamped;
 *  - rate defaults are match-or-skip — an org default rate whose `rate_currency`
 *    differs from the org currency simply does not apply;
 *  - assembly groups sources by their OWN stamped currency against the draft's
 *    header currency and reports `{ included, blockedByCurrency, missingRate }` —
 *    never a silent filter, never a conversion;
 *  - old-currency billables stay recoverable via an explicit same-currency
 *    assembly (`assembleDraftFromTicket(id, actor, { currencyCode })`);
 *  - every persisted amount must be representable at the currency's minor unit
 *    (JPY is zero-decimal), and rounding happens exactly ONCE.
 *
 * Runs under vitest.integration.config.ts against a real Postgres. No fixture
 * memoization — integration/setup.ts TRUNCATEs partners/organizations before
 * every test, so each test re-seeds fresh.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ side effects are not the correctness under test (same
// rationale as the other wave-6 gate slices). Everything monetary runs for real.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', () => ({ emitTicketEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { multiplyToCurrency, roundToCurrency } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { invoiceLines, invoices, organizations, ticketParts, timeEntries } from '../../db/schema';
import { assembleDraftFromTicket, issueInvoice } from '../../services/invoiceService';
import { addTicketPart, createTimeEntry, resolveDefaultRate, type TimeEntryActor } from '../../services/timeEntryService';
import { upsertOrgTicketSettings } from '../../services/ticketConfigService';
import { createTicket } from '../../services/ticketService';
import { gateLabel, seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

const T0 = new Date('2026-07-01T09:00:00Z');
const minutesAfter = (start: Date, m: number) => new Date(start.getTime() + m * 60_000);

function assertionMessage(
  transition: string, currency: string, column: string, expected: unknown, actual: unknown,
): string {
  return `${transition}; currency=${currency}; column=${column}; expected=${String(expected)}; actual=${String(actual)}`;
}

/** numeric(10,2)/numeric(12,2) round-trips as a scaled string ('12000.00'), so
 *  compare the VALUE against the currency-rounded expectation and additionally
 *  assert the persisted figure is representable at the currency's minor unit. */
function expectMoney(actual: string | null | undefined, expected: string | number, currency: string, ctx: string): void {
  const want = roundToCurrency(expected, currency);
  expect(Number(actual), assertionMessage(ctx, currency, 'amount', want, actual)).toBe(Number(want));
  expect(
    Number(roundToCurrency(Number(actual), currency)),
    assertionMessage(ctx, currency, 'minor-unit representability', `representable in ${currency}`, actual),
  ).toBe(Number(actual));
}

function timeActor(fixture: GateOrgFixture): TimeEntryActor {
  return {
    userId: fixture.userId,
    name: 'Gate Technician',
    partnerId: fixture.partnerId,
    manageAll: true,
    accessibleOrgIds: [fixture.orgId],
  };
}

async function seedTicket(fixture: GateOrgFixture, subject: string): Promise<string> {
  const ticket = await withSystemDbAccessContext(() => createTicket(
    { orgId: fixture.orgId, subject, source: 'manual' },
    { userId: fixture.userId, name: 'Gate Technician' },
  ));
  return ticket.id as string;
}

/** Org-level default hourly rate, stamped with `rateCurrency` (the org currency
 *  the rate was entered under). Written through the real service seam. */
async function setOrgDefaultRate(fixture: GateOrgFixture, rate: number): Promise<void> {
  // #3778: the service resolves and stamps the CURRENT org currency itself
  // (under the org SHARE barrier) — a caller can no longer name an arbitrary
  // rate_currency, so an old-currency stamp is produced the only way it happens
  // in production: enter the rate, then change the org currency.
  await withSystemDbAccessContext(() => upsertOrgTicketSettings(
    fixture.orgId,
    { defaultHourlyRate: rate, defaultBillable: true },
  ));
}

/** Direct org currency flip — the persisted effect of an org currency change on
 *  FUTURE stamps. Historical snapshots are deliberately left untouched. */
async function flipOrgCurrency(orgId: string, to: string): Promise<void> {
  await withSystemDbAccessContext(() => db.update(organizations)
    .set({ currencyCode: to }).where(eq(organizations.id, orgId)));
}

async function readEntry(id: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      currencyCode: timeEntries.currencyCode,
      hourlyRate: timeEntries.hourlyRate,
      isBillable: timeEntries.isBillable,
      durationMinutes: timeEntries.durationMinutes,
      billingStatus: timeEntries.billingStatus,
    })
    .from(timeEntries).where(eq(timeEntries.id, id)).limit(1));
  return row;
}

async function readPart(id: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      currencyCode: ticketParts.currencyCode,
      quantity: ticketParts.quantity,
      unitPrice: ticketParts.unitPrice,
      isBillable: ticketParts.isBillable,
      billingStatus: ticketParts.billingStatus,
    })
    .from(ticketParts).where(eq(ticketParts.id, id)).limit(1));
  return row;
}

async function readInvoiceLines(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      sourceType: invoiceLines.sourceType,
      sourceId: invoiceLines.sourceId,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      lineTotal: invoiceLines.lineTotal,
    })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
}

describe.runIf(RUN)(gateLabel('G4', 'ticket labor + part -> assembly'), () => {
  it('assembles a EUR ticket: EUR-stamped labor and part become EUR-rounded lines and flip to billed on issue', async () => {
    const fixture = await seedGateOrg('EUR');
    await setOrgDefaultRate(fixture, 85.5);
    const ticketId = await seedTicket(fixture, 'W6 G4 EUR labor + part');

    // Labor: 90 minutes at the org default rate (match-or-skip applies it — the
    // rate was entered under EUR and the org is EUR).
    const entry = await withSystemDbAccessContext(() => createTimeEntry(
      { ticketId, startedAt: T0, endedAt: minutesAfter(T0, 90) },
      timeActor(fixture),
    ));
    const part = await withSystemDbAccessContext(() => addTicketPart(
      ticketId,
      { description: 'Replacement SSD', quantity: 3, unitPrice: 12.34 },
      timeActor(fixture),
    ));

    const entryRow = await readEntry(entry.id);
    expect(
      entryRow?.currencyCode,
      assertionMessage('createTimeEntry snapshot', 'EUR', 'time_entries.currency_code', 'EUR', entryRow?.currencyCode),
    ).toBe('EUR');
    expect(
      entryRow?.isBillable,
      assertionMessage('createTimeEntry snapshot', 'EUR', 'time_entries.is_billable', true, entryRow?.isBillable),
    ).toBe(true);
    expectMoney(entryRow?.hourlyRate, 85.5, 'EUR', 'createTimeEntry applies the EUR org default rate');

    const partRow = await readPart(part.id);
    expect(
      partRow?.currencyCode,
      assertionMessage('addTicketPart snapshot', 'EUR', 'ticket_parts.currency_code', 'EUR', partRow?.currencyCode),
    ).toBe('EUR');
    expectMoney(partRow?.unitPrice, 12.34, 'EUR', 'addTicketPart unit price');

    const assembled = await withSystemDbAccessContext(() => assembleDraftFromTicket(ticketId, fixture.actor));
    expect(
      assembled.blockedByCurrency,
      assertionMessage('assembleDraftFromTicket', 'EUR', 'blockedByCurrency', '[]', JSON.stringify(assembled.blockedByCurrency)),
    ).toEqual([]);
    expect(
      assembled.missingRate,
      assertionMessage('assembleDraftFromTicket', 'EUR', 'missingRate', '[]', JSON.stringify(assembled.missingRate)),
    ).toEqual([]);
    expect(
      assembled.invoice.currencyCode,
      assertionMessage('assembleDraftFromTicket', 'EUR', 'invoices.currency_code', 'EUR', assembled.invoice.currencyCode),
    ).toBe('EUR');

    const lines = await readInvoiceLines(assembled.invoice.id);
    expect(lines, assertionMessage('assembleDraftFromTicket', 'EUR', 'invoice_lines count', 2, lines.length)).toHaveLength(2);
    const labor = lines.find((l) => l.sourceType === 'time_entry');
    const material = lines.find((l) => l.sourceType === 'part');

    // Both lines are source-backed — assembly must never materialize a detached line.
    expect(labor?.sourceId, assertionMessage('assembled labor line', 'EUR', 'invoice_lines.source_id', entry.id, labor?.sourceId)).toBe(entry.id);
    expect(material?.sourceId, assertionMessage('assembled part line', 'EUR', 'invoice_lines.source_id', part.id, material?.sourceId)).toBe(part.id);

    // Labor rule: hours to 2dp first, then ONE round at the EUR minor unit.
    expect(Number(labor?.quantity), assertionMessage('assembled labor line', 'EUR', 'invoice_lines.quantity', 1.5, labor?.quantity)).toBe(1.5);
    expectMoney(labor?.unitPrice, 85.5, 'EUR', 'assembled labor line unit price');
    expectMoney(labor?.lineTotal, multiplyToCurrency('1.50', '85.50', 'EUR'), 'EUR', 'assembled labor line total (1.50h x 85.50)');

    expect(Number(material?.quantity), assertionMessage('assembled part line', 'EUR', 'invoice_lines.quantity', 3, material?.quantity)).toBe(3);
    expectMoney(material?.lineTotal, multiplyToCurrency('3.00', '12.34', 'EUR'), 'EUR', 'assembled part line total (3 x 12.34)');

    await withSystemDbAccessContext(() => issueInvoice(assembled.invoice.id, fixture.actor));

    const [issued] = await withSystemDbAccessContext(() => db
      .select({ status: invoices.status, currencyCode: invoices.currencyCode, subtotal: invoices.subtotal })
      .from(invoices).where(eq(invoices.id, assembled.invoice.id)).limit(1));
    expect(issued?.status, assertionMessage('issueInvoice', 'EUR', 'invoices.status', 'sent', issued?.status)).toBe('sent');
    expect(issued?.currencyCode, assertionMessage('issueInvoice', 'EUR', 'invoices.currency_code', 'EUR', issued?.currencyCode)).toBe('EUR');
    // 128.25 labor + 37.02 parts = 165.27, rounded once at the EUR minor unit.
    expectMoney(issued?.subtotal, 165.27, 'EUR', 'issued invoice subtotal');

    // Both sources flip to `billed` — the double-bill guard's whole point.
    expect(
      (await readEntry(entry.id))?.billingStatus,
      assertionMessage('issueInvoice source flip', 'EUR', 'time_entries.billing_status', 'billed', (await readEntry(entry.id))?.billingStatus),
    ).toBe('billed');
    expect(
      (await readPart(part.id))?.billingStatus,
      assertionMessage('issueInvoice source flip', 'EUR', 'ticket_parts.billing_status', 'billed', (await readPart(part.id))?.billingStatus),
    ).toBe('billed');
  });

  it('reports a pre-change USD entry under blockedByCurrency and still bills it via an explicit USD assembly (spec §7 recovery)', async () => {
    const fixture = await seedGateOrg('EUR');
    await setOrgDefaultRate(fixture, 85.5);
    const ticketId = await seedTicket(fixture, 'W6 G4 old-currency recovery');

    const eurEntry = await withSystemDbAccessContext(() => createTimeEntry(
      { ticketId, startedAt: T0, endedAt: minutesAfter(T0, 60) },
      timeActor(fixture),
    ));

    // A time entry logged BEFORE the org's currency changed to EUR: stamped USD,
    // never restamped. No service path can produce this under a EUR org today,
    // which is exactly why it is seeded directly.
    const [usdEntry] = await withSystemDbAccessContext(() => db.insert(timeEntries).values({
      partnerId: fixture.partnerId,
      orgId: fixture.orgId,
      ticketId,
      userId: fixture.userId,
      startedAt: minutesAfter(T0, -180),
      endedAt: minutesAfter(T0, -60),
      durationMinutes: 120,
      description: 'Pre-change labor',
      isBillable: true,
      hourlyRate: '100.00',
      currencyCode: 'USD',
      billingStatus: 'not_billed',
    }).returning({ id: timeEntries.id }));

    const eurDraft = await withSystemDbAccessContext(() => assembleDraftFromTicket(ticketId, fixture.actor));
    expect(
      eurDraft.invoice.currencyCode,
      assertionMessage('EUR assembly', 'EUR', 'invoices.currency_code', 'EUR', eurDraft.invoice.currencyCode),
    ).toBe('EUR');

    // The USD entry is REPORTED under its own currency, never converted and
    // never silently dropped.
    expect(
      eurDraft.blockedByCurrency,
      assertionMessage('EUR assembly', 'EUR', 'blockedByCurrency', '[{USD,1,200.00}]', JSON.stringify(eurDraft.blockedByCurrency)),
    ).toHaveLength(1);
    const blocked = eurDraft.blockedByCurrency[0]!;
    expect(
      blocked.currencyCode,
      assertionMessage('EUR assembly', 'EUR', 'blockedByCurrency[0].currencyCode', 'USD', blocked.currencyCode),
    ).toBe('USD');
    expect(
      blocked.count,
      assertionMessage('EUR assembly', 'EUR', 'blockedByCurrency[0].count', 1, blocked.count),
    ).toBe(1);
    // Blocked amounts are summed at the BLOCKED row's own minor unit: 2h x 100 USD.
    expectMoney(blocked.amount, 200, 'USD', 'blocked group amount');

    const eurLines = await readInvoiceLines(eurDraft.invoice.id);
    expect(eurLines, assertionMessage('EUR assembly', 'EUR', 'invoice_lines count', 1, eurLines.length)).toHaveLength(1);
    expect(
      eurLines[0]?.sourceId,
      assertionMessage('EUR assembly', 'EUR', 'invoice_lines.source_id', eurEntry.id, eurLines[0]?.sourceId),
    ).toBe(eurEntry.id);

    // Recovery path (spec §7): an explicit same-currency assembly bills the
    // old-currency work with no restamp and no conversion.
    const usdDraft = await withSystemDbAccessContext(() =>
      assembleDraftFromTicket(ticketId, fixture.actor, { currencyCode: 'USD' }));
    expect(
      usdDraft.invoice.currencyCode,
      assertionMessage('USD recovery assembly', 'USD', 'invoices.currency_code', 'USD', usdDraft.invoice.currencyCode),
    ).toBe('USD');
    const usdLines = await readInvoiceLines(usdDraft.invoice.id);
    expect(usdLines, assertionMessage('USD recovery assembly', 'USD', 'invoice_lines count', 1, usdLines.length)).toHaveLength(1);
    expect(
      usdLines[0]?.sourceId,
      assertionMessage('USD recovery assembly', 'USD', 'invoice_lines.source_id', usdEntry!.id, usdLines[0]?.sourceId),
    ).toBe(usdEntry!.id);
    expectMoney(usdLines[0]?.lineTotal, multiplyToCurrency('2.00', '100.00', 'USD'), 'USD', 'USD recovery line total');

    // The EUR entry is now the blocked side of the USD draft — symmetry, not a filter.
    expect(
      usdDraft.blockedByCurrency.map((b) => b.currencyCode),
      assertionMessage('USD recovery assembly', 'USD', 'blockedByCurrency currencies', '[EUR]', JSON.stringify(usdDraft.blockedByCurrency)),
    ).toEqual(['EUR']);

    // The USD entry's snapshot survived both assemblies untouched.
    expect(
      (await readEntry(usdEntry!.id))?.currencyCode,
      assertionMessage('snapshot immutability', 'USD', 'time_entries.currency_code', 'USD', (await readEntry(usdEntry!.id))?.currencyCode),
    ).toBe('USD');
  });

  it('skips an org default rate entered under a different currency instead of applying it (match-or-skip)', async () => {
    // The rate was entered while the org was USD; the org is EUR now. Seed it
    // exactly that way — the service always stamps the CURRENT org currency.
    const fixture = await seedGateOrg('USD');
    await setOrgDefaultRate(fixture, 85.5);
    await flipOrgCurrency(fixture.orgId, 'EUR');
    const ticketId = await seedTicket(fixture, 'W6 G4 match-or-skip');

    expect(
      resolveDefaultRate('EUR', { defaultHourlyRate: '85.50', rateCurrency: 'USD' }, null),
      'a USD-stamped default rate must not apply to a EUR org',
    ).toBeNull();

    const entry = await withSystemDbAccessContext(() => createTimeEntry(
      { ticketId, startedAt: T0, endedAt: minutesAfter(T0, 60), isBillable: true },
      timeActor(fixture),
    ));
    const row = await readEntry(entry.id);
    expect(
      row?.hourlyRate,
      assertionMessage('createTimeEntry match-or-skip', 'EUR', 'time_entries.hourly_rate', 'null', row?.hourlyRate),
    ).toBeNull();
    expect(
      row?.currencyCode,
      assertionMessage('createTimeEntry match-or-skip', 'EUR', 'time_entries.currency_code', 'EUR', row?.currencyCode),
    ).toBe('EUR');

    // A rate-less billable entry is an explicit assembly GAP, never a zero line.
    await expect(
      withSystemDbAccessContext(() => assembleDraftFromTicket(ticketId, fixture.actor)),
      'a rate-less billable entry must surface as ALL_MISSING_RATE, never bill at zero',
    ).rejects.toThrow(/no hourly rate/i);

    const linesForOrg = await withSystemDbAccessContext(() => db
      .select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, fixture.orgId)));
    expect(linesForOrg, 'the transient draft must be deleted when nothing could be included').toHaveLength(0);
  });

  it('assembles a JPY ticket in whole yen, rounding the labor product exactly once', async () => {
    const fixture = await seedGateOrg('JPY');
    await setOrgDefaultRate(fixture, 8000);
    const ticketId = await seedTicket(fixture, 'W6 G4 JPY labor');

    // 1.5h x 8000 JPY = 12000 exactly.
    const wholeEntry = await withSystemDbAccessContext(() => createTimeEntry(
      { ticketId, startedAt: T0, endedAt: minutesAfter(T0, 90) },
      timeActor(fixture),
    ));
    // 0.25h x 333 JPY = 83.25 -> ONE half-up round at the zero-decimal minor
    // unit = 83. A second round (e.g. cents first, then yen) would give 83 too,
    // but a cent-boundary persist would store 83.25 — which is what this asserts against.
    const fractionalEntry = await withSystemDbAccessContext(() => createTimeEntry(
      { ticketId, startedAt: minutesAfter(T0, 120), endedAt: minutesAfter(T0, 135), hourlyRate: 333 },
      timeActor(fixture),
    ));

    const assembled = await withSystemDbAccessContext(() => assembleDraftFromTicket(ticketId, fixture.actor));
    expect(
      assembled.invoice.currencyCode,
      assertionMessage('JPY assembly', 'JPY', 'invoices.currency_code', 'JPY', assembled.invoice.currencyCode),
    ).toBe('JPY');
    expect(assembled.blockedByCurrency, 'no JPY work may be blocked on a JPY draft').toEqual([]);
    expect(assembled.missingRate, 'both JPY entries carry a rate').toEqual([]);

    const lines = await readInvoiceLines(assembled.invoice.id);
    expect(lines, assertionMessage('JPY assembly', 'JPY', 'invoice_lines count', 2, lines.length)).toHaveLength(2);
    const whole = lines.find((l) => l.sourceId === wholeEntry.id);
    const fractional = lines.find((l) => l.sourceId === fractionalEntry.id);
    expectMoney(whole?.lineTotal, 12000, 'JPY', '1.5h x 8000 JPY');
    expectMoney(fractional?.lineTotal, 83, 'JPY', '0.25h x 333 JPY rounded once');

    await withSystemDbAccessContext(() => issueInvoice(assembled.invoice.id, fixture.actor));
    const [issued] = await withSystemDbAccessContext(() => db
      .select({ subtotal: invoices.subtotal, taxTotal: invoices.taxTotal, total: invoices.total, balance: invoices.balance })
      .from(invoices).where(eq(invoices.id, assembled.invoice.id)).limit(1));
    expectMoney(issued?.subtotal, 12083, 'JPY', 'issued JPY subtotal');
    for (const money of [issued?.subtotal, issued?.taxTotal, issued?.total, issued?.balance]) {
      expect(
        Number(money) % 1,
        assertionMessage('JPY zero-decimal persistence', 'JPY', 'invoices money column', 'whole yen', money),
      ).toBe(0);
    }
    for (const l of lines) {
      expect(
        Number(l.lineTotal) % 1,
        assertionMessage('JPY zero-decimal persistence', 'JPY', 'invoice_lines.line_total', 'whole yen', l.lineTotal),
      ).toBe(0);
      expect(
        Number(l.unitPrice) % 1,
        assertionMessage('JPY zero-decimal persistence', 'JPY', 'invoice_lines.unit_price', 'whole yen', l.unitPrice),
      ).toBe(0);
    }
  });

  it('rejects a fractional JPY org default hourly rate at write time', async () => {
    const fixture = await seedGateOrg('JPY');

    // W6-G4-1 (EXPECTED RED): ticketConfigService.upsertOrgTicketSettings writes
    // String(input.defaultHourlyRate) with no representability guard, and the
    // shared validator only enforces multipleOf(0.01) — so ¥100.50 is persisted
    // as the org default and every future JPY time entry inherits it.
    await expect(
      withSystemDbAccessContext(() => upsertOrgTicketSettings(
        fixture.orgId, { defaultHourlyRate: 100.5, defaultBillable: true },
      )),
      'a JPY org default hourly rate of 100.50 must be rejected at write time',
    ).rejects.toThrow();
  });

  it('rejects a fractional JPY time-entry hourly rate at write time', async () => {
    const fixture = await seedGateOrg('JPY');
    const ticketId = await seedTicket(fixture, 'W6 G4 JPY fractional rate');

    // W6-G4-2 (EXPECTED RED): timeEntryService.createTimeEntry stamps the JPY
    // currency snapshot but stores toRate(input.hourlyRate) verbatim, so the
    // entry persists an unrepresentable ¥100.50 rate that assembly later turns
    // into a JPY line at a cent-scale unit price.
    await expect(
      withSystemDbAccessContext(() => createTimeEntry(
        { ticketId, startedAt: T0, endedAt: minutesAfter(T0, 60), hourlyRate: 100.5, isBillable: true },
        timeActor(fixture),
      )),
      'a JPY time entry with a 100.50 hourly rate must be rejected at write time',
    ).rejects.toThrow();

    const rows = await withSystemDbAccessContext(() => db
      .select({ hourlyRate: timeEntries.hourlyRate }).from(timeEntries).where(eq(timeEntries.ticketId, ticketId)));
    expect(rows, 'no unrepresentable JPY time entry may be persisted').toHaveLength(0);
  });

  it('rejects a fractional JPY part unit price at write time', async () => {
    const fixture = await seedGateOrg('JPY');
    const ticketId = await seedTicket(fixture, 'W6 G4 JPY fractional part');

    // W6-G4-3 (EXPECTED RED): timeEntryService.addTicketPart writes
    // (input.unitPrice ?? 0).toFixed(2) with no representability guard, so
    // ¥100.50 is persisted on a JPY-stamped part.
    await expect(
      withSystemDbAccessContext(() => addTicketPart(
        ticketId,
        { description: 'Fractional yen part', quantity: 1, unitPrice: 100.5 },
        timeActor(fixture),
      )),
      'a JPY part priced 100.50 must be rejected at write time',
    ).rejects.toThrow();

    const rows = await withSystemDbAccessContext(() => db
      .select({ unitPrice: ticketParts.unitPrice }).from(ticketParts).where(eq(ticketParts.ticketId, ticketId)));
    expect(rows, 'no unrepresentable JPY part may be persisted').toHaveLength(0);
  });
});
