/**
 * Multi-currency wave 6 (#3778), spec §5: the ORG CURRENCY CHANGE against a
 * real database — preflight summary, the locked change transaction, and the
 * owner-fixed guarantee that the change is FUTURE-ONLY.
 *
 * What this proves, and why each assertion exists:
 *  - the preflight groups rows by their OWN stamp (a EUR document and a legacy
 *    USD part are reported separately, never summed);
 *  - the change to a third currency commits and every pre-existing row is
 *    BYTE-FOR-BYTE unchanged (full-row snapshots before/after) — nothing is
 *    restamped, nothing is converted, no `updated_at` is even touched;
 *  - a document created AFTER the change stamps the NEW currency;
 *  - old-currency billables stay recoverable via an explicit same-currency
 *    assembly (`assembleDraftFromOrg({ …, currencyCode })`, spec §7);
 *  - a second request carrying the now-stale `expectedCurrentCurrencyCode` is a
 *    409 carrying a FRESH impact summary (optimistic concurrency).
 *
 * Driven through `updateOrgBillingSettings` — the service behind
 * `PATCH /orgs/:orgId/billing-settings` — so the delegation added in Task 11
 * is exercised, not bypassed.
 *
 * Runs under vitest.integration.config.ts against a real Postgres. No fixture
 * memoization — integration/setup.ts TRUNCATEs partners/organizations before
 * every test, so each test re-seeds fresh.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ / event side effects are not the correctness under
// test (same rationale as the wave-6 gate slices). Everything monetary is real.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', () => ({ emitTicketEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  catalogItemOrgPricing, contracts, invoices, organizations, orgTicketSettings, ticketParts, tickets, timeEntries,
} from '../../db/schema';
import {
  activateContract, addContractLineToContract, createContract,
} from '../../services/contractService';
import { assembleDraftFromOrg, createManualInvoice, updateOrgBillingSettings } from '../../services/invoiceService';
import { getOrgCurrencyImpact } from '../../services/orgCurrencyService';
import { createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { upsertOrgTicketSettings } from '../../services/ticketConfigService';
import { createTicket } from '../../services/ticketService';
import { createCatalogItemWithPrice } from './db-utils';
import { seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

const START_DATE = '2026-07-01';
const T0 = new Date('2026-07-01T09:00:00Z');
const T90 = new Date('2026-07-01T10:30:00Z');
const ORG_RATE = 85.5;

function timeActor(fixture: GateOrgFixture): TimeEntryActor {
  return {
    userId: fixture.userId, name: 'W6 Technician', partnerId: fixture.partnerId,
    manageAll: true, accessibleOrgIds: [fixture.orgId],
  };
}

interface Seeded {
  fixture: GateOrgFixture;
  invoiceId: string;
  contractId: string;
  timeEntryId: string;
  legacyPartId: string;
  catalogItemId: string;
}

/**
 * A EUR org (USD partner) holding one of everything the preflight reports:
 * a EUR draft invoice, a EUR ACTIVE contract, a EUR unbilled billable time
 * entry, a LEGACY USD unbilled part, a EUR org default hourly rate, and a EUR
 * catalog org override.
 *
 * The legacy USD part is inserted directly: `addTicketPart` stamps the org's
 * CURRENT currency (that is the wave-4 guarantee), so a wrong-currency snapshot
 * can only arise from history — which is exactly the row this preflight must
 * report under its OWN code rather than the org's.
 */
async function seedEurOrg(): Promise<Seeded> {
  const fixture = await seedGateOrg('EUR');

  await withSystemDbAccessContext(() => upsertOrgTicketSettings(
    fixture.orgId, { defaultHourlyRate: ORG_RATE, defaultBillable: true },
  ));

  const invoice = await withSystemDbAccessContext(() => createManualInvoice(
    { orgId: fixture.orgId, notes: 'W6 org-currency draft' }, fixture.actor,
  ));

  const contract = await withSystemDbAccessContext(() => createContract({
    orgId: fixture.orgId, name: 'W6 org-currency contract', billingTiming: 'advance',
    intervalMonths: 1, startDate: START_DATE,
  }, fixture.actor));
  await withSystemDbAccessContext(() => addContractLineToContract(contract.id, {
    lineType: 'flat', description: 'Service desk retainer', unitPrice: '250.00', taxable: false, sortOrder: 1,
  }, fixture.actor));
  await withSystemDbAccessContext(() => activateContract(contract.id, fixture.actor, T0));

  const ticket = await withSystemDbAccessContext(() => createTicket(
    { orgId: fixture.orgId, subject: 'W6 org-currency ticket', source: 'manual' },
    { userId: fixture.userId, name: 'W6 Technician' },
  ));
  const entry = await withSystemDbAccessContext(() => createTimeEntry(
    { ticketId: ticket.id as string, startedAt: T0, endedAt: T90 }, timeActor(fixture),
  ));

  const [legacyPart] = await withSystemDbAccessContext(() => db.insert(ticketParts).values({
    ticketId: ticket.id as string, orgId: fixture.orgId, description: 'Legacy USD spare',
    quantity: '2.00', unitPrice: '10.00', currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed',
    // Dated with the rest of the fixture so it falls inside the recovery
    // assembly's [from, to] window (gatherOrgParts filters on created_at).
    createdAt: T0,
  }).returning({ id: ticketParts.id }));

  const item = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
    partnerId: fixture.partnerId, name: 'W6 org-currency item', currencyCode: 'EUR', unitPrice: '49.99',
  }));
  await withSystemDbAccessContext(() => db.insert(catalogItemOrgPricing).values({
    catalogItemId: item.id, orgId: fixture.orgId, partnerId: fixture.partnerId,
    currencyCode: 'EUR', unitPrice: '44.99',
  }));

  return {
    fixture, invoiceId: invoice.id, contractId: contract.id,
    timeEntryId: entry.id, legacyPartId: legacyPart!.id, catalogItemId: item.id,
  };
}

/** Full-row snapshots of everything the change must NOT touch. */
async function snapshotRows(s: Seeded) {
  return withSystemDbAccessContext(async () => ({
    invoice: await db.select().from(invoices).where(eq(invoices.id, s.invoiceId)),
    contract: await db.select().from(contracts).where(eq(contracts.id, s.contractId)),
    timeEntry: await db.select().from(timeEntries).where(eq(timeEntries.id, s.timeEntryId)),
    part: await db.select().from(ticketParts).where(eq(ticketParts.id, s.legacyPartId)),
    rateSettings: await db.select().from(orgTicketSettings).where(eq(orgTicketSettings.orgId, s.fixture.orgId)),
    override: await db.select().from(catalogItemOrgPricing).where(eq(catalogItemOrgPricing.orgId, s.fixture.orgId)),
  }));
}

async function readOrgCurrency(orgId: string): Promise<string | undefined> {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1));
  return row?.currencyCode;
}

describe.runIf(RUN)('org currency change (#3778, spec §5)', () => {
  it('reports the preflight grouped by each row\'s OWN stamp, plus the configuration warnings', async () => {
    const s = await seedEurOrg();

    const impact = await withSystemDbAccessContext(() => getOrgCurrencyImpact(s.fixture.orgId, 'GBP', s.fixture.actor));

    expect(impact.currentCurrencyCode).toBe('EUR');
    expect(impact.targetCurrencyCode).toBe('GBP');
    expect(impact.changeRequired).toBe(true);
    // Two groups, by the ROWS' own codes — never one merged total.
    expect(impact.impactsByCurrency.map((g) => g.currencyCode)).toEqual(['EUR', 'USD']);

    const eur = impact.impactsByCurrency.find((g) => g.currencyCode === 'EUR')!;
    expect(eur.documents.draftInvoices).toBe(1);
    expect(eur.contracts.active).toBe(1);
    expect(eur.billables.monetaryTimeSnapshots).toBe(1);
    expect(eur.billables.readyTimeEntries).toBe(1);
    // 90 min at 85.50/h = 1.50h x 85.50 = 128.25 EUR, rounded once at the EUR minor unit.
    expect(eur.billables.laborAmount).toBe('128.25');
    expect(eur.billables.monetaryPartSnapshots).toBe(0);
    expect(eur.recovery).toEqual({ kind: 'assemble_draft', currencyCode: 'EUR' });

    const usd = impact.impactsByCurrency.find((g) => g.currencyCode === 'USD')!;
    expect(usd.billables.monetaryPartSnapshots).toBe(1);
    expect(usd.billables.readyParts).toBe(1);
    expect(usd.billables.partAmount).toBe('20.00');
    // The legacy USD part is NOT attributed to the org's current currency.
    expect(usd.documents.draftInvoices).toBe(0);
    expect(usd.billables.monetaryTimeSnapshots).toBe(0);
    expect(usd.recovery).toEqual({ kind: 'assemble_draft', currencyCode: 'USD' });

    // Match-or-skip: the EUR org default rate stops applying under GBP, and the
    // EUR catalog override is skipped by resolvePrice (it cannot coexist with a
    // GBP one — UNIQUE(catalog_item_id, org_id)).
    expect(impact.configurationWarnings.orgDefaultRate)
      .toEqual({ configured: true, rateCurrency: 'EUR', willStopApplying: true });
    expect(impact.configurationWarnings.orgCatalogOverridesSkipped).toBe(1);
  });

  it('separates rate-less time stranded in an OLD currency from rate-less time already in the TARGET (review 6)', async () => {
    const s = await seedEurOrg();
    const [ticket] = await withSystemDbAccessContext(() => db
      .select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, s.fixture.orgId)).limit(1));

    // Two unbilled entries with hours but NO rate: one stranded in EUR, one
    // already stamped in the target GBP (history a wave-2+ org can hold).
    await withSystemDbAccessContext(() => db.insert(timeEntries).values([
      {
        partnerId: s.fixture.partnerId, orgId: s.fixture.orgId, ticketId: ticket!.id,
        userId: s.fixture.userId, startedAt: T0, endedAt: T90, durationMinutes: 90,
        description: 'Rate-less EUR', isBillable: true, hourlyRate: null,
        currencyCode: 'EUR', billingStatus: 'not_billed',
      },
      {
        partnerId: s.fixture.partnerId, orgId: s.fixture.orgId, ticketId: ticket!.id,
        userId: s.fixture.userId, startedAt: T0, endedAt: T90, durationMinutes: 90,
        description: 'Rate-less GBP', isBillable: true, hourlyRate: null,
        currencyCode: 'GBP', billingStatus: 'not_billed',
      },
    ]));

    const impact = await withSystemDbAccessContext(() => getOrgCurrencyImpact(s.fixture.orgId, 'GBP', s.fixture.actor));

    // The GBP one is NOT stranded: it must never raise a GBP group telling the
    // operator to assemble a GBP draft for billables that are already in GBP.
    expect(impact.impactsByCurrency.map((g) => g.currencyCode)).toEqual(['EUR', 'USD']);
    expect(impact.configurationWarnings.rateLessTimeEntries).toBe(1);
    // The EUR one IS stranded, and stays inside the EUR group.
    const eur = impact.impactsByCurrency.find((g) => g.currencyCode === 'EUR')!;
    expect(eur.billables.missingRateTimeEntries).toBe(1);
    // It carries hours but no amount, so it never inflates the EUR labor sum.
    expect(eur.billables.laborAmount).toBe('128.25');
  });

  it('commits the change, leaves every pre-existing row byte-for-byte unchanged, and stamps GBP on FUTURE documents', async () => {
    const s = await seedEurOrg();
    const before = await snapshotRows(s);

    const result = await withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId,
      { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true },
      s.fixture.actor,
    )) as { currencyCode: string; currencyChange: { previousCurrencyCode: string; currencyCode: string } };

    expect(result.currencyCode).toBe('GBP');
    expect(result.currencyChange.previousCurrencyCode).toBe('EUR');
    expect(result.currencyChange.currencyCode).toBe('GBP');
    expect(await readOrgCurrency(s.fixture.orgId)).toBe('GBP');

    // NOTHING historical is restamped and no amount is converted — not even
    // `updated_at` moves on a row the change did not write.
    const after = await snapshotRows(s);
    expect(after).toEqual(before);

    // FUTURE documents take the new stamp.
    const future = await withSystemDbAccessContext(() => createManualInvoice(
      { orgId: s.fixture.orgId, notes: 'post-change draft' }, s.fixture.actor,
    ));
    expect(future.currencyCode).toBe('GBP');
  });

  it('keeps old-currency billables recoverable through an explicit same-currency assembly (spec §7)', async () => {
    const s = await seedEurOrg();
    await withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId,
      { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true },
      s.fixture.actor,
    ));

    const assembled = await withSystemDbAccessContext(() => assembleDraftFromOrg(
      { orgId: s.fixture.orgId, from: '2026-06-01', to: '2026-07-31', currencyCode: 'EUR' },
      s.fixture.actor,
    ));

    expect(assembled.invoice.currencyCode).toBe('EUR');
    const laborLine = assembled.lines.find((l) => l.sourceId === s.timeEntryId);
    expect(laborLine, 'the pre-change EUR time entry must still be invoiceable in EUR').toBeDefined();
    expect(Number(laborLine!.lineTotal)).toBe(128.25);
    // The legacy USD part is reported under its own currency — never converted
    // into the EUR draft.
    expect(assembled.blockedByCurrency.map((b) => b.currencyCode)).toEqual(['USD']);
  });

  it('rejects a stale precondition with 409 ORG_CURRENCY_CHANGED carrying a FRESH impact summary', async () => {
    const s = await seedEurOrg();
    await withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId,
      { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true },
      s.fixture.actor,
    ));

    await expect(withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId,
      { currencyCode: 'JPY', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true },
      s.fixture.actor,
    ))).rejects.toMatchObject({
      status: 409,
      code: 'ORG_CURRENCY_CHANGED',
      details: {
        currentCurrencyCode: 'GBP',
        impact: { currentCurrencyCode: 'GBP', targetCurrencyCode: 'JPY' },
      },
    });

    // The refused request wrote nothing.
    expect(await readOrgCurrency(s.fixture.orgId)).toBe('GBP');
  });

  it('rejects a REAL change with no confirmation, and treats a same-currency request as an idempotent no-op', async () => {
    const s = await seedEurOrg();

    await expect(withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId, { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR' }, s.fixture.actor,
    ))).rejects.toMatchObject({ status: 400, code: 'CONFIRMATION_REQUIRED' });
    expect(await readOrgCurrency(s.fixture.orgId)).toBe('EUR');

    // Same-currency: no confirmation required, no write, no error.
    const noop = await withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId, { currencyCode: 'EUR', expectedCurrentCurrencyCode: 'EUR' }, s.fixture.actor,
    )) as { currencyChange: { previousCurrencyCode: string; currencyCode: string } };
    expect(noop.currencyChange).toMatchObject({ previousCurrencyCode: 'EUR', currencyCode: 'EUR' });
    expect(await readOrgCurrency(s.fixture.orgId)).toBe('EUR');
  });

  it('refuses to mix a currency change with other billing-settings fields (lock-order decision, Task 11 Step 5)', async () => {
    const s = await seedEurOrg();
    await expect(withSystemDbAccessContext(() => updateOrgBillingSettings(
      s.fixture.orgId,
      { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true, taxId: 'VAT-1' },
      s.fixture.actor,
    ))).rejects.toMatchObject({ status: 400, code: 'INVALID_STATE' });
    expect(await readOrgCurrency(s.fixture.orgId)).toBe('EUR');
  });
});
