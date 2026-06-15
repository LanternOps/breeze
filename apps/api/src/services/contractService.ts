import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, contractBillingPeriods, organizations } from '../db/schema';
import { ContractServiceError, type ContractActor } from './contractTypes';
import type { ContractLineInput, UpdateContractInput } from '@breeze/shared';
import { periodIndexFor, nextBillingDate } from './contractMath';
import { emitContractEvent } from './contractEvents';

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
  startDate: string; endDate?: string; autoIssue?: boolean; currencyCode?: string; notes?: string; terms?: string;
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
    notes: input.notes ?? null, terms: input.terms ?? null, createdBy: actor.userId
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
  return rows;
}

export async function updateContract(contractId: string, patch: UpdateContractInput, actor: ContractActor) {
  const c = await getOwnedContractOr404(contractId, actor);
  assertEditable(c);
  // Explicit whitelist — never write status, orgId, partnerId, createdBy, id,
  // nextBillingAt, or currencyCode from caller input. Status transitions belong
  // to dedicated lifecycle functions.
  const safeSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined)           safeSet.name           = patch.name;
  if (patch.billingTiming !== undefined)  safeSet.billingTiming  = patch.billingTiming;
  if (patch.intervalMonths !== undefined) safeSet.intervalMonths = patch.intervalMonths;
  if (patch.startDate !== undefined)      safeSet.startDate      = patch.startDate;
  if ('endDate' in patch)                 safeSet.endDate        = patch.endDate ?? null;
  if (patch.autoIssue !== undefined)      safeSet.autoIssue      = patch.autoIssue;
  if ('notes' in patch)                   safeSet.notes          = patch.notes ?? null;
  if ('terms' in patch)                   safeSet.terms          = patch.terms ?? null;
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
  // db.$count is not available in drizzle-orm 0.45.x — use select fallback.
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
