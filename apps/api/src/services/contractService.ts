import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, contractBillingPeriods, organizations, sites, deviceGroups, catalogItemPrices, catalogItemOrgPricing } from '../db/schema';
import { ContractServiceError, actorCan, type ContractActor } from './contractTypes';
import type { ContractLineInput, UpdateContractInput } from '@breeze/shared';
import { BILLABLE_DEVICE_ROLES, isRepresentableInCurrency, minorUnitExponent, roundToCurrency, PERMISSION_GRANTS } from '@breeze/shared';
import type { NewContractSpec } from './quoteToContract';
import { periodIndexFor, nextBillingDate, computePeriod, isExpired, duePeriodStartFor } from './contractMath';
import { emitContractEvent } from './contractEvents';
import { readOrgStampingDefaults, OrgCurrencyServiceError, type DbExecutor as OrgLockExecutor } from './orgCurrencyCore';
import { pgErrorNode } from '../utils/pgErrors';

/**
 * Boundary mapping for the org SHARE barrier (#3778, review finding 1).
 * `orgCurrencyCore` is domain-neutral by design and throws its own
 * `OrgCurrencyServiceError`; this service's route boundary rethrows anything it
 * does not recognise, so an unmapped ORG_NOT_FOUND would surface as a 500
 * instead of the 404 this path returned before the barrier existed. Only
 * ORG_NOT_FOUND is translated — a serialization failure, a deadlock or a
 * genuine helper bug must keep its own identity.
 */
async function lockOrgStampingDefaults(tx: OrgLockExecutor, orgId: string): Promise<{ currencyCode: string }> {
  try {
    return await readOrgStampingDefaults(tx, orgId);
  } catch (err) {
    if (err instanceof OrgCurrencyServiceError && err.code === 'ORG_NOT_FOUND') {
      throw new ContractServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    throw err;
  }
}

import { createManualInvoice, addContractLine, deleteDraftInvoice } from './invoiceService';
import { resolvePrice, CatalogServiceError } from './catalogService';
import { resolvePriceFrom, isPriceGap } from './catalogPricing';
import { countContractSeats, snapshotContractDevices, groupMembersForBilling, type DeviceSnapshotRow } from './contractQuantities';
import { isDeviceLine, quantityFor, uncoveredByRole, type UncoveredDevices, type OrgDeviceSnapshot, type GroupMembers } from './contractCoverage';
import { GroupEvaluationError } from './groupMembership';
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

/** #3205 W02: label group lines without a second fetch. Matched on (id, org_id)
 *  as defence in depth beside the composite FK; null when the group is gone
 *  (the stamped deviceGroupName still says what it was). */
async function withDeviceGroup<T extends { deviceGroupId: string | null; orgId: string }>(lines: T[]) {
  const ids = [...new Set(lines.map((l) => l.deviceGroupId).filter((x): x is string => x !== null))];
  const groups = ids.length === 0 ? [] : await db
    .select({ id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type })
    .from(deviceGroups).where(inArray(deviceGroups.id, ids));
  const byKey = new Map(groups.map((g) => [`${g.id}|${g.orgId}`, { id: g.id, name: g.name, type: g.type }]));
  return lines.map((l) => ({ ...l, deviceGroup: l.deviceGroupId ? (byKey.get(`${l.deviceGroupId}|${l.orgId}`) ?? null) : null }));
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

/** A line may only be scoped to a site of ITS OWN org. The composite FK
 *  contract_lines_site_org_fk is the backstop; this is the 400 the operator sees. */
async function assertSiteInOrg(tx: DbExecutor, siteId: string, orgId: string): Promise<void> {
  const [row] = await tx.select({ id: sites.id }).from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!row) throw new ContractServiceError('Site does not belong to this organization', 400, 'SITE_NOT_IN_ORG');
}

async function assertGroupInOrg(tx: DbExecutor, groupId: string, orgId: string) {
  const [row] = await tx.select({ id: deviceGroups.id, name: deviceGroups.name, type: deviceGroups.type, siteId: deviceGroups.siteId })
    .from(deviceGroups).where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, orgId))).limit(1);
  if (!row) throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
  return row;
}

/** Postgres 23503 on contract_lines_device_group_org_fk = the group vanished
 *  between assertGroupInOrg and the insert (deleteDeviceGroup holds FOR UPDATE
 *  on the group row, so the insert waited and then lost). Same answer. */
function isGroupFkViolation(err: unknown): boolean {
  const node = pgErrorNode(err);
  const constraint = node?.constraint_name ?? node?.constraint;
  return node?.code === '23503' && constraint === 'contract_lines_device_group_org_fk';
}

const SITE_SCOPABLE = new Set(['per_device', 'per_device_role']);

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
 *
 * Wave 6 (#3778) splits the helper in two. `lockContractRow` is the bare
 * SELECT ... FOR UPDATE + 404 and is what the SYSTEM producers use
 * (generateDueInvoice has no ContractActor to construct — it takes no actor at
 * all — and used to open with a plain unlocked SELECT, which is what made
 * ACTIVE-contract eligibility racy). `lockContract` is `lockContractRow` +
 * requireOrgAccess, so every user-facing path keeps its authorization check
 * byte-for-byte unchanged.
 */
export async function lockContractRow(tx: DbExecutor, contractId: string) {
  const [c] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).limit(1).for('update');
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  return c;
}

async function lockContract(tx: DbExecutor, contractId: string, actor: ContractActor) {
  const c = await lockContractRow(tx, contractId);
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
  // Creation barrier (#3778): org SHARE lock first, held to commit, so a
  // concurrent changeOrgCurrency cannot let a default-derived stamp land unseen.
  const [row] = await db.transaction(async (tx) => {
  const locked = await lockOrgStampingDefaults(tx, input.orgId);
  const [org] = await tx.select({ partnerId: organizations.partnerId })
    .from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  // Unreachable while the barrier above holds the org SHARE lock, but keep the
  // same code the barrier maps to rather than the misleading CONTRACT_NOT_FOUND.
  if (!org) throw new ContractServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
  return tx.insert(contracts).values({
    partnerId: org.partnerId, orgId: input.orgId, name: input.name, status: 'draft',
    billingTiming: input.billingTiming, intervalMonths: input.intervalMonths,
    startDate: input.startDate, endDate: input.endDate ?? null,
    autoIssue: input.autoIssue ?? false, currencyCode: input.currencyCode ?? locked.currencyCode,
    notes: input.notes ?? null, terms: input.terms ?? null, createdBy: actor.userId,
    autoRenew: input.autoRenew ?? false, renewalTermMonths: input.renewalTermMonths ?? null,
    renewalNoticeDays: input.renewalNoticeDays ?? null,
  }).returning();
  });
  return row!;
}

export async function getContract(contractId: string, actor: ContractActor) {
  const contract = await getOwnedContractOr404(contractId, actor);
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  const periods = await db.select().from(contractBillingPeriods)
    .where(eq(contractBillingPeriods.contractId, contractId)).orderBy(desc(contractBillingPeriods.periodStart));
  return { contract, lines: await withDeviceGroup(lines), periods };
}

type ContractRow = typeof contracts.$inferSelect;
export type ContractListRow = ContractRow & {
  estimatedPeriodValue: string | null;
  estimateError?: 'GROUP_EVALUATION_FAILED';
};

export async function listContracts(query: {
  orgId?: string; status?: string; limit?: number;
}, actor: ContractActor): Promise<ContractListRow[]> {
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
  if (rows.length === 0) return [];

  // Enrich each row with estimatedPeriodValue (live counts for per_device/per_seat
  // lines). All lines for the page load in one query; one device snapshot is
  // cached per org and seat counts are memoized per org, not per contract.
  const ids = rows.map((r) => r.id);
  const allLines = await db.select().from(contractLines).where(inArray(contractLines.contractId, ids));
  const byContract = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = byContract.get(l.contractId);
    if (list) list.push(l); else byContract.set(l.contractId, [l]);
  }
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  const out: ContractListRow[] = [];
  for (const c of rows) {
    let total = 0;
    let estimateError: 'GROUP_EVALUATION_FAILED' | undefined;
    try {
      const lines = byContract.get(c.id) ?? [];
      const groupIds = groupIdsOf(lines);
      if (groupIds.length > 0) await orgSnapshot(c.orgId, dc, groupIds);
      for (const l of lines) {
        const { quantity } = await resolveLineQty(c.orgId, l, dc, sc);
        total += Number(l.unitPrice) * quantity;
      }
    } catch (err) {
      // #3205 W02: one un-evaluable group must not fail the whole list.
      if (err instanceof ContractServiceError && err.code === 'GROUP_EVALUATION_FAILED') estimateError = err.code;
      else throw err;
    }
    out.push(estimateError
      ? { ...c, estimatedPeriodValue: null, estimateError }
      : { ...c, estimatedPeriodValue: total.toFixed(2) });
  }
  return out;
}

// ---- recurring-value estimate (live per_device/per_device_role/per_device_group/per_seat) ----
// One device snapshot per org PER CALCULATION (#3205): every device-counted line
// on a contract is computed from the same query, and every billed group is
// evaluated once per calculation. Never shared across the worker's per-contract
// transactions — "at generation time" must stay literally true.
interface OrgSnapshotEntry {
  devices: DeviceSnapshotRow[];
  groups: Map<string, GroupMembers>;
  failures: Map<string, ContractServiceError>;
  /** Group ids already looked up (resolved OR absent). Absent ids are not in `groups`, and
   *  must not be queried again on the next line of the same calculation. */
  attempted: Set<string>;
}
type DeviceCache = Map<string, OrgSnapshotEntry>; // key orgId
type SeatCache = Map<string, number>;              // key orgId
type ContractLineRow = typeof contractLines.$inferSelect;

function emptySnapshot(): OrgDeviceSnapshot {
  return { devices: [], groups: new Map() };
}

function groupIdsOf(lines: readonly Pick<ContractLineRow, 'lineType' | 'deviceGroupId'>[]): string[] {
  return [...new Set(lines.filter((l) => l.lineType === 'per_device_group' && l.deviceGroupId).map((l) => l.deviceGroupId!))];
}

/** The org's snapshot with the members of every group in `groupIds` resolved
 *  (once per calculation). A group id that does not come back — deleted between
 *  the line read and here, or not in this org — is simply absent from the map;
 *  callers treat that like a null id (GROUP_DELETED / unresolved). */
async function orgSnapshot(orgId: string, dc: DeviceCache, groupIds: readonly string[] = []): Promise<OrgDeviceSnapshot> {
  let entry = dc.get(orgId);
  if (!entry) {
    entry = { devices: await snapshotContractDevices(orgId), groups: new Map(), failures: new Map(), attempted: new Set() };
    dc.set(orgId, entry);
  }
  const priorFailure = groupIds.map((id) => entry!.failures.get(id)).find((failure) => failure !== undefined);
  if (priorFailure) throw priorFailure;
  const missing = groupIds.filter((id) => !entry!.attempted.has(id));
  if (missing.length > 0) {
    for (const id of missing) entry.attempted.add(id);
    const rows = await db.select({
      id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type,
      siteId: deviceGroups.siteId, filterConditions: deviceGroups.filterConditions,
    }).from(deviceGroups).where(and(inArray(deviceGroups.id, missing), eq(deviceGroups.orgId, orgId)));
    for (const g of rows) {
      try {
        entry.groups.set(g.id, await groupMembersForBilling(g));
      } catch (err) {
        if (err instanceof GroupEvaluationError) {
          entry.failures.set(g.id, new ContractServiceError(
            `Device group "${g.name}" could not be evaluated (${err.reason})`, 500, 'GROUP_EVALUATION_FAILED',
            { groupId: g.id, groupName: g.name, reason: err.reason },
          ));
          continue;
        }
        throw err;
      }
    }
  }
  const failure = groupIds.map((id) => entry.failures.get(id)).find((candidate) => candidate !== undefined);
  if (failure) throw failure;
  return entry;
}

/** Lines the pure helpers can resolve: a group line whose group is absent from
 *  the snapshot (deleted) covers nothing and is left out. */
function resolvableLines(lines: readonly ContractLineRow[], snapshot: OrgDeviceSnapshot): ContractLineRow[] {
  return lines.filter((l) => l.lineType !== 'per_device_group' || (l.deviceGroupId !== null && snapshot.groups.has(l.deviceGroupId)));
}

/** True when `line` is a per_device_role line whose deviceRoles is missing,
 *  empty, or (when `allowedRoles` is given) contains a role outside it. Shared
 *  core for the two guards below — they differ only in status code / message
 *  and in who is responsible for a bad set (DB CHECK vs untrusted spec input). */
function roleLineIsInvalid(
  line: { lineType: string; deviceRoles?: readonly string[] | null },
  allowedRoles?: ReadonlySet<string>,
): boolean {
  if (line.lineType !== 'per_device_role') return false;
  if (!line.deviceRoles || line.deviceRoles.length === 0) return true;
  return allowedRoles ? line.deviceRoles.some((role) => !allowedRoles.has(role)) : false;
}

function assertRoleLineHasRoles(line: Pick<ContractLineRow, 'id' | 'lineType' | 'deviceRoles'>): void {
  if (roleLineIsInvalid(line)) {
    // Unreachable under contract_lines_device_roles_chk, but the row type allows
    // null — and a role line must NEVER degrade into an every-device count.
    throw new ContractServiceError(`Contract line ${line.id} is per_device_role but carries no device roles`, 500, 'INVALID_STATE');
  }
}

const BILLABLE_DEVICE_ROLE_SET = new Set<string>(BILLABLE_DEVICE_ROLES);

// Task 7 widens the quote-conversion spec itself. Keep this producer ready for
// that input without weakening the existing NewContractSpec contract elsewhere.
type DeviceSetContractLineSpec = Omit<NewContractSpec['lines'][number], 'lineType'> & {
  lineType: ContractLineRow['lineType'];
  deviceGroupId?: string | null;
};

function assertSpecDeviceSetLine(line: {
  lineType: string;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
}): void {
  if (roleLineIsInvalid(line, BILLABLE_DEVICE_ROLE_SET)) {
    throw new ContractServiceError('per_device_role line requires at least one device role', 400, 'INVALID_STATE');
  }
  if (line.lineType === 'per_device_group' && !line.deviceGroupId) {
    throw new ContractServiceError('per_device_group line requires deviceGroupId', 400, 'INVALID_STATE');
  }
}

async function resolveLineQty(
  orgId: string, line: ContractLineRow, dc: DeviceCache, sc: SeatCache,
): Promise<{ quantity: number; live: boolean; unresolved?: 'group_deleted' }> {
  switch (line.lineType) {
    case 'flat': return { quantity: 1, live: false };
    case 'manual': return { quantity: Number(line.manualQuantity ?? '0'), live: false };
    case 'per_device':
    case 'per_device_role': {
      assertRoleLineHasRoles(line);
      return { quantity: quantityFor(await orgSnapshot(orgId, dc), line), live: true };
    }
    case 'per_device_group': {
      if (line.deviceGroupId === null) return { quantity: 0, live: true, unresolved: 'group_deleted' };
      const snapshot = await orgSnapshot(orgId, dc, [line.deviceGroupId]);
      if (!snapshot.groups.has(line.deviceGroupId)) return { quantity: 0, live: true, unresolved: 'group_deleted' };
      return { quantity: quantityFor(snapshot, line), live: true };
    }
    case 'per_seat': {
      if (!sc.has(orgId)) sc.set(orgId, await countContractSeats(orgId));
      return { quantity: sc.get(orgId)!, live: true };
    }
    default: {
      // Exhaustiveness: a new line type is a compile error here, not a silent qty 0.
      const _exhaustive: never = line.lineType;
      throw new ContractServiceError(`Unknown contract line type: ${String(line.lineType)}`, 500, 'INVALID_STATE');
    }
  }
}

export interface ContractEstimate {
  currencyCode: string;
  periodTotal: string;
  lines: Array<{ lineId: string; lineType: ContractLineRow['lineType']; quantity: number; value: string; live: boolean; unresolved?: 'group_deleted' }>;
  /** Devices no device-counted line bills (#3205). null when the contract has
   *  no per_device / per_device_role / per_device_group line, so the UI can tell "n/a" from "0". */
  uncoveredDevices: UncoveredDevices | null;
}

/** Per-line resolved quantities + values + period total for one contract, using
 *  live device/seat counts as of now. Powers the editor sidebar and detail. */
export async function computeContractEstimate(contractId: string, actor: ContractActor): Promise<ContractEstimate> {
  const contract = await getOwnedContractOr404(contractId, actor);
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder);
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  let total = 0;
  const out: ContractEstimate['lines'] = [];
  const groupIds = groupIdsOf(lines);
  if (groupIds.length > 0) await orgSnapshot(contract.orgId, dc, groupIds);
  for (const l of lines) {
    const { quantity, live, unresolved } = await resolveLineQty(contract.orgId, l, dc, sc);
    const value = Number(l.unitPrice) * quantity;
    total += value;
    out.push({ lineId: l.id, lineType: l.lineType, quantity, value: value.toFixed(2), live, ...(unresolved ? { unresolved } : {}) });
  }
  let uncoveredDevices: UncoveredDevices | null = null;
  if (lines.some(isDeviceLine)) {
    const snapshot = await orgSnapshot(contract.orgId, dc, groupIds);
    uncoveredDevices = uncoveredByRole(snapshot, resolvableLines(lines, snapshot));
  }
  return { currencyCode: contract.currencyCode, periodTotal: total.toFixed(2), lines: out, uncoveredDevices };
}

// ---- per-currency MRR rollup (multi-currency wave 7, #3779) ----------------

export interface OrgCurrencyMrr { currencyCode: string; amount: string }

/** `${catalogItemId}|${currencyCode}|${orgId}` */
type PriceKey = string;
function priceKey(itemId: string, currencyCode: string, orgId: string): PriceKey {
  return `${itemId}|${currencyCode}|${orgId}`;
}

/**
 * Batched, read-only price-book inputs for every catalog line in the rollup:
 * org overrides for the orgs in play and price-book rows for the currencies in
 * play, in two queries total rather than three per line.
 */
async function loadCatalogPriceInputs(
  itemIds: string[], orgIds: string[], currencyCodes: string[],
): Promise<{
  overrides: Map<string, { unitPrice: string; currencyCode: string }>;
  bookRows: Map<string, { unitPrice: string }>;
}> {
  const overrideRows = await db.select({
    itemId: catalogItemOrgPricing.catalogItemId,
    orgId: catalogItemOrgPricing.orgId,
    currencyCode: catalogItemOrgPricing.currencyCode,
    unitPrice: catalogItemOrgPricing.unitPrice,
  }).from(catalogItemOrgPricing)
    .where(and(inArray(catalogItemOrgPricing.catalogItemId, itemIds), inArray(catalogItemOrgPricing.orgId, orgIds)));
  const bookPriceRows = await db.select({
    itemId: catalogItemPrices.itemId,
    currencyCode: catalogItemPrices.currencyCode,
    unitPrice: catalogItemPrices.unitPrice,
  }).from(catalogItemPrices)
    .where(and(inArray(catalogItemPrices.itemId, itemIds), inArray(catalogItemPrices.currencyCode, currencyCodes)));

  const overrides = new Map<string, { unitPrice: string; currencyCode: string }>();
  for (const r of overrideRows) overrides.set(`${r.itemId}|${r.orgId}`, { unitPrice: r.unitPrice, currencyCode: r.currencyCode });
  const bookRows = new Map<string, { unitPrice: string }>();
  for (const r of bookPriceRows) bookRows.set(`${r.itemId}|${r.currencyCode}`, { unitPrice: r.unitPrice });
  return { overrides, bookRows };
}

/**
 * Estimated monthly recurring revenue per org, GROUPED BY the contract's own
 * stamped currency (multi-currency spec §8: honest per-currency segmentation,
 * never a cross-currency sum). One org can legitimately hold active contracts
 * in several currencies after an org-default change — history keeps its stamp.
 *
 * "Estimated" because per_device/per_seat quantities are resolved live; the
 * figure is never persisted. No FX happens here: converting to a single
 * reporting currency is the CALLER's optional, explicitly-approximate step.
 *
 * Catalog-backed lines are priced through the SAME resolver recurring billing
 * uses (`resolvePriceFrom`, spec §6: org override in the contract's currency →
 * price-book row for that currency → the line's stamped snapshot on a gap), so
 * the dashboard agrees with the invoices it predicts. Never converts and never
 * falls through to another currency's price.
 */
/**
 * The billing sites' expiry test, evaluated against the period the sweep is
 * NEXT going to bill (`duePeriodStartFor`, exactly as generateDueInvoice does).
 * A contract with no pointer can never produce another invoice, so it is judged
 * against today instead. Open-ended (endDate null) is never past its end.
 */
function isPastEndForReporting(
  c: { endDate: string | null; nextBillingAt: string | null; billingTiming: 'advance' | 'arrears'; intervalMonths: number },
  asOfISO: string,
): boolean {
  if (c.endDate === null || c.endDate === undefined) return false;
  const periodStart = c.nextBillingAt
    ? duePeriodStartFor(c.billingTiming, c.nextBillingAt, c.intervalMonths > 0 ? c.intervalMonths : 1)
    : asOfISO;
  return isExpired({ endDate: c.endDate, periodStart });
}

export async function summarizeActiveContractMrrByOrg(
  orgIds: readonly string[],
  asOf: Date = new Date(),
): Promise<Map<string, OrgCurrencyMrr[]>> {
  const out = new Map<string, OrgCurrencyMrr[]>();
  if (orgIds.length === 0) return out;

  const active = await db.select().from(contracts)
    .where(and(inArray(contracts.orgId, [...orgIds]), eq(contracts.status, 'active' as never)));
  // `status = 'active'` alone is NOT "still running": a contract is flipped to
  // 'expired' LAZILY inside generateDueInvoice / renewal, at its next billing
  // date — there is no expiry reaper — so an ended annual contract keeps the
  // 'active' stamp for up to a whole interval. Billing already skips it via
  // isExpired, so reporting it here would break this rollup's contract that the
  // dashboard agrees with the invoices it predicts. Same guard, same inputs.
  const rows = active.filter((c) => !isPastEndForReporting(c, todayISO(asOf)));
  if (rows.length === 0) return out;

  const allLines = await db.select().from(contractLines)
    .where(inArray(contractLines.contractId, rows.map((r) => r.id)));
  const byContract = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = byContract.get(l.contractId);
    if (list) list.push(l); else byContract.set(l.contractId, [l]);
  }

  // Price-book inputs, loaded once for the whole dashboard.
  const catalogItemIds = [...new Set(allLines.map((l) => l.catalogItemId).filter((v): v is string => !!v))];
  let overrides = new Map<string, { unitPrice: string; currencyCode: string }>();
  let bookRows = new Map<string, { unitPrice: string }>();
  if (catalogItemIds.length > 0) {
    const contractsWithCatalog = rows.filter((c) => (byContract.get(c.id) ?? []).some((l) => l.catalogItemId));
    const loaded = await loadCatalogPriceInputs(
      catalogItemIds,
      [...new Set(contractsWithCatalog.map((c) => c.orgId))],
      [...new Set(contractsWithCatalog.map((c) => c.currencyCode))],
    );
    overrides = loaded.overrides;
    bookRows = loaded.bookRows;
  }
  // Resolve once per distinct (itemId, currencyCode, orgId), like the device and
  // seat caches below.
  const priceCache = new Map<PriceKey, string | null>();
  function resolvedUnitPrice(itemId: string, currencyCode: string, orgId: string): string | null {
    const key = priceKey(itemId, currencyCode, orgId);
    if (priceCache.has(key)) return priceCache.get(key)!;
    // The rollup consumes only the unit price; candidate selection and
    // representability depend solely on the override/book rows and the target
    // currency, never on the item's cost snapshot — so the cost fields are
    // stubbed rather than loading every catalog item for a figure that ignores
    // them. A gap (either kind) is a null here: the caller bills the stamped
    // snapshot, exactly as addContractLine does.
    const resolved = resolvePriceFrom(
      { costBasis: null, costCurrency: currencyCode, taxable: false, taxCategory: null },
      overrides.get(`${itemId}|${orgId}`) ?? null,
      bookRows.get(`${itemId}|${currencyCode}`) ?? null,
      currencyCode,
    );
    const price = isPriceGap(resolved) ? null : resolved.unitPrice;
    priceCache.set(key, price);
    return price;
  }

  // Shared across ALL orgs in this call, so a distinct (org, site) device count
  // and a distinct org seat count each run exactly once for the whole dashboard.
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  const totals = new Map<string, Map<string, number>>(); // orgId -> currency -> monthly

  for (const c of rows) {
    let periodValue = 0;
    try {
      const lines = byContract.get(c.id) ?? [];
      const groupIds = groupIdsOf(lines);
      if (groupIds.length > 0) await orgSnapshot(c.orgId, dc, groupIds);
      for (const l of lines) {
        const { quantity, unresolved } = await resolveLineQty(c.orgId, l, dc, sc);
        if (unresolved === 'group_deleted') {
          console.warn(
            '[contracts] MRR rollup: contract %s line %s bills a deleted device group (%s); counted as 0',
            c.id,
            l.id,
            l.deviceGroupName,
          );
        }
        const unitPrice = l.catalogItemId
          ? (resolvedUnitPrice(l.catalogItemId, c.currencyCode, c.orgId) ?? l.unitPrice)
          : l.unitPrice;
        periodValue += Number(unitPrice) * quantity;
      }
    } catch (err) {
      if (err instanceof ContractServiceError && err.code === 'GROUP_EVALUATION_FAILED') {
        console.warn('[contracts] MRR rollup skipped contract %s: %s', c.id, err.message);
        continue;
      }
      throw err;
    }
    const months = c.intervalMonths > 0 ? c.intervalMonths : 1;
    // Round each contract in ITS OWN currency before grouping — a JPY contract
    // must never contribute a fractional yen.
    const monthly = Number(roundToCurrency(periodValue / months, c.currencyCode));
    const perOrg = totals.get(c.orgId) ?? new Map<string, number>();
    perOrg.set(c.currencyCode, (perOrg.get(c.currencyCode) ?? 0) + monthly);
    totals.set(c.orgId, perOrg);
  }

  for (const [orgId, perCurrency] of totals) {
    out.set(orgId, [...perCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, amount]) => ({ currencyCode, amount: roundToCurrency(amount, currencyCode) })));
  }
  return out;
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

// ---------------------------------------------------------------------------
// ACTIVE-contract currency eligibility (multi-currency wave 6, #3778, Task 14)
// ---------------------------------------------------------------------------

/**
 * The five blockers that make an ACTIVE contract ineligible for the
 * owner-approved currency restamp. `eligible` is true only when EVERY id list
 * is empty — eligibility is row EXISTENCE, never `SUM(line_total) > 0`, so a
 * zero-value line still blocks.
 */
export interface ContractCurrencyEligibility {
  eligible: boolean;
  /** Draft invoices reachable from this contract (period rows, their reissue
   *  descendants, and direct source_contract_id lines). */
  draftInvoiceIds: string[];
  /** contract_billing_periods rows with no invoice, or a missing/invisible one. */
  orphanedBillingPeriodIds: string[];
  /** Org-wide source_type='contract' lines on DRAFT invoices this service cannot attribute. */
  orphanedContractSourceLineIds: string[];
  /** Period invoices failing the explicit lineage check (c)/(d)/(e). */
  brokenLineageInvoiceIds: string[];
}

/** Depth cap for both replaces_invoice_id walks. A malformed or cyclic ancestry
 *  must terminate, never spin — the path array also rejects revisits. */
const LINEAGE_DEPTH_CAP = 32;

/**
 * Single source of truth for the ACTIVE-contract escape hatch, the wave-6
 * mismatch report and their tests — so the report can never disagree with the
 * mutation. MUST be called on a transaction that already holds the contract row
 * FOR UPDATE (lockContract / lockContractRow); it deliberately locks NOTHING
 * else, because reaching for an invoice lock here would invert the established
 * `invoice -> contract` order.
 *
 * "Unbilled monetary rows" is concrete in THIS schema: time_entries and
 * ticket_parts carry no contract_id (billing_status='contract' is a terminal
 * disposition marker, not a relation), so contract-qualified time/parts are not
 * a queryable relation at all — those rows belong to the ORG preflight, not
 * here. What is queryable is: contract_billing_periods.invoice_id, its reissue
 * descendants, and invoice_lines.source_contract_id (the durable column added by
 * migration 2026-09-02-a — NOT a current contract_lines membership join, which
 * removeContractLine can erase on an ACTIVE contract).
 */
export interface InspectContractCurrencyOptions {
  /**
   * READ-ONLY REPORT USE ONLY. Memo for blocker (4), whose scan is ORG-scoped,
   * not contract-scoped, and therefore identical for every contract of the same
   * org. Keyed by orgId. The mismatch report walks up to MAX_LIMIT rows and
   * without this re-ran the same org-wide invoice_lines scan once per row —
   * the connection-hold shape this repo has been bitten by before.
   *
   * The MUTATION never passes one: changeContractCurrency must re-read blocker
   * (4) fresh under the contract's own FOR UPDATE, and a memo would let a stale
   * verdict authorize a restamp. The report is explicitly advisory-at-this-
   * instant already (it holds no lock), so sharing one snapshot across its rows
   * costs it nothing it had.
   */
  orphanScanCache?: Map<string, string[]>;
}

export async function inspectContractCurrencyEligibility(
  tx: DbExecutor, contractId: string, opts: InspectContractCurrencyOptions = {}
): Promise<ContractCurrencyEligibility> {
  const [c] = await tx.select({ id: contracts.id, orgId: contracts.orgId, partnerId: contracts.partnerId })
    .from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');

  // (1)+(2) Period invoices and every reissue DESCENDANT reachable through
  // invoices.replaces_invoice_id. The path array makes a cyclic chain terminate
  // (a revisited id is never re-expanded) and the depth cap bounds a long one.
  const reachable = await tx.execute<{ id: string; status: string }>(sql`
    WITH RECURSIVE seed AS (
      SELECT i.id, ARRAY[i.id] AS path, 0 AS depth
        FROM contract_billing_periods cbp
        JOIN invoices i ON i.id = cbp.invoice_id
       WHERE cbp.contract_id = ${contractId}
    ), walk AS (
      SELECT id, path, depth FROM seed
      UNION ALL
      SELECT child.id, w.path || child.id, w.depth + 1
        FROM walk w
        JOIN invoices child ON child.replaces_invoice_id = w.id
       WHERE w.depth < ${LINEAGE_DEPTH_CAP} AND NOT (child.id = ANY(w.path))
    )
    SELECT DISTINCT w.id AS id, i.status::text AS status
      FROM walk w JOIN invoices i ON i.id = w.id
  `);

  // (3) Direct contract-source lines sitting on ANY draft invoice — the escape
  // codex found: the contract_lines row can be deleted, this column cannot.
  // The second branch is defence in depth (wave-6 review round): a line whose
  // durable lineage is NULL but whose polymorphic source_id still resolves to a
  // LIVE contract_lines row of THIS contract is attributable, and must block the
  // restamp too. Without it such a line falls through (4) as well, because (4)
  // only fires when the source_id resolves to nothing.
  const directDrafts = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT i.id AS id
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
     WHERE i.status = 'draft'
       AND (
         il.source_contract_id = ${contractId}
         OR (
           il.source_contract_id IS NULL
           AND EXISTS (
             SELECT 1 FROM contract_lines cl
              WHERE cl.id = il.source_id AND cl.contract_id = ${contractId}
           )
         )
       )
  `);

  // (4) Conservative ORG-WIDE blocker: a source_type='contract' line the service
  // cannot attribute to any contract (NULL lineage AND a source_id resolving to
  // no live contract_lines row, NULL source_id included). Refuse, never guess.
  //
  // SCOPED TO DRAFT, exactly as blocker (3) is. The blocker exists to stop a
  // restamp while money that MIGHT belong to this contract is still unbilled and
  // re-priceable; a line on an issued/paid/void invoice is already billed and
  // carries the invoice's own immutable currency snapshot, so no restamp can
  // strand it. Without the status filter the blocker was unsatisfiable: migration
  // 2026-09-02-a RAISEs a warning for precisely these legacy rows (a
  // contract_lines row deleted before the durable column existed), they sit on
  // invoices that can never be edited or deleted, and ONE of them 409'd EVERY
  // active contract in the org forever — locking the pre-wave-2 legacy orgs out
  // of the escape hatch that was built for them.
  const cachedOrphans = opts.orphanScanCache?.get(c.orgId);
  let orphanedContractSourceLineIds: string[];
  if (cachedOrphans) {
    orphanedContractSourceLineIds = cachedOrphans;
  } else {
    const orphanSources = await tx.execute<{ id: string }>(sql`
      SELECT il.id AS id
        FROM invoice_lines il
        JOIN invoices i ON i.id = il.invoice_id
       WHERE il.org_id = ${c.orgId}
         AND i.status = 'draft'
         AND il.source_type = 'contract'
         AND il.source_contract_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM contract_lines cl WHERE cl.id = il.source_id)
       ORDER BY il.id
    `);
    orphanedContractSourceLineIds = orphanSources.map((r) => r.id);
    opts.orphanScanCache?.set(c.orgId, orphanedContractSourceLineIds);
  }

  // (5) Explicit per-period lineage proof. (a)/(b) -> ORPHANED_BILLING_PERIOD;
  // (c)/(d)/(e) -> BROKEN_CONTRACT_LINEAGE. The ANCESTRY walk runs upward
  // through replaces_invoice_id with the same path/depth protection.
  const periods = await tx.execute<{
    period_id: string; invoice_id: string | null; invoice_exists: boolean;
    same_tenant: boolean; attributable: boolean; ancestry_ok: boolean;
  }>(sql`
    WITH RECURSIVE seed AS (
      SELECT cbp.id AS period_id, i.id AS inv_id, i.replaces_invoice_id AS parent,
             ARRAY[i.id] AS path, 0 AS depth,
             (i.org_id = ${c.orgId} AND i.partner_id = ${c.partnerId}) AS ok
        FROM contract_billing_periods cbp
        JOIN invoices i ON i.id = cbp.invoice_id
       WHERE cbp.contract_id = ${contractId}
    ), up AS (
      SELECT * FROM seed
      UNION ALL
      SELECT u.period_id, p.id, p.replaces_invoice_id, u.path || p.id, u.depth + 1,
             (p.org_id = ${c.orgId} AND p.partner_id = ${c.partnerId}) AS ok
        FROM up u
        JOIN invoices p ON p.id = u.parent
       WHERE u.depth < ${LINEAGE_DEPTH_CAP} AND NOT (p.id = ANY(u.path))
    ), ancestry AS (
      SELECT period_id,
             bool_and(ok) AS all_same_tenant,
             -- terminated cleanly: no unfollowed parent left dangling because of
             -- a revisit (cycle) or the depth cap.
             bool_and(parent IS NULL
                      OR (depth < ${LINEAGE_DEPTH_CAP} AND NOT (parent = ANY(path)))) AS terminates
        FROM up GROUP BY period_id
    )
    SELECT cbp.id AS period_id,
           cbp.invoice_id AS invoice_id,
           (i.id IS NOT NULL) AS invoice_exists,
           COALESCE(a.all_same_tenant, false) AS same_tenant,
           COALESCE(
             EXISTS (SELECT 1 FROM invoice_lines il
                      WHERE il.invoice_id = cbp.invoice_id AND il.source_contract_id = ${contractId})
             OR NOT EXISTS (SELECT 1 FROM contract_billing_periods o
                             WHERE o.invoice_id = cbp.invoice_id AND o.contract_id <> ${contractId}),
             false) AS attributable,
           COALESCE(a.terminates, false) AS ancestry_ok
      FROM contract_billing_periods cbp
      LEFT JOIN invoices i ON i.id = cbp.invoice_id
      LEFT JOIN ancestry a ON a.period_id = cbp.id
     WHERE cbp.contract_id = ${contractId}
     ORDER BY cbp.id
  `);

  const draftInvoiceIds = [...new Set([
    ...reachable.filter((r) => r.status === 'draft').map((r) => r.id),
    ...directDrafts.map((r) => r.id),
  ])].sort();

  const orphanedBillingPeriodIds: string[] = [];
  const brokenLineageInvoiceIds: string[] = [];
  for (const p of periods) {
    // (a) no invoice at all, or (b) the invoice row is missing/invisible.
    if (p.invoice_id === null || !p.invoice_exists) { orphanedBillingPeriodIds.push(p.period_id); continue; }
    if (!p.same_tenant || !p.attributable || !p.ancestry_ok) brokenLineageInvoiceIds.push(p.invoice_id);
  }

  return {
    eligible: draftInvoiceIds.length === 0
      && orphanedBillingPeriodIds.length === 0
      && orphanedContractSourceLineIds.length === 0
      && brokenLineageInvoiceIds.length === 0,
    draftInvoiceIds,
    orphanedBillingPeriodIds,
    orphanedContractSourceLineIds,
    brokenLineageInvoiceIds: [...new Set(brokenLineageInvoiceIds)],
  };
}

/**
 * Gate for the ACTIVE branch of changeContractCurrency. Throws the most
 * specific blocker, each carrying the offending ids in `details` so the
 * operator can act on the exact rows instead of guessing.
 */
function assertActiveContractEligible(e: ContractCurrencyEligibility): void {
  if (e.orphanedContractSourceLineIds.length > 0) {
    throw new ContractServiceError(
      `${e.orphanedContractSourceLineIds.length} contract-sourced invoice line(s) in this organization cannot be attributed to a contract — resolve them before restamping`,
      409, 'ORPHANED_CONTRACT_SOURCE', { lineIds: e.orphanedContractSourceLineIds }
    );
  }
  if (e.orphanedBillingPeriodIds.length > 0) {
    throw new ContractServiceError(
      `${e.orphanedBillingPeriodIds.length} billing period(s) on this contract have no reachable invoice`,
      409, 'ORPHANED_BILLING_PERIOD', { billingPeriodIds: e.orphanedBillingPeriodIds }
    );
  }
  if (e.brokenLineageInvoiceIds.length > 0) {
    throw new ContractServiceError(
      `${e.brokenLineageInvoiceIds.length} invoice(s) linked to this contract fail the lineage check`,
      409, 'BROKEN_CONTRACT_LINEAGE', { invoiceIds: e.brokenLineageInvoiceIds }
    );
  }
  if (e.draftInvoiceIds.length > 0) {
    throw new ContractServiceError(
      `${e.draftInvoiceIds.length} draft invoice(s) still hold money billed under this contract — issue, void or delete them first`,
      409, 'UNBILLED_MONETARY_ROWS', { draftInvoiceIds: e.draftInvoiceIds }
    );
  }
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
  input: { currencyCode: string; clearLines?: boolean; reprice?: boolean; confirmActiveChange?: boolean },
  actor: ContractActor
) {
  return db.transaction(async (tx) => {
    // Contract row lock FIRST (document → lines). The line writers,
    // activateContract and (since wave 6) generateDueInvoice take the same lock,
    // so a concurrent activate, line write or billing run serializes against the
    // restamp — which is what makes the eligibility check below race-safe.
    const c = await lockContract(tx, contractId, actor);
    if (c.status !== 'draft') {
      // Wave 6 (#3778), owner-approved escape hatch. ONLY 'active' opens; every
      // other status keeps the wave-2 rejection byte-for-byte.
      if ((c.status as string) !== 'active') assertDraft(c);
      if (!actorCan(actor, PERMISSION_GRANTS.CONTRACTS_MANAGE)) {
        throw new ContractServiceError(
          'Restamping an active contract requires the contracts:manage permission',
          403, 'ACTIVE_CHANGE_FORBIDDEN'
        );
      }
      if (input.confirmActiveChange !== true) {
        throw new ContractServiceError(
          'Restamping an active contract requires confirmActiveChange',
          400, 'ACTIVE_CHANGE_CONFIRMATION_REQUIRED'
        );
      }
      // Re-checked HERE, under the FOR UPDATE taken above — never before it.
      assertActiveContractEligible(await inspectContractCurrencyEligibility(tx, contractId));
    }
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
          throw new ContractServiceError(`${rest} non-catalog line(s) have no price in the new currency — remove all lines first, or keep the current currency`, 409, 'CURRENCY_LOCKED');
        }
        const catalogActor = { userId: actor.userId, partnerId: c.partnerId, accessibleOrgIds: actor.accessibleOrgIds };
        for (const line of repriceable) {
          let resolved: Awaited<ReturnType<typeof resolvePrice>>;
          try {
            resolved = await resolvePrice(line.catalogItemId!, input.currencyCode, c.orgId, catalogActor, tx);
          } catch (err) {
            if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) {
                throw new ContractServiceError(err.message, 409, err.code);
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
/**
 * Wave-6 release gate (W6-G3-1): a hand-entered non-catalog contract line price
 * must be representable in the CONTRACT's stamped currency. A contract line is
 * the template for every future generated invoice snapshot, so an unrepresentable
 * ¥100.50 here propagates to every invoice the sweep produces. Never rounded
 * silently (owner-fixed: no conversion).
 */
function assertRepresentable(value: string, currencyCode: string): void {
  if (!isRepresentableInCurrency(value, currencyCode)) {
    throw new ContractServiceError(
      `${value} is not representable in ${currencyCode} — this currency has ${minorUnitExponent(currencyCode)} decimal place(s)`,
      400, 'PRICE_NOT_REPRESENTABLE'
    );
  }
}

export async function addContractLineToContract(contractId: string, input: ContractLineInput, actor: ContractActor) {
  return db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    assertEditable(c);
    assertSpecDeviceSetLine(input);
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
        if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) {
            throw new ContractServiceError(err.message, 409, err.code);
        }
        throw err;
      }
      unitPrice = resolved.unitPrice;
      taxable = resolved.taxable;
    } else {
      // The shared validator already requires unitPrice here; this is the
      // service-level backstop for internal callers.
      if (input.unitPrice === undefined || input.taxable === undefined) {
        throw new ContractServiceError('unitPrice and taxable are required unless catalogItemId is set', 400, 'INVALID_STATE');
      }
      unitPrice = input.unitPrice;
      assertRepresentable(unitPrice, c.currencyCode);
      taxable = input.taxable;
    }
    const siteId = SITE_SCOPABLE.has(input.lineType) ? (input.siteId ?? null) : null;
    if (siteId) await assertSiteInOrg(tx, siteId, c.orgId);
    const group = input.lineType === 'per_device_group' && input.deviceGroupId
      ? await assertGroupInOrg(tx, input.deviceGroupId, c.orgId) : null;
    try {
      const [row] = await tx.insert(contractLines).values({
        contractId, orgId: c.orgId, lineType: input.lineType, description: input.description,
        catalogItemId: input.catalogItemId ?? null, unitPrice,
        manualQuantity: input.lineType === 'manual' ? (input.manualQuantity ?? '0') : null,
        siteId,
        // #3205: roles only on per_device_role (CHECK-enforced); the validator
        // already guarantees a non-empty, duplicate-free, billable set.
        deviceRoles: input.lineType === 'per_device_role' ? (input.deviceRoles ?? null) : null,
        deviceGroupId: group?.id ?? null,
        deviceGroupName: group?.name ?? null,
        taxable, sortOrder: input.sortOrder ?? 0
      }).returning();
      return row!;
    } catch (err) {
      if (isGroupFkViolation(err)) {
        throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
      }
      throw err;
    }
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
  /** Devices no device-counted line billed on this run (#3205). null when the
   *  contract has no per_device / per_device_role / per_device_group line or nothing generated.
   *  Rides beside priceBookGaps: the worker logs it, the generate route returns it. */
  uncoveredDevices: UncoveredDevices | null;
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
  // PRODUCER SERIALIZATION (#3778): lock the contract row as the FIRST statement
  // of the caller-supplied transaction. Until wave 6 this opened with a plain
  // unlocked SELECT while every other contract writer locked — so a billing run
  // could read the OLD stamp, and an ACTIVE-contract restamp could pass its
  // eligibility check, concurrently. lockContractRow (not lockContract) because
  // this is a SYSTEM path with no ContractActor to construct; org access is the
  // caller's (worker / route) responsibility and is unchanged.
  const c = await lockContractRow(db, contractId);
  // Cast the enum to a string for comparison — postgres.js returns the enum as a
  // plain string but drizzle types it as the narrow union; `as never` keeps tsc happy
  // while the runtime check stays a simple string compare (mirrors listContracts).
  if ((c.status as never) !== ('active' as never) || c.nextBillingAt === null) {
    return { generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [], uncoveredDevices: null };
  }
  if (c.nextBillingAt > todayISO(asOf)) return { generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [], uncoveredDevices: null };

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
    return { generated: false, autoIssue: false, skipped: 'expired', priceBookGaps: [], uncoveredDevices: null };
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
    return { generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [], uncoveredDevices: null };
  }

  const hasDeviceLine = lines.some(isDeviceLine);
  const dc: DeviceCache = new Map();
  const snapshot = hasDeviceLine ? await orgSnapshot(c.orgId, dc, groupIdsOf(lines)) : emptySnapshot();
  // #3205 W02: a group line whose group is gone must never bill zero silently.
  for (const l of lines) {
    if (l.lineType === 'per_device_group' && (l.deviceGroupId === null || !snapshot.groups.has(l.deviceGroupId))) {
      throw new ContractServiceError(
        `Contract line "${l.description}" bills device group "${l.deviceGroupName ?? ''}", which no longer exists`,
        409, 'GROUP_DELETED', { contractLineId: l.id, deviceGroupName: l.deviceGroupName },
      );
    }
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
      case 'per_device_role':
      case 'per_device_group':
        assertRoleLineHasRoles(l);
        quantity = String(quantityFor(snapshot, l));
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
      catalogItemId: l.catalogItemId, sourceId: l.id,
      // Durable lineage (#3778): the CONTRACT id, not just the contract_line id.
      // Survives removeContractLine, which is permitted on active contracts.
      contractId
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
    return { generated: false, autoIssue: false, skipped: 'already_billed', priceBookGaps: [], uncoveredDevices: null };
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
  const uncoveredDevices = hasDeviceLine ? uncoveredByRole(snapshot, resolvableLines(lines, snapshot)) : null;
  return { generated: true, invoiceId: inv.id, autoIssue: c.autoIssue, actor, priceBookGaps, uncoveredDevices };
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
    const l = spec.lines[i]! as DeviceSetContractLineSpec;
    assertSpecDeviceSetLine(l);
    // Same guard as addContractLineToContract — the quote→contract conversion
    // path must not be a way around it (W6-G3-1).
    assertRepresentable(l.unitPrice, spec.currencyCode);
    const siteId = SITE_SCOPABLE.has(l.lineType) ? (l.siteId ?? null) : null;
    if (siteId) await assertSiteInOrg(db, siteId, spec.orgId);
    const group = l.lineType === 'per_device_group' && l.deviceGroupId
      ? await assertGroupInOrg(db, l.deviceGroupId, spec.orgId) : null;
    let insertedLine: { id: string } | undefined;
    try {
      [insertedLine] = await db.insert(contractLines).values({
        contractId: contract.id,
        orgId: spec.orgId,
        lineType: l.lineType,
        description: l.description,
        catalogItemId: l.catalogItemId ?? null,
        unitPrice: l.unitPrice,
        manualQuantity: l.lineType === 'manual' ? (l.manualQuantity ?? '0') : null,
        siteId,
        deviceRoles: l.lineType === 'per_device_role' ? (l.deviceRoles ?? null) : null,
        deviceGroupId: group?.id ?? null,
        deviceGroupName: group?.name ?? null,
        taxable: l.taxable,
        sortOrder: l.sortOrder ?? i,
      }).returning({ id: contractLines.id });
    } catch (err) {
      if (isGroupFkViolation(err)) {
        throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
      }
      throw err;
    }

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
