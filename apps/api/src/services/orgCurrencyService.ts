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
import { minorUnitExponent, roundToCurrency } from '@breeze/shared';

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
    /** Unbilled time with hours but NO hourly rate, stamped in the TARGET
     *  currency or not stamped at all (review 6). These are not stranded by the
     *  change and must never appear as an impact group: their fix is "set a
     *  rate", never "assemble a draft in <currency>" — and an unstamped row has
     *  no currency an assembly could even be addressed to. Rate-less rows in an
     *  OLD currency ARE stranded and stay inside that currency's group. */
    rateLessTimeEntries: number;
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

/** The labor rule of `invoiceAssembly.timeEntryToLineSpec`, expressed in SQL so
 *  the preflight never pulls a row into JS (review 4): hours rounded to 2dp
 *  FIRST (the numeric(10,2) quantity schema), then ONE half-up round at the
 *  currency's minor unit — 20 min x 1,000 JPY = 0.33 x 1000 = 330, never 333.
 *  `exp` is the minor-unit exponent; both variants are summed in the same pass
 *  and the caller picks the one matching each group's currency, which keeps the
 *  whole preflight to a single aggregate query per source table. */
function laborSumSql(exp: 0 | 2) {
  return sql<string>`coalesce(sum(round(round(coalesce(${timeEntries.durationMinutes}, 0) / 60.0, 2) * ${timeEntries.hourlyRate}, ${exp})), 0)`;
}

function partSumSql(exp: 0 | 2) {
  return sql<string>`coalesce(sum(round(${ticketParts.quantity} * ${ticketParts.unitPrice}, ${exp})), 0)`;
}

/** Pick the aggregate computed at this currency's minor unit and format it as
 *  the fixed-2 string every monetary field in this payload uses. The sum is a
 *  sum of already-rounded per-row amounts, so this only formats. */
function amountFor(sum2: string, sum0: string, currency: string): string {
  return roundToCurrency(minorUnitExponent(currency) === 0 ? sum0 : sum2, currency);
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
  // later, and the snapshot is already stranded either way). Counts AND sums are
  // computed by Postgres, one row per currency — never one row per entry
  // (review 4). `hourly_rate IS NOT NULL` plus `org_id = :orgId` means
  // `currency_code` cannot be NULL here (the time_entries CHECK allows a NULL
  // stamp only on an unrated, org-less row), so this query never invents a group.
  const timeRows = await dbc
    .select({
      currencyCode: timeEntries.currencyCode,
      monetary: count(),
      running: sql<string>`count(*) filter (where ${timeEntries.endedAt} is null)`,
      nonBillable: sql<string>`count(*) filter (where ${timeEntries.isBillable} = false)`,
      ready: sql<string>`count(*) filter (where ${timeEntries.isBillable} = true and ${timeEntries.endedAt} is not null)`,
      labor2: laborSumSql(2),
      labor0: laborSumSql(0)
    })
    .from(timeEntries)
    .where(and(
      eq(timeEntries.orgId, orgId),
      eq(timeEntries.billingStatus, 'not_billed'),
      isNotNull(timeEntries.hourlyRate),
      ne(timeEntries.currencyCode, target)
    ))
    .groupBy(timeEntries.currencyCode);
  for (const r of timeRows) {
    const key = r.currencyCode ?? UNKNOWN_CURRENCY_KEY;
    const b = group(r.currencyCode).billables;
    b.monetaryTimeSnapshots = Number(r.monetary);
    b.runningTimeEntries = Number(r.running);
    b.currentlyNonBillableTimeEntries = Number(r.nonBillable);
    b.readyTimeEntries = Number(r.ready);
    b.laborAmount = amountFor(r.labor2, r.labor0, key);
  }

  // Rate-less time: hours but no amount. Match-or-skip found no rate in the
  // org's currency, so assembly treats it as a gap (never a zero line). NOT
  // filtered on the target currency, because the gap exists whatever the row
  // carries — but the two halves mean different things and get different
  // advice (review 6):
  //   - stamped in an OLD currency  -> stranded; stays in that currency's group,
  //     whose `assemble_draft` recovery is addressable;
  //   - stamped in the TARGET currency, or not stamped at all -> NOT stranded;
  //     a configuration warning, because "assemble a draft in <target>" is
  //     nonsense and "assemble a draft in UNKNOWN" is rejected outright by
  //     `assembleDraftFromOrg`'s currency validator.
  const rateLessRows = await dbc
    .select({ currencyCode: timeEntries.currencyCode, n: count() })
    .from(timeEntries)
    .where(and(
      eq(timeEntries.orgId, orgId),
      eq(timeEntries.billingStatus, 'not_billed'),
      isNull(timeEntries.hourlyRate)
    ))
    .groupBy(timeEntries.currencyCode);
  let rateLessTimeEntries = 0;
  for (const r of rateLessRows) {
    if (r.currencyCode === null || r.currencyCode === target) { rateLessTimeEntries += Number(r.n); continue; }
    group(r.currencyCode).billables.missingRateTimeEntries = Number(r.n);
  }

  // Parts: `unit_price` and `currency_code` are both NOT NULL, so every unbilled
  // part is monetary and stamped. Aggregated in SQL for the same reason as time.
  const partRows = await dbc
    .select({
      currencyCode: ticketParts.currencyCode,
      monetary: count(),
      ready: sql<string>`count(*) filter (where ${ticketParts.isBillable} = true)`,
      nonBillable: sql<string>`count(*) filter (where ${ticketParts.isBillable} = false)`,
      amount2: partSumSql(2),
      amount0: partSumSql(0)
    })
    .from(ticketParts)
    .where(and(
      eq(ticketParts.orgId, orgId),
      eq(ticketParts.billingStatus, 'not_billed'),
      ne(ticketParts.currencyCode, target)
    ))
    .groupBy(ticketParts.currencyCode);
  for (const r of partRows) {
    const key = r.currencyCode ?? UNKNOWN_CURRENCY_KEY;
    const b = group(r.currencyCode).billables;
    b.monetaryPartSnapshots = Number(r.monetary);
    b.readyParts = Number(r.ready);
    b.currentlyNonBillableParts = Number(r.nonBillable);
    b.partAmount = amountFor(r.amount2, r.amount0, key);
  }

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
    // Belt and braces (review 6): every group carries an `assemble_draft`
    // recovery, so a group the operator could not act on must never ship. The
    // target currency is not stranded, and UNKNOWN is not a currency an
    // assembly can be addressed to. No query above can produce either key any
    // more — this keeps it that way.
    impactsByCurrency: [...groups.values()]
      .filter((g) => g.currencyCode !== target && g.currencyCode !== UNKNOWN_CURRENCY_KEY)
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)),
    configurationWarnings: {
      orgDefaultRate: {
        configured: rateConfigured,
        rateCurrency: rateSettings?.rateCurrency ?? null,
        willStopApplying: rateConfigured && rateSettings!.rateCurrency !== target
      },
      categoryRatesSkipped: Number(categorySkipped?.n ?? 0),
      orgCatalogOverridesSkipped: Number(overridesSkipped?.n ?? 0),
      rateLessTimeEntries
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
 *   7. UPDATE, commit, and only THEN compute the advisory impact.
 *
 * Why the impact is computed AFTER the lock is released (review 4): every
 * default-derived writer in the org (invoice, quote, contract, time entry,
 * ticket part, rate and override upserts) takes `organizations FOR SHARE` as
 * its first statement, which conflicts with this FOR UPDATE. Anything this
 * transaction does while holding the lock therefore stalls ALL billing writes
 * for the org. The summary is explicitly ADVISORY — it is never a blocker and
 * never a promise — so it has no business inside the critical section.
 *
 * Exactness is not lost by moving it out. The summary reports rows stamped in a
 * currency OTHER than the target: a row that commits after the change reads the
 * NEW currency through the SHARE barrier, so it is stamped in the target and is
 * correctly absent; a row that committed before the change kept the old stamp
 * and is still counted. What the post-commit summary describes is the state
 * AFTER the change, so `currentCurrencyCode` is the new code and
 * `changeRequired` is false — the groups, which are what the operator acts on,
 * are unchanged.
 */
export async function changeOrgCurrency(
  orgId: string,
  input: ChangeOrgCurrencyInput,
  actor: InvoiceActor
): Promise<ChangeOrgCurrencyResult> {
  requireOrg(actor, orgId); // fast-fail only; re-checked under the lock below

  // The locked section: lock, check, write. No scan, no aggregate, no read of
  // any billable table.
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: organizations.id, currencyCode: organizations.currencyCode })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1).for('update');
    if (!locked) throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    requireOrg(actor, locked.id);

    if (locked.currencyCode !== input.expectedCurrentCurrencyCode) {
      return { kind: 'stale' as const, currentCurrencyCode: locked.currencyCode };
    }

    // Idempotent no-op: a same-currency PATCH writes nothing and needs no
    // confirmation (there is no snapshot to retain).
    if (locked.currencyCode === input.currencyCode) {
      return { kind: 'noop' as const, currentCurrencyCode: locked.currencyCode };
    }

    if (input.confirmSnapshotRetention !== true) {
      throw new InvoiceServiceError(
        'Changing the organization currency requires confirmSnapshotRetention', 400, 'CONFIRMATION_REQUIRED'
      );
    }

    await tx.update(organizations)
      .set({ currencyCode: input.currencyCode, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    return { kind: 'changed' as const, currentCurrencyCode: locked.currencyCode };
  });

  const impact = await getOrgCurrencyImpact(orgId, input.currencyCode, actor);

  if (outcome.kind === 'stale') {
    throw new InvoiceServiceError(
      'The organization currency changed since this summary was taken', 409, 'ORG_CURRENCY_CHANGED',
      {
        currentCurrencyCode: outcome.currentCurrencyCode,
        expectedCurrentCurrencyCode: input.expectedCurrentCurrencyCode,
        impact
      }
    );
  }

  return {
    orgId,
    previousCurrencyCode: outcome.currentCurrencyCode,
    currencyCode: outcome.kind === 'noop' ? outcome.currentCurrencyCode : input.currencyCode,
    impact
  };
}
