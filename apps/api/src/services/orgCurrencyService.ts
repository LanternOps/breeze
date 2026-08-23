/**
 * Org currency change (multi-currency wave 6, #3778) — spec §5.
 *
 * Two operations:
 *   getOrgCurrencyImpact — read-only, ADVISORY preflight summary. Counts are a
 *     preview, never a blocker and never a promise: rows can be created between
 *     the preview and the change (the Task 12 SHARE barrier is what makes the
 *     cutover exact, not this count).
 *   changeOrgCurrency  — the ONLY writer of `organizations.currency_code` after
 *     creation. Single-row transaction: `organizations FOR UPDATE` is its first
 *     and only lock, so it can never be the second edge of a lock cycle.
 *
 * Owner-fixed semantics, never relitigated:
 *   - the change affects FUTURE documents / time entries / parts ONLY;
 *   - nothing historical is restamped and no amount is EVER converted;
 *   - old-currency billables stay recoverable through an explicit same-currency
 *     assembly (`assembleDraftFromOrg({ …, currencyCode })`, spec §7) — which is
 *     why every impact group carries its own `recovery` instruction;
 *   - drafts, active contracts, unbilled billables, skipped rates and skipped
 *     overrides are WARNINGS, never rejections.
 *
 * Lives outside `invoiceService.ts` (already ~1.4k lines) and throws
 * `InvoiceServiceError` at its own boundary so the existing route error mapper
 * keeps working unchanged; the reusable primitives live in the dependency-free
 * `orgCurrencyCore.ts` (see the cycle note there).
 */
import { and, count, eq, inArray, isNull, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  catalogItemOrgPricing, contracts, invoices, organizations, orgTicketSettings,
  quotes, ticketCategories, ticketParts, timeEntries
} from '../db/schema';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { UNKNOWN_CURRENCY_KEY } from './invoiceAssembly';
import {
  OrgCurrencyServiceError, requireOrgAccessById, type DbExecutor
} from './orgCurrencyCore';
import { fromMinorUnits, multiplyToCurrency, toMinorUnits } from '@breeze/shared';

/** Per-currency slice of the preflight. `currencyCode` is always the ROW's own
 *  stamp — amounts are NEVER summed across currencies. */
export interface OrgCurrencyImpactGroup {
  currencyCode: string;
  documents: { draftInvoices: number; draftQuotes: number; sentQuotes: number; viewedQuotes: number };
  contracts: { draft: number; active: number; paused: number };
  billables: {
    monetaryTimeSnapshots: number; readyTimeEntries: number; runningTimeEntries: number;
    currentlyNonBillableTimeEntries: number; missingRateTimeEntries: number; laborAmount: string | null;
    monetaryPartSnapshots: number; readyParts: number; currentlyNonBillableParts: number; partAmount: string;
  };
  /** The spec §7 recovery action for this group: assemble a draft in THIS currency. */
  recovery: { kind: 'assemble_draft'; currencyCode: string };
}

export interface OrgCurrencyImpact {
  orgId: string;
  currentCurrencyCode: string;
  targetCurrencyCode: string;
  changeRequired: boolean;
  impactsByCurrency: OrgCurrencyImpactGroup[];
  configurationWarnings: {
    orgDefaultRate: { configured: boolean; rateCurrency: string | null; willStopApplying: boolean };
    categoryRatesSkipped: number;
    orgCatalogOverridesSkipped: number;
  };
}

export interface ChangeOrgCurrencyInput {
  currencyCode: string;
  expectedCurrentCurrencyCode: string;
  confirmSnapshotRetention?: boolean;
}

export interface ChangeOrgCurrencyResult {
  orgId: string;
  previousCurrencyCode: string;
  currencyCode: string;
  impact: OrgCurrencyImpact;
}

/** Map the neutral core error onto this service's boundary class. */
function mapCoreError(err: unknown): never {
  if (err instanceof OrgCurrencyServiceError) {
    throw new InvoiceServiceError(err.message, err.status, err.code, err.details);
  }
  throw err;
}

function requireOrg(actor: InvoiceActor, orgId: string): void {
  try { requireOrgAccessById(actor, orgId); } catch (err) { mapCoreError(err); }
}

function emptyGroup(currencyCode: string): OrgCurrencyImpactGroup {
  return {
    currencyCode,
    documents: { draftInvoices: 0, draftQuotes: 0, sentQuotes: 0, viewedQuotes: 0 },
    contracts: { draft: 0, active: 0, paused: 0 },
    billables: {
      monetaryTimeSnapshots: 0, readyTimeEntries: 0, runningTimeEntries: 0,
      currentlyNonBillableTimeEntries: 0, missingRateTimeEntries: 0, laborAmount: null,
      monetaryPartSnapshots: 0, readyParts: 0, currentlyNonBillableParts: 0, partAmount: '0'
    },
    recovery: { kind: 'assemble_draft', currencyCode }
  };
}

/** Labor rule, identical to `invoiceAssembly.timeEntryToLineSpec`: hours rounded
 *  to 2dp FIRST (the numeric(10,2) quantity schema), then one currency-aware
 *  multiply. 20 min x 1,000 JPY = 0.33 x 1000 = 330, never 333. */
function laborAmountFor(durationMinutes: number | null, hourlyRate: string, currency: string): string {
  const hours = ((durationMinutes ?? 0) / 60).toFixed(2);
  return multiplyToCurrency(hours, hourlyRate, currency);
}

/**
 * Advisory, read-only preflight for a prospective change to `targetCurrencyCode`.
 * Every predicate compares the ROW's own `currency_code` against the TARGET (not
 * against the org's current value — a legacy row stamped in a third currency is
 * just as stranded and must be reported under its own code).
 */
export async function getOrgCurrencyImpact(
  orgId: string,
  targetCurrencyCode: string,
  actor: InvoiceActor,
  dbc: DbExecutor = db
): Promise<OrgCurrencyImpact> {
  requireOrg(actor, orgId);
  const target = targetCurrencyCode;

  const [org] = await dbc
    .select({ id: organizations.id, partnerId: organizations.partnerId, currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');

  const groups = new Map<string, OrgCurrencyImpactGroup>();
  const group = (code: string | null): OrgCurrencyImpactGroup => {
    const key = code ?? UNKNOWN_CURRENCY_KEY;
    let g = groups.get(key);
    if (!g) { g = emptyGroup(key); groups.set(key, g); }
    return g;
  };

  // --- documents -----------------------------------------------------------
  const draftInvoiceRows = await dbc
    .select({ currencyCode: invoices.currencyCode, n: count() })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), eq(invoices.status, 'draft'), ne(invoices.currencyCode, target)))
    .groupBy(invoices.currencyCode);
  for (const r of draftInvoiceRows) group(r.currencyCode).documents.draftInvoices = Number(r.n);

  const quoteRows = await dbc
    .select({ currencyCode: quotes.currencyCode, status: quotes.status, n: count() })
    .from(quotes)
    .where(and(
      eq(quotes.orgId, orgId),
      inArray(quotes.status, ['draft', 'sent', 'viewed']),
      ne(quotes.currencyCode, target)
    ))
    .groupBy(quotes.currencyCode, quotes.status);
  for (const r of quoteRows) {
    const docs = group(r.currencyCode).documents;
    if (r.status === 'draft') docs.draftQuotes = Number(r.n);
    else if (r.status === 'sent') docs.sentQuotes = Number(r.n);
    else if (r.status === 'viewed') docs.viewedQuotes = Number(r.n);
  }

  const contractRows = await dbc
    .select({ currencyCode: contracts.currencyCode, status: contracts.status, n: count() })
    .from(contracts)
    .where(and(
      eq(contracts.orgId, orgId),
      inArray(contracts.status, ['draft', 'active', 'paused']),
      ne(contracts.currencyCode, target)
    ))
    .groupBy(contracts.currencyCode, contracts.status);
  for (const r of contractRows) {
    const c = group(r.currencyCode).contracts;
    if (r.status === 'draft') c.draft = Number(r.n);
    else if (r.status === 'active') c.active = Number(r.n);
    else if (r.status === 'paused') c.paused = Number(r.n);
  }

  // --- billables -----------------------------------------------------------
  // Monetary time: deliberately ignores `is_billable` (it can be switched on
  // later, and the snapshot is already stranded either way). Amounts are summed
  // in MINOR UNITS within one currency group only — never across groups.
  const timeRows = await dbc
    .select({
      currencyCode: timeEntries.currencyCode, hourlyRate: timeEntries.hourlyRate,
      durationMinutes: timeEntries.durationMinutes, isBillable: timeEntries.isBillable,
      endedAt: timeEntries.endedAt
    })
    .from(timeEntries)
    .where(and(
      eq(timeEntries.orgId, orgId),
      eq(timeEntries.billingStatus, 'not_billed'),
      isNotNull(timeEntries.hourlyRate),
      ne(timeEntries.currencyCode, target)
    ));
  const laborMinor = new Map<string, number>();
  for (const r of timeRows) {
    const key = r.currencyCode ?? UNKNOWN_CURRENCY_KEY;
    const b = group(r.currencyCode).billables;
    b.monetaryTimeSnapshots += 1;
    if (r.endedAt === null) b.runningTimeEntries += 1;
    if (!r.isBillable) b.currentlyNonBillableTimeEntries += 1;
    if (r.isBillable && r.endedAt !== null) b.readyTimeEntries += 1;
    const amount = laborAmountFor(r.durationMinutes, r.hourlyRate ?? '0', key);
    laborMinor.set(key, (laborMinor.get(key) ?? 0) + toMinorUnits(amount, key));
  }
  for (const [key, minor] of laborMinor) group(key).billables.laborAmount = fromMinorUnits(minor, key);

  // Missing-rate time: hours but no amount. Match-or-skip found no rate in the
  // org's currency, so assembly treats it as a gap (never a zero line). Reported
  // under its own stamp with no amount, and NOT filtered on the target currency
  // — the gap exists regardless of which currency the row carries.
  const missingRateRows = await dbc
    .select({ currencyCode: timeEntries.currencyCode, n: count() })
    .from(timeEntries)
    .where(and(
      eq(timeEntries.orgId, orgId),
      eq(timeEntries.billingStatus, 'not_billed'),
      isNull(timeEntries.hourlyRate)
    ))
    .groupBy(timeEntries.currencyCode);
  for (const r of missingRateRows) group(r.currencyCode).billables.missingRateTimeEntries = Number(r.n);

  // Parts: `unit_price` is NOT NULL, so every unbilled part is monetary.
  const partRows = await dbc
    .select({
      currencyCode: ticketParts.currencyCode, quantity: ticketParts.quantity,
      unitPrice: ticketParts.unitPrice, isBillable: ticketParts.isBillable
    })
    .from(ticketParts)
    .where(and(
      eq(ticketParts.orgId, orgId),
      eq(ticketParts.billingStatus, 'not_billed'),
      ne(ticketParts.currencyCode, target)
    ));
  const partMinor = new Map<string, number>();
  for (const r of partRows) {
    const key = r.currencyCode ?? UNKNOWN_CURRENCY_KEY;
    const b = group(r.currencyCode).billables;
    b.monetaryPartSnapshots += 1;
    if (r.isBillable) b.readyParts += 1; else b.currentlyNonBillableParts += 1;
    const amount = multiplyToCurrency(r.quantity, r.unitPrice, key);
    partMinor.set(key, (partMinor.get(key) ?? 0) + toMinorUnits(amount, key));
  }
  for (const [key, minor] of partMinor) group(key).billables.partAmount = fromMinorUnits(minor, key);

  // --- configuration warnings ---------------------------------------------
  // Match-or-skip (timeEntryService.resolveDefaultRate): a default rate applies
  // ONLY when it was entered under the org's currency. A rate in another
  // currency is silently skipped — surface that BEFORE the change, not after.
  const [rateSettings] = await dbc
    .select({ defaultHourlyRate: orgTicketSettings.defaultHourlyRate, rateCurrency: orgTicketSettings.rateCurrency })
    .from(orgTicketSettings).where(eq(orgTicketSettings.orgId, orgId)).limit(1);
  const rateConfigured = !!rateSettings && rateSettings.defaultHourlyRate !== null;

  const [categorySkipped] = await dbc
    .select({ n: count() })
    .from(ticketCategories)
    .where(and(
      eq(ticketCategories.partnerId, org.partnerId),
      isNotNull(ticketCategories.defaultHourlyRate),
      sql`${ticketCategories.rateCurrency} IS DISTINCT FROM ${target}`
    ));

  const [overridesSkipped] = await dbc
    .select({ n: count() })
    .from(catalogItemOrgPricing)
    .where(and(eq(catalogItemOrgPricing.orgId, orgId), ne(catalogItemOrgPricing.currencyCode, target)));

  return {
    orgId,
    currentCurrencyCode: org.currencyCode,
    targetCurrencyCode: target,
    changeRequired: org.currencyCode !== target,
    impactsByCurrency: [...groups.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)),
    configurationWarnings: {
      orgDefaultRate: {
        configured: rateConfigured,
        rateCurrency: rateSettings?.rateCurrency ?? null,
        willStopApplying: rateConfigured && rateSettings!.rateCurrency !== target
      },
      categoryRatesSkipped: Number(categorySkipped?.n ?? 0),
      orgCatalogOverridesSkipped: Number(overridesSkipped?.n ?? 0)
    }
  };
}

/**
 * The org currency change. Transaction order is load-bearing (spec §5, #3778):
 *   1. fast-fail authorization OUTSIDE the transaction;
 *   2. `organizations FOR UPDATE` as the transaction's FIRST statement — and the
 *      only row this transaction ever locks;
 *   3. re-authorize against the LOCKED row;
 *   4. optimistic precondition (409 ORG_CURRENCY_CHANGED, body carries a fresh
 *      impact summary so the caller can re-confirm against reality);
 *   5. same-currency request is an idempotent no-op — no confirmation, no write;
 *   6. a REAL change requires `confirmSnapshotRetention === true` (400) — the
 *      validator cannot know this, only the locked row can (see the wave-6 plan,
 *      minor 13);
 *   7. recompute the impact INSIDE the transaction, then UPDATE.
 */
export async function changeOrgCurrency(
  orgId: string,
  input: ChangeOrgCurrencyInput,
  actor: InvoiceActor
): Promise<ChangeOrgCurrencyResult> {
  requireOrg(actor, orgId); // fast-fail only; re-checked under the lock below

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: organizations.id, currencyCode: organizations.currencyCode })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1).for('update');
    if (!locked) throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    requireOrg(actor, locked.id);

    if (locked.currencyCode !== input.expectedCurrentCurrencyCode) {
      const impact = await getOrgCurrencyImpact(orgId, input.currencyCode, actor, tx);
      throw new InvoiceServiceError(
        'The organization currency changed since this summary was taken', 409, 'ORG_CURRENCY_CHANGED',
        { currentCurrencyCode: locked.currencyCode, expectedCurrentCurrencyCode: input.expectedCurrentCurrencyCode, impact }
      );
    }

    // Idempotent no-op: a same-currency PATCH writes nothing and needs no
    // confirmation (there is no snapshot to retain).
    if (locked.currencyCode === input.currencyCode) {
      const impact = await getOrgCurrencyImpact(orgId, input.currencyCode, actor, tx);
      return { orgId, previousCurrencyCode: locked.currencyCode, currencyCode: locked.currencyCode, impact };
    }

    if (input.confirmSnapshotRetention !== true) {
      throw new InvoiceServiceError(
        'Changing the organization currency requires confirmSnapshotRetention', 400, 'CONFIRMATION_REQUIRED'
      );
    }

    const impact = await getOrgCurrencyImpact(orgId, input.currencyCode, actor, tx);
    await tx.update(organizations)
      .set({ currencyCode: input.currencyCode, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));

    return {
      orgId,
      previousCurrencyCode: locked.currencyCode,
      currencyCode: input.currencyCode,
      impact
    };
  });
}
