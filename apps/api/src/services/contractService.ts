import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, contractBillingPeriods, organizations } from '../db/schema';
import { ContractServiceError, type ContractActor } from './contractTypes';
import type { ContractLineInput, UpdateContractInput } from '@breeze/shared';
import { periodIndexFor, nextBillingDate, computePeriod, isExpired } from './contractMath';
import { emitContractEvent } from './contractEvents';
import { createManualInvoice, addContractLine, deleteDraftInvoice } from './invoiceService';
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

export async function createContract(input: {
  orgId: string; name: string; billingTiming: 'advance' | 'arrears'; intervalMonths: number;
  startDate: string; endDate?: string | null; autoIssue?: boolean; currencyCode?: string; notes?: string | null; terms?: string | null;
  autoRenew?: boolean; renewalTermMonths?: number | null; renewalNoticeDays?: number | null;
}, actor: ContractActor) {
  requireOrgAccess(actor, input.orgId);
  if (actor.partnerId === null) throw new ContractServiceError('Partner scope required', 403, 'ORG_DENIED');
  // Derive partnerId from the org row — never trust actor.partnerId for the contract's FK.
  const [org] = await db.select({ partnerId: organizations.partnerId })
    .from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) throw new ContractServiceError('Organization not found', 404, 'CONTRACT_NOT_FOUND');
  const [row] = await db.insert(contracts).values({
    partnerId: org.partnerId, orgId: input.orgId, name: input.name, status: 'draft',
    billingTiming: input.billingTiming, intervalMonths: input.intervalMonths,
    startDate: input.startDate, endDate: input.endDate ?? null,
    autoIssue: input.autoIssue ?? false, currencyCode: input.currencyCode ?? 'USD',
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

export async function addContractLineToContract(contractId: string, input: ContractLineInput, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  const [row] = await db.insert(contractLines).values({
    contractId, orgId: c.orgId, lineType: input.lineType, description: input.description,
    catalogItemId: input.catalogItemId ?? null, unitPrice: input.unitPrice,
    manualQuantity: input.lineType === 'manual' ? (input.manualQuantity ?? '0') : null,
    siteId: input.lineType === 'per_device' ? (input.siteId ?? null) : null,
    taxable: input.taxable, sortOrder: input.sortOrder ?? 0
  }).returning();
  return row!;
}

export async function removeContractLine(contractId: string, lineId: string, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  await db.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
}

function todayISO(asOf: Date = new Date()): string {
  return asOf.toISOString().slice(0, 10);
}

export async function activateContract(contractId: string, actor: ContractActor, asOf: Date = new Date()) {
  const c = await getOwnedContractOr404(contractId, actor);
  if (c.status !== 'draft' && c.status !== 'paused') {
    throw new ContractServiceError('Only draft/paused contracts can be activated', 409, 'INVALID_STATE');
  }
  // Count lines via a lightweight id-only select (simple + explicit).
  const lineRows = await db.select({ id: contractLines.id }).from(contractLines)
    .where(eq(contractLines.contractId, contractId));
  if (lineRows.length === 0) {
    throw new ContractServiceError('Contract needs at least one line', 409, 'NO_LINES');
  }
  const idx = periodIndexFor(c.startDate, c.intervalMonths, todayISO(asOf));
  const nextAt = nextBillingDate({ startDate: c.startDate, intervalMonths: c.intervalMonths, billingTiming: c.billingTiming as 'advance' | 'arrears', periodIndex: idx });
  const [row] = await db.update(contracts)
    .set({ status: 'active', nextBillingAt: nextAt, updatedAt: asOf })
    .where(eq(contracts.id, contractId)).returning();
  await emitContractEvent({ type: 'contract.activated', contractId, orgId: c.orgId, partnerId: c.partnerId, actorUserId: actor.userId });
  return row!;
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

interface GenerateResult {
  generated: boolean;
  invoiceId?: string;
  skipped?: 'already_billed' | 'expired' | 'not_due';
  /** True only when the contract opts into auto-issue AND an invoice was generated. */
  autoIssue: boolean;
  /** The InvoiceActor the caller needs to finish issue+send post-commit. Present only when generated. */
  actor?: InvoiceActor;
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
 * when a line carries a catalogItemId, addContractLine calls resolvePrice itself
 * and ignores the unitPrice/taxable we pass; on the non-catalog path it uses them.
 * So this function only computes the per-line QUANTITY.
 */
export async function generateDueInvoice(contractId: string, asOf: Date = new Date()): Promise<GenerateResult> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  // Cast the enum to a string for comparison — postgres.js returns the enum as a
  // plain string but drizzle types it as the narrow union; `as never` keeps tsc happy
  // while the runtime check stays a simple string compare (mirrors listContracts).
  if ((c.status as never) !== ('active' as never) || c.nextBillingAt === null) {
    return { generated: false, autoIssue: false, skipped: 'not_due' };
  }
  if (c.nextBillingAt > todayISO(asOf)) return { generated: false, autoIssue: false, skipped: 'not_due' };

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
    return { generated: false, autoIssue: false, skipped: 'expired' };
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
    return { generated: false, autoIssue: false, skipped: 'not_due' };
  }

  // 1. Draft invoice. Carry contract notes + terms onto the invoice notes
  //    (the engine has no terms param on create).
  const noteParts = [c.notes, c.terms].filter(Boolean) as string[];
  const inv = await createManualInvoice(
    { orgId: c.orgId, notes: noteParts.length ? noteParts.join('\n\n') : undefined },
    actor
  );

  // 2. Add each contract line. We compute ONLY the quantity. unitPrice/taxable are
  //    passed as-is — addContractLine ignores them and resolves the catalog price
  //    when catalogItemId is set, or uses them when it is null.
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
    await addContractLine(inv.id, {
      description: l.description, quantity, unitPrice: l.unitPrice, taxable: l.taxable,
      catalogItemId: l.catalogItemId, sourceId: l.id
    }, actor);
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
    return { generated: false, autoIssue: false, skipped: 'already_billed' };
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
  return { generated: true, invoiceId: inv.id, autoIssue: c.autoIssue, actor };
}
