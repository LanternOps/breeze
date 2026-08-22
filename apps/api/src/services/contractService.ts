import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, contractBillingPeriods, organizations } from '../db/schema';
import { ContractServiceError, type ContractActor } from './contractTypes';
import type { ContractLineInput, UpdateContractInput } from '@breeze/shared';
import type { NewContractSpec } from './quoteToContract';
import { periodIndexFor, nextBillingDate, computePeriod, isExpired } from './contractMath';
import { emitContractEvent } from './contractEvents';
import { createManualInvoice, addContractLine, deleteDraftInvoice } from './invoiceService';
import { resolvePrice, CatalogServiceError } from './catalogService';
import { countContractDevices, countContractSeats } from './contractQuantities';
import type { InvoiceActor } from './invoiceTypes';

export type ContractActorT = ContractActor;

function requireOrgAccess(actor: ContractActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new ContractServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

async function getOwnedContractOr404(contractId: string, actor: ContractActor) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  requireOrgAccess(actor, c.orgId);
  return c;
}

function assertDraft(c: { status: string }): void {
  if (c.status !== 'draft') throw new ContractServiceError('Contract is not a draft', 409, 'NOT_A_DRAFT');
}

function assertEditable(c: { status: string }): void {
  if (c.status !== 'draft' && c.status !== 'active') {
    throw new ContractServiceError('Lines editable only on draft/active contracts', 409, 'INVALID_STATE');
  }
}

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock-order anchor (#3774, mirrors invoiceService.lockDraftInvoice): SELECT
 * the CONTRACT row FOR UPDATE as the FIRST statement of the enclosing
 * transaction, 404 + org-access check, and return the locked row. Every line
 * writer takes this lock before touching contract_lines (asserting the
 * status itself — draft/active for line edits, draft-only for the currency
 * restamp), so a concurrent changeContractCurrency can never restamp between
 * a writer's read of the contract and its line write — no JPY-stamped
 * contract silently keeping a line priced under the old currency, and no
 * line phantom-inserting past the restamp's "no lines" check.
 */
async function lockContract(tx: DbExecutor, contractId: string, actor: ContractActor) {
  const [c] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).limit(1).for('update');
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  requireOrgAccess(actor, c.orgId);
  return c;
}

export async function createContract(input: {
  orgId: string; name: string; billingTiming: 'advance' | 'arrears'; intervalMonths: number;
  startDate: string; endDate?: string | null; autoIssue?: boolean; currencyCode?: string; notes?: string | null; terms?: string | null;
  autoRenew?: boolean; renewalTermMonths?: number | null; renewalNoticeDays?: number | null;
}, actor: ContractActor) {
  requireOrgAccess(actor, input.orgId);
  if (actor.partnerId === null) throw new ContractServiceError('Partner scope required', 403, 'ORG_DENIED');
  // Derive partnerId from the org row — never trust actor.partnerId for the contract's FK.
  const [org] = await db.select({ partnerId: organizations.partnerId, currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) throw new ContractServiceError('Organization not found', 404, 'CONTRACT_NOT_FOUND');
  const [row] = await db.insert(contracts).values({
    partnerId: org.partnerId, orgId: input.orgId, name: input.name, status: 'draft',
    billingTiming: input.billingTiming, intervalMonths: input.intervalMonths,
    startDate: input.startDate, endDate: input.endDate ?? null,
    autoIssue: input.autoIssue ?? false, currencyCode: input.currencyCode ?? org.currencyCode,
    notes: input.notes ?? null, terms: input.terms ?? null, createdBy: actor.userId,
    autoRenew: input.autoRenew ?? false, renewalTermMonths: input.renewalTermMonths ?? null,
    renewalNoticeDays: input.renewalNoticeDays ?? null,
  }).returning();
  return row!;
}

export async function getContract(contractId: string, actor: ContractActor) {
  const contract = await getOwnedContractOr404(contractId, actor);
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  const periods = await db.select().from(contractBillingPeriods)
    .where(eq(contractBillingPeriods.contractId, contractId)).orderBy(desc(contractBillingPeriods.periodStart));
  return { contract, lines, periods };
}

export async function listContracts(query: {
  orgId?: string; status?: string; limit?: number;
}, actor: ContractActor) {
  const conds = [];
  if (query.orgId) { requireOrgAccess(actor, query.orgId); conds.push(eq(contracts.orgId, query.orgId)); }
  if (query.status) conds.push(eq(contracts.status, query.status as never));
  // Defense-in-depth: when the actor has a restricted org list, add an explicit app-level filter
  // so the query never depends solely on RLS (consistent with other billing list endpoints).
  // null accessibleOrgIds = system/admin context — no extra filter needed.
  if (actor.accessibleOrgIds !== null) {
    conds.push(inArray(contracts.orgId, actor.accessibleOrgIds));
  }
  const rows = await db.select().from(contracts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(contracts.createdAt))
    .limit(Math.min(query.limit ?? 50, 100));
  if (rows.length === 0) return rows;

  // Enrich each row with estimatedPeriodValue (live counts for per_device/per_seat
  // lines). All lines for the page load in one query; device/seat counts are
  // memoized per (org, site) / org so distinct counts run once, not per contract.
  const ids = rows.map((r) => r.id);
  const allLines = await db.select().from(contractLines).where(inArray(contractLines.contractId, ids));
  const byContract = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = byContract.get(l.contractId);
    if (list) list.push(l); else byContract.set(l.contractId, [l]);
  }
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  const out = [];
  for (const c of rows) {
    let total = 0;
    for (const l of byContract.get(c.id) ?? []) {
      const { quantity } = await resolveLineQty(c.orgId, l, dc, sc);
      total += Number(l.unitPrice) * quantity;
    }
    out.push({ ...c, estimatedPeriodValue: total.toFixed(2) });
  }
  return out;
}

// ---- recurring-value estimate (live per_device/per_seat resolution) --------
type DeviceCache = Map<string, number>; // key `${orgId}|${siteId ?? 'all'}`
type SeatCache = Map<string, number>;   // key orgId
type ContractLineRow = typeof contractLines.$inferSelect;

async function resolveLineQty(
  orgId: string, line: ContractLineRow, dc: DeviceCache, sc: SeatCache,
): Promise<{ quantity: number; live: boolean }> {
  switch (line.lineType) {
    case 'flat': return { quantity: 1, live: false };
    case 'manual': return { quantity: Number(line.manualQuantity ?? '0'), live: false };
    case 'per_device': {
      const key = `${orgId}|${line.siteId ?? 'all'}`;
      if (!dc.has(key)) dc.set(key, await countContractDevices(orgId, line.siteId));
      return { quantity: dc.get(key)!, live: true };
    }
    case 'per_seat': {
      if (!sc.has(orgId)) sc.set(orgId, await countContractSeats(orgId));
      return { quantity: sc.get(orgId)!, live: true };
    }
    default: return { quantity: 0, live: false };
  }
}

/** Per-line resolved quantities + values + period total for one contract, using
 *  live device/seat counts as of now. Powers the editor sidebar and detail. */
export async function computeContractEstimate(contractId: string, actor: ContractActor) {
  const contract = await getOwnedContractOr404(contractId, actor);
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  let total = 0;
  const out = [];
  for (const l of lines) {
    const { quantity, live } = await resolveLineQty(contract.orgId, l, dc, sc);
    const value = Number(l.unitPrice) * quantity;
    total += value;
    out.push({ lineId: l.id, lineType: l.lineType, quantity, value: value.toFixed(2), live });
  }
  return { currencyCode: contract.currencyCode, periodTotal: total.toFixed(2), lines: out };
}

export async function updateContract(contractId: string, patch: UpdateContractInput, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  // Schedule fields (billingTiming, intervalMonths, startDate) drive next_billing_at.
  // Editing them on a non-draft contract would leave next_billing_at stale → mis-bills.
  // Reject the request outright so the caller learns rather than silently dropping them.
  if (c.status !== 'draft') {
    if (patch.billingTiming !== undefined || patch.intervalMonths !== undefined || patch.startDate !== undefined) {
      throw new ContractServiceError('Cannot change schedule fields on a non-draft contract', 409, 'INVALID_STATE');
    }
  }
  // Explicit whitelist — never write status, orgId, partnerId, createdBy, id,
  // nextBillingAt, or currencyCode from caller input. Status transitions belong
  // to dedicated lifecycle functions.
  const safeSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined)           safeSet.name           = patch.name;
  // Schedule fields are draft-only (guarded above).
  if (c.status === 'draft' && patch.billingTiming !== undefined)  safeSet.billingTiming  = patch.billingTiming;
  if (c.status === 'draft' && patch.intervalMonths !== undefined) safeSet.intervalMonths = patch.intervalMonths;
  if (c.status === 'draft' && patch.startDate !== undefined)      safeSet.startDate      = patch.startDate;
  if ('endDate' in patch)                 safeSet.endDate        = patch.endDate ?? null;
  if (patch.autoIssue !== undefined)      safeSet.autoIssue      = patch.autoIssue;
  if ('notes' in patch)                   safeSet.notes          = patch.notes ?? null;
  if ('terms' in patch)                   safeSet.terms          = patch.terms ?? null;
  if (patch.autoRenew !== undefined)      safeSet.autoRenew      = patch.autoRenew;
  if ('renewalTermMonths' in patch)       safeSet.renewalTermMonths = patch.renewalTermMonths ?? null;
  if ('renewalNoticeDays' in patch)       safeSet.renewalNoticeDays = patch.renewalNoticeDays ?? null;
  // Post-merge invariant: auto-renew requires both an end date and a renewal term.
  // updateContractSchema is a bare object that cannot cross-validate against the persisted
  // row (the patch may only send autoRenew:true without re-sending endDate). We compute
  // the effective values by merging the patch over the persisted row and check here.
  const effectiveAutoRenew   = safeSet.autoRenew   !== undefined ? safeSet.autoRenew   : c.autoRenew;
  const effectiveEndDate     = safeSet.endDate      !== undefined ? safeSet.endDate     : c.endDate;
  const effectiveTerm        = safeSet.renewalTermMonths !== undefined ? safeSet.renewalTermMonths : c.renewalTermMonths;
  if (effectiveAutoRenew && (effectiveEndDate == null || effectiveTerm == null)) {
    throw new ContractServiceError('auto-renew requires an end date and renewal term', 400);
  }
  await db.update(contracts).set(safeSet).where(eq(contracts.id, contractId));
  return getOwnedContractOr404(contractId, actor);
}

export async function deleteDraftContract(contractId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertDraft(c);
  await db.delete(contracts).where(eq(contracts.id, contractId)); // lines cascade
}

/**
 * Draft-only atomic change-currency operation (multi-currency wave 2, #3774).
 * A draft's stamped currency is immutable through every other mutation path —
 * updateContract explicitly whitelists away currencyCode — so this is the
 * ONLY way the stamp moves, and only while the contract is a draft. With
 * lines present the change is refused (CURRENCY_LOCKED 409) unless the caller
 * opts into `clearLines`, which deletes the contract's lines and restamps in
 * ONE transaction, or into `reprice` (wave 3, #3775), which re-resolves
 * catalog-linked lines from the price book in the new currency. Unit prices
 * are never converted or reinterpreted. Contracts store no header totals, so
 * there is nothing further to recompute.
 */
export async function changeContractCurrency(
  contractId: string,
  input: { currencyCode: string; clearLines?: boolean; reprice?: boolean },
  actor: ContractActor
) {
  return db.transaction(async (tx) => {
    // Contract row lock FIRST (document → lines). The line writers and
    // activateContract take the same lock via lockContract, so a concurrent
    // activate or line write serializes against the restamp.
    const c = await lockContract(tx, contractId, actor);
    assertDraft(c);
    if (c.currencyCode === input.currencyCode) return c; // no-op restamp

    const lineRows = await tx.select({ id: contractLines.id, catalogItemId: contractLines.catalogItemId })
      .from(contractLines).where(eq(contractLines.contractId, contractId)).orderBy(contractLines.id);
    if (lineRows.length > 0) {
      if (input.reprice) {
        // Multi-currency wave 3 (#3775): re-resolve every catalog-linked line's
        // unit_price from the price book in the NEW currency on the locked tx
        // (contract → lines → catalog plain SELECTs). Lines without a catalog
        // item carry a hand-entered price the book cannot re-derive, so their
        // presence refuses the whole operation. One gap aborts the transaction.
        const repriceable = lineRows.filter((l) => l.catalogItemId !== null);
        const rest = lineRows.length - repriceable.length;
        if (rest > 0) {
          throw new ContractServiceError(`${rest} non-catalog line(s) cannot be repriced — pass clearLines instead`, 409, 'CURRENCY_LOCKED');
        }
        const catalogActor = { userId: actor.userId, partnerId: c.partnerId, accessibleOrgIds: actor.accessibleOrgIds };
        for (const line of repriceable) {
          let resolved: Awaited<ReturnType<typeof resolvePrice>>;
          try {
            resolved = await resolvePrice(line.catalogItemId!, input.currencyCode, c.orgId, catalogActor, tx);
          } catch (err) {
            if (err instanceof CatalogServiceError && err.code === 'NO_PRICE_FOR_CURRENCY') {
              throw new ContractServiceError(err.message, 409, 'NO_PRICE_FOR_CURRENCY');
            }
            throw err;
          }
          await tx.update(contractLines).set({ unitPrice: resolved.unitPrice }).where(eq(contractLines.id, line.id));
        }
      } else if (!input.clearLines) {
        throw new ContractServiceError(
          `Contract has ${lineRows.length} line(s) priced in ${c.currencyCode} — pass clearLines to remove them, or delete the draft`,
          409, 'CURRENCY_LOCKED'
        );
      } else {
        await tx.delete(contractLines).where(eq(contractLines.contractId, contractId));
      }
    }

    const [updated] = await tx.update(contracts)
      .set({ currencyCode: input.currencyCode, updatedAt: new Date() })
      .where(eq(contracts.id, contractId)).returning();
    return updated!;
  });
}

/**
 * Multi-currency wave 3 (#3775, spec §6): a catalog-sourced contract line is
 * priced by the resolver in the CONTRACT's currency (org override → price book,
 * never the deprecated unit_price mirror, never converted) and any client-
 * supplied unitPrice/taxable is IGNORED — the resolver is authoritative, exactly
 * as generateDueInvoice's catalog path already is. A tech who wants a different
 * price adds a non-catalog line, which still requires and stamps the client
 * unitPrice/taxable verbatim. A price-book gap is a typed 409.
 */
export async function addContractLineToContract(contractId: string, input: ContractLineInput, actor: ContractActor) {
  return db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    assertEditable(c);
    let unitPrice: string;
    let taxable: boolean;
    if (input.catalogItemId) {
      // Resolved on the locked tx: contract row → catalog plain SELECTs (no new lock edge).
      let resolved: Awaited<ReturnType<typeof resolvePrice>>;
      try {
        resolved = await resolvePrice(
          input.catalogItemId, c.currencyCode, c.orgId,
          { userId: actor.userId, partnerId: c.partnerId, accessibleOrgIds: actor.accessibleOrgIds },
          tx
        );
      } catch (err) {
        if (err instanceof CatalogServiceError && err.code === 'NO_PRICE_FOR_CURRENCY') {
          throw new ContractServiceError(err.message, 409, 'NO_PRICE_FOR_CURRENCY');
        }
        throw err;
      }
      unitPrice = resolved.unitPrice;
      taxable = resolved.taxable;
    } else {
      // The shared validator already requires unitPrice here; this is the
      // service-level backstop for internal callers.
      if (input.unitPrice === undefined) {
        throw new ContractServiceError('unitPrice is required unless catalogItemId is set', 400, 'INVALID_STATE');
      }
      unitPrice = input.unitPrice;
      taxable = input.taxable;
    }
    const [row] = await tx.insert(contractLines).values({
      contractId, orgId: c.orgId, lineType: input.lineType, description: input.description,
      catalogItemId: input.catalogItemId ?? null, unitPrice,
      manualQuantity: input.lineType === 'manual' ? (input.manualQuantity ?? '0') : null,
      siteId: input.lineType === 'per_device' ? (input.siteId ?? null) : null,
      taxable, sortOrder: input.sortOrder ?? 0
    }).returning();
    return row!;
  });
}

export async function removeContractLine(contractId: string, lineId: string, actor: ContractActor) {
  await db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    assertEditable(c);
    await tx.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
  });
}

function todayISO(asOf: Date = new Date()): string {
  return asOf.toISOString().slice(0, 10);
}

export async function activateContract(contractId: string, actor: ContractActor, asOf: Date = new Date()) {
  // Contract row lock FIRST (document → lines) so the line-count check and the
  // status flip can't interleave with changeContractCurrency's clear-and-restamp
  // or a concurrent line write (same lock order as every other contract writer).
  const { row, c } = await db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    if (c.status !== 'draft' && c.status !== 'paused') {
      throw new ContractServiceError('Only draft/paused contracts can be activated', 409, 'INVALID_STATE');
    }
    // Count lines via a lightweight id-only select (simple + explicit).
    const lineRows = await tx.select({ id: contractLines.id }).from(contractLines)
      .where(eq(contractLines.contractId, contractId));
    if (lineRows.length === 0) {
      throw new ContractServiceError('Contract needs at least one line', 409, 'NO_LINES');
    }
    const idx = periodIndexFor(c.startDate, c.intervalMonths, todayISO(asOf));
    const nextAt = nextBillingDate({ startDate: c.startDate, intervalMonths: c.intervalMonths, billingTiming: c.billingTiming as 'advance' | 'arrears', periodIndex: idx });
    const [row] = await tx.update(contracts)
      .set({ status: 'active', nextBillingAt: nextAt, updatedAt: asOf })
      .where(eq(contracts.id, contractId)).returning();
    return { row: row!, c };
  });
  await emitContractEvent({ type: 'contract.activated', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row;
}

export async function pauseContract(contractId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status !== 'active') {
    throw new ContractServiceError('Only active contracts can be paused', 409, 'INVALID_STATE');
  }
  const [row] = await db.update(contracts)
    .set({ status: 'paused', nextBillingAt: null, updatedAt: new Date() })
    .where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.paused', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}

export async function resumeContract(contractId: string, actor: ContractActor, asOfISO: string = todayISO()) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status !== 'paused') {
    throw new ContractServiceError('Only paused contracts can be resumed', 409, 'INVALID_STATE');
  }
  const idx = periodIndexFor(c.startDate, c.intervalMonths, asOfISO);
  const nextAt = nextBillingDate({ startDate: c.startDate, intervalMonths: c.intervalMonths, billingTiming: c.billingTiming as 'advance' | 'arrears', periodIndex: idx });
  const [row] = await db.update(contracts)
    .set({ status: 'active', nextBillingAt: nextAt, updatedAt: new Date() })
    .where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.activated', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}

export async function cancelContract(contractId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status === 'cancelled') return c;
  const [row] = await db.update(contracts)
    .set({ status: 'cancelled', nextBillingAt: null, updatedAt: new Date() })
    .where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.cancelled', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
}

/**
 * A catalog-sourced contract line whose item had NO price in the contract's
 * currency at billing time (wave 3, #3775). The line was still billed — at the
 * contract line's stamped snapshot — but the caller MUST surface this (the
 * worker logs one warning per gap; the manual generate route returns it).
 */
export interface PriceBookGap {
  contractLineId: string;
  catalogItemId: string;
  itemName: string;
  currencyCode: string;
}

export interface GenerateResult {
  generated: boolean;
  invoiceId?: string;
  skipped?: 'already_billed' | 'expired' | 'not_due';
  /** True only when the contract opts into auto-issue AND an invoice was generated. */
  autoIssue: boolean;
  /** The InvoiceActor the caller needs to finish issue+send post-commit. Present only when generated. */
  actor?: InvoiceActor;
  /** Always present (`[]` when none / nothing generated) — never a silent fallback. */
  priceBookGaps: PriceBookGap[];
}

/**
 * Generate the invoice for whatever period is currently due on this contract.
 *
 * Idempotency is the whole point: the (contract_id, period_start) UNIQUE
 * constraint on contract_billing_periods makes double-billing physically
 * impossible. The order is deliberate — create draft → add lines → CLAIM the
 * ledger row (ON CONFLICT DO NOTHING). A run that loses the claim race deletes
 * its own still-draft invoice and skips; the winner advances the pointer.
 *
 * Transaction boundary: this function does ONLY fast DB writes and is meant to
 * run as a single all-or-nothing transaction supplied by the caller. It does
 * NOT self-wrap — callers MUST supply the system db access context (the daily
 * contract worker and the manual /generate route both wrap each call in
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`). Because the whole
 * body is one transaction, a mid-generation crash rolls the draft + claim back
 * together — there is no stray draft to clean up. It is NOT directly HTTP-wired.
 *
 * Auto-issue + email are deliberately NOT done here: they involve PDF render and
 * SMTP network I/O and must not run inside the billing transaction (a transient
 * SMTP failure must never roll back the bill / re-bill loop). This function
 * instead returns `{ autoIssue, actor }` so the caller can run
 * issueInvoice + sendInvoiceEmail AFTER the transaction commits, best-effort.
 *
 * Catalog pricing is resolved INSIDE addContractLine (tenant-scoped), not here:
 * when a line carries a catalogItemId, addContractLine calls resolvePrice in the
 * invoice's (= contract's) currency and ignores the unitPrice/taxable we pass;
 * on the non-catalog path it uses them. So this function only computes the
 * per-line QUANTITY.
 *
 * Price-book gap rule (wave 3, #3775): when the catalog has no price in the
 * contract's currency, addContractLine bills the contract line's stamped
 * snapshot (unitPrice/taxable we pass) — the run is neither failed nor skipped,
 * and nothing is converted (the B2 guard proves the snapshot is in the
 * invoice currency). The gap is reported in `priceBookGaps`; callers surface
 * it. Owner sign-off on "bill the snapshot" vs "skip the period" is recorded
 * in the wave-3 plan's Self-Review (a).
 */
export async function generateDueInvoice(contractId: string, asOf: Date = new Date()): Promise<GenerateResult> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  // Cast the enum to a string for comparison — postgres.js returns the enum as a
  // plain string but drizzle types it as the narrow union; `as never` keeps tsc happy
  // while the runtime check stays a simple string compare (mirrors listContracts).
  if ((c.status as never) !== ('active' as never) || c.nextBillingAt === null) {
    return { generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [] };
  }
  if (c.nextBillingAt > todayISO(asOf)) return { generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [] };

  // Which period does this billing run cover?
  // advance: the period whose START == nextBillingAt.
  // arrears: the just-completed period (whose END == nextBillingAt) → one index back.
  const idxAt = periodIndexFor(c.startDate, c.intervalMonths, c.nextBillingAt);
  const idx = Math.max(0, c.billingTiming === 'advance' ? idxAt : idxAt - 1);
  const period = computePeriod(c.startDate, c.intervalMonths, idx);

  // Expiry at due-check: if this period starts on/after the end date, expire (do not bill).
  if (isExpired({ endDate: c.endDate, periodStart: period.periodStart })) {
    await db.update(contracts).set({ status: 'expired', nextBillingAt: null, updatedAt: asOf }).where(eq(contracts.id, contractId));
    await emitContractEvent({ type: 'contract.expired', contractId, orgId: c.orgId, partnerId: c.partnerId });
    return { generated: false, autoIssue: false, skipped: 'expired', priceBookGaps: [] };
  }

  // Build an InvoiceActor for the contract. createdBy is nullable on system-seeded /
  // imported contracts; pass it through as-is — invoices.created_by is also nullable.
  const actor: InvoiceActor = {
    userId: c.createdBy,
    partnerId: c.partnerId,
    accessibleOrgIds: [c.orgId]
  };
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);

  // Never bill an empty (zero-line) contract: don't create/claim/issue a $0 invoice.
  // (removeContractLine stays permissive; this generation-side guard is the backstop.)
  if (lines.length === 0) {
    return { generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [] };
  }

  // 1. Draft invoice. Carry contract notes + terms onto the invoice notes
  //    (the engine has no terms param on create).
  const noteParts = [c.notes, c.terms].filter(Boolean) as string[];
  // B2: the invoice copies the CONTRACT's stamped currency (spec §5 snapshots
  // rule) — never the org's current setting, which may have changed since the
  // contract was created.
  const inv = await createManualInvoice(
    { orgId: c.orgId, notes: noteParts.length ? noteParts.join('\n\n') : undefined, currencyCode: c.currencyCode },
    actor
  );

  // 2. Add each contract line. We compute ONLY the quantity. unitPrice/taxable are
  //    passed as-is — addContractLine resolves the catalog price in the contract's
  //    currency when catalogItemId is set (falling back to this stamped snapshot
  //    on a price-book gap, reported below), or uses them when it is null.
  const priceBookGaps: PriceBookGap[] = [];
  for (const l of lines) {
    let quantity: string;
    switch (l.lineType) {
      case 'flat':
        quantity = '1';
        break;
      case 'manual':
        quantity = l.manualQuantity ?? '0';
        break;
      case 'per_device':
        quantity = String(await countContractDevices(c.orgId, l.siteId));
        break;
      case 'per_seat':
        quantity = String(await countContractSeats(c.orgId));
        break;
      default: {
        // Exhaustiveness: adding a 5th line type becomes a compile error here
        // (instead of silently billing qty 1).
        const _exhaustive: never = l.lineType;
        throw new ContractServiceError(`Unknown contract line type: ${String(l.lineType)}`, 500, 'INVALID_STATE');
      }
    }
    const { pricedFrom } = await addContractLine(inv.id, {
      description: l.description, quantity, unitPrice: l.unitPrice, taxable: l.taxable,
      catalogItemId: l.catalogItemId, sourceId: l.id
    }, actor);
    // A non-catalog line is always its own snapshot — only a CATALOG line billed
    // at the snapshot is a price-book gap.
    if (l.catalogItemId && pricedFrom === 'contract_snapshot') {
      priceBookGaps.push({ contractLineId: l.id, catalogItemId: l.catalogItemId, itemName: l.description, currencyCode: c.currencyCode });
    }
  }

  // 3. Claim the period (idempotency guard). On conflict this run lost a race →
  //    bin the still-draft invoice and skip.
  const claimed = await db.insert(contractBillingPeriods).values({
    contractId, orgId: c.orgId, periodStart: period.periodStart, periodEnd: period.periodEnd, invoiceId: inv.id
  }).onConflictDoNothing({
    target: [contractBillingPeriods.contractId, contractBillingPeriods.periodStart]
  }).returning({ id: contractBillingPeriods.id });

  if (claimed.length === 0) {
    await deleteDraftInvoice(inv.id, actor); // still a draft here — safe to remove
    return { generated: false, autoIssue: false, skipped: 'already_billed', priceBookGaps: [] };
  }

  // 4. Advance the pointer to the next period (or expire if the next period is past end_date).
  const nextIdx = idx + 1;
  const nextPeriod = computePeriod(c.startDate, c.intervalMonths, nextIdx);
  if (isExpired({ endDate: c.endDate, periodStart: nextPeriod.periodStart })) {
    await db.update(contracts).set({ status: 'expired', nextBillingAt: null, updatedAt: asOf }).where(eq(contracts.id, contractId));
    await emitContractEvent({ type: 'contract.expired', contractId, orgId: c.orgId, partnerId: c.partnerId });
  } else {
    const nextAt = c.billingTiming === 'advance' ? nextPeriod.periodStart : nextPeriod.periodEnd;
    await db.update(contracts).set({ nextBillingAt: nextAt, updatedAt: asOf }).where(eq(contracts.id, contractId));
  }

  await emitContractEvent({ type: 'contract.invoiced', contractId, orgId: c.orgId, partnerId: c.partnerId, invoiceId: inv.id });
  // Auto-issue + email are intentionally returned to the caller (NOT done here) so they
  // run post-commit, outside the billing transaction. See the doc-comment above.
  return { generated: true, invoiceId: inv.id, autoIssue: c.autoIssue, actor, priceBookGaps };
}

// INTERNAL (Phase 4): persist a contract + lines built by buildContractSpecsFromQuote.
// Tenancy (orgId/partnerId) is already validated by the caller, so there is NO
// actor guard here. MUST run inside an established system-scope DB context
// (e.g. acceptQuote's withSystemDbAccessContext transaction) — do not call from
// a bare request handler — a contextless/org-only call hits the partner-axis writes'
// RLS WITH CHECK and fails (now a typed CONTRACT_CREATE_FAILED, previously a 0-row
// silent write). Always lands status='draft'; the MSP activates later.
export interface CreatedContractWithLines {
  contract: typeof contracts.$inferSelect;
  lines: Array<{ id: string; sourceQuoteLineId: string | null; sortOrder: number }>;
}

/** Detailed Phase-4 variant that returns an in-memory quote-line correlation.
 * `sourceQuoteLineId` is intentionally never persisted on contract_lines. */
export async function createContractWithLinesDetailed(
  spec: NewContractSpec,
): Promise<CreatedContractWithLines> {
  const [contract] = await db
    .insert(contracts)
    .values({
      partnerId: spec.partnerId,
      orgId: spec.orgId,
      name: spec.name,
      status: 'draft',
      billingTiming: spec.billingTiming,
      intervalMonths: spec.intervalMonths,
      startDate: spec.startDate,
      endDate: spec.endDate ?? null,
      autoIssue: false,
      currencyCode: spec.currencyCode,
      notes: spec.notes ?? null,
      terms: spec.terms ?? null,
      createdBy: spec.createdBy ?? null,
    })
    .returning();

  if (!contract) {
    throw new ContractServiceError(
      `contract insert returned 0 rows (org=${spec.orgId} partner=${spec.partnerId}) — likely an RLS WITH CHECK rejection from a non-system DB context`,
      500, 'CONTRACT_CREATE_FAILED',
    );
  }

  const createdLines: CreatedContractWithLines['lines'] = [];
  for (let i = 0; i < spec.lines.length; i++) {
    const l = spec.lines[i]!;
    const [insertedLine] = await db.insert(contractLines).values({
      contractId: contract.id,
      orgId: spec.orgId,
      lineType: l.lineType,
      description: l.description,
      catalogItemId: l.catalogItemId ?? null,
      unitPrice: l.unitPrice,
      manualQuantity: l.lineType === 'manual' ? (l.manualQuantity ?? '0') : null,
      siteId: l.lineType === 'per_device' ? (l.siteId ?? null) : null,
      taxable: l.taxable,
      sortOrder: l.sortOrder ?? i,
    }).returning({ id: contractLines.id });

    if (!insertedLine) {
      throw new ContractServiceError(
        `contract line insert returned 0 rows (contractId=${contract.id} org=${spec.orgId} line[${i}]) — likely an RLS WITH CHECK rejection`,
        500, 'CONTRACT_LINE_CREATE_FAILED',
      );
    }
    createdLines.push({
      id: insertedLine.id,
      sourceQuoteLineId: l.sourceQuoteLineId ?? null,
      sortOrder: l.sortOrder ?? i,
    });
  }

  return { contract, lines: createdLines };
}

export async function createContractWithLines(
  spec: NewContractSpec,
): Promise<typeof contracts.$inferSelect> {
  return (await createContractWithLinesDetailed(spec)).contract;
}
