import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { contracts, organizations } from '../db/schema';
import { ContractServiceError, type ContractActor, type ContractStatus } from './contractTypes';
import { inspectContractCurrencyEligibility } from './contractService';

/**
 * Contract-vs-org currency mismatch report (multi-currency wave 6, #3778, Task 15).
 *
 * WHY IT EXISTS. Pre-wave-2 contracts stamped 'USD' under a non-USD org keep
 * billing USD forever: wave 2 removed issueInvoice's partner-currency
 * overwrite, and generateDueInvoice faithfully propagates whatever the contract
 * carries. This is the operator's inventory of those anomalies.
 *
 * READ-ONLY, deliberately. It exposes no bulk restamp and no bulk fix — the
 * owner-fixed decisions forbid bulk restamping history. Each row is acted on
 * one at a time through the Task 14 escape hatch, which re-checks eligibility
 * under the contract's own row lock.
 *
 * Lives in its own file (not contractService.ts) purely to keep that file
 * inside the size guidance; it owns no lock protocol of its own.
 */

export type ContractCurrencyIneligibleReason =
  | 'STATUS_NOT_ACTIVE'
  | 'ORPHANED_CONTRACT_SOURCE'
  | 'ORPHANED_BILLING_PERIOD'
  | 'BROKEN_CONTRACT_LINEAGE'
  | 'UNBILLED_MONETARY_ROWS';

export interface ContractCurrencyMismatchItem {
  contractId: string;
  contractName: string;
  orgId: string;
  orgName: string;
  status: ContractStatus;
  contractCurrencyCode: string;
  orgCurrencyCode: string;
  nextBillingAt: string | null;
  /** Draft invoices holding money billed under this contract (count + ids). */
  draftMonetaryInvoiceCount: number;
  blockingDraftInvoiceIds: string[];
  orphanedBillingPeriodCount: number;
  /** True only when the Task 14 mutation would accept this row right now. */
  activeChangeEligible: boolean;
  ineligibleReason: ContractCurrencyIneligibleReason | null;
}

export interface ContractCurrencyMismatchReport {
  items: ContractCurrencyMismatchItem[];
  nextCursor: string | null;
}

export interface ContractCurrencyMismatchQueryInput {
  orgId?: string;
  status?: ContractStatus;
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Local copy of contractService's private guard (CLAUDE.md permits duplicating
 *  a small helper rather than widening another module's surface). */
function requireOrgAccess(actor: ContractActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new ContractServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

/**
 * Maps an eligibility verdict onto the single reason to show, in EXACTLY the
 * precedence assertActiveContractEligible throws in — so the report always
 * names the blocker the operator will actually hit first.
 */
function reasonFor(
  status: ContractStatus,
  e: Awaited<ReturnType<typeof inspectContractCurrencyEligibility>>,
): ContractCurrencyIneligibleReason | null {
  if (status !== 'active') return 'STATUS_NOT_ACTIVE';
  if (e.orphanedContractSourceLineIds.length > 0) return 'ORPHANED_CONTRACT_SOURCE';
  if (e.orphanedBillingPeriodIds.length > 0) return 'ORPHANED_BILLING_PERIOD';
  if (e.brokenLineageInvoiceIds.length > 0) return 'BROKEN_CONTRACT_LINEAGE';
  if (e.draftInvoiceIds.length > 0) return 'UNBILLED_MONETARY_ROWS';
  return null;
}

/** Placeholder verdict for rows whose eligibility is never computed (non-active).
 *  Never reaches reasonFor's blocker branches — STATUS_NOT_ACTIVE wins first. */
const EMPTY_ELIGIBILITY: Awaited<ReturnType<typeof inspectContractCurrencyEligibility>> = {
  eligible: false,
  draftInvoiceIds: [],
  orphanedBillingPeriodIds: [],
  orphanedContractSourceLineIds: [],
  brokenLineageInvoiceIds: [],
};

export async function listContractCurrencyMismatches(
  query: ContractCurrencyMismatchQueryInput,
  actor: ContractActor,
): Promise<ContractCurrencyMismatchReport> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // The predicate: a contract whose stamped currency no longer matches its
  // organization's, in ANY status — an anomaly inventory, not an action queue.
  const conds = [sql`${contracts.currencyCode} <> ${organizations.currencyCode}`];
  if (query.orgId) { requireOrgAccess(actor, query.orgId); conds.push(eq(contracts.orgId, query.orgId)); }
  if (query.status) conds.push(eq(contracts.status, query.status as never));
  // Defense-in-depth, mirroring listContracts: with a restricted org list the
  // query filters explicitly instead of leaning on RLS alone.
  // null accessibleOrgIds = system/admin context — no extra filter needed.
  if (actor.accessibleOrgIds !== null) conds.push(inArray(contracts.orgId, actor.accessibleOrgIds));
  // Keyset pagination on the stable primary key: no row can be skipped or
  // repeated when a contract is restamped between pages.
  if (query.cursor) conds.push(gt(contracts.id, query.cursor));

  const rows = await db.select({
    contractId: contracts.id,
    contractName: contracts.name,
    orgId: contracts.orgId,
    orgName: organizations.name,
    status: contracts.status,
    contractCurrencyCode: contracts.currencyCode,
    orgCurrencyCode: organizations.currencyCode,
    nextBillingAt: contracts.nextBillingAt,
  })
    .from(contracts)
    .innerJoin(organizations, eq(organizations.id, contracts.orgId))
    .where(and(...conds))
    .orderBy(asc(contracts.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1]!.contractId) : null;

  // Blocker (4)'s scan is ORG-scoped, so it is identical for every contract of
  // the same org. Memoised across the page (see InspectContractCurrencyOptions):
  // a 100-row page of one org went from 100 org-wide invoice_lines scans to 1.
  // Report-only — the mutation re-reads it fresh under the contract's row lock.
  const orphanScanCache = new Map<string, string[]>();

  const items: ContractCurrencyMismatchItem[] = [];
  for (const r of page) {
    const status = r.status as ContractStatus;
    // A non-active contract can NEVER be accepted by the Task 14 hatch, and
    // reasonFor short-circuits to STATUS_NOT_ACTIVE for it — so computing
    // eligibility would issue four queries per row only to discard every one.
    // Skip it entirely. Consequence, deliberate: the informational counts read 0
    // for non-active rows because nothing was measured; ineligibleReason is the
    // authority on why the row cannot be acted on.
    const eligibility = status === 'active'
      // The SAME helper changeContractCurrency gates on, so the report can never
      // disagree with the mutation. Called WITHOUT the contract's FOR UPDATE —
      // a read-only report must never serialize against a billing run — so the
      // verdict is advisory-at-this-instant; the mutation re-checks under the
      // lock and is the authority. One transaction per row gives its queries a
      // consistent snapshot.
      ? await db.transaction((tx) => inspectContractCurrencyEligibility(tx, r.contractId, { orphanScanCache }))
      : EMPTY_ELIGIBILITY;
    const reason = reasonFor(status, eligibility);
    items.push({
      contractId: r.contractId,
      contractName: r.contractName,
      orgId: r.orgId,
      orgName: r.orgName,
      status,
      contractCurrencyCode: r.contractCurrencyCode,
      orgCurrencyCode: r.orgCurrencyCode,
      nextBillingAt: r.nextBillingAt === null || r.nextBillingAt === undefined
        ? null
        : new Date(r.nextBillingAt as unknown as string).toISOString(),
      draftMonetaryInvoiceCount: eligibility.draftInvoiceIds.length,
      blockingDraftInvoiceIds: eligibility.draftInvoiceIds,
      orphanedBillingPeriodCount: eligibility.orphanedBillingPeriodIds.length,
      activeChangeEligible: reason === null,
      ineligibleReason: reason,
    });
  }

  return { items, nextCursor };
}
