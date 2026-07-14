import type { Pax8OrderStatus, Pax8SubmitState } from '@breeze/shared';
import { runOutsideDbContext } from '../db';
import type { Pax8OrderLineRow, Pax8OrderRow } from './pax8OrderService';
import { Pax8OrderError } from './pax8OrderService';
import {
  Pax8ApiError,
  type Pax8Client,
  type Pax8CreateOrderInput,
  type Pax8OrderRecord,
  type Pax8OrderResult,
  type Pax8SubscriptionRecord,
} from './pax8Client';
import { pax8OrderSubmitRepository } from './pax8OrderSubmitRepository';

export interface SubmitBundle {
  order: Pax8OrderRow;
  lines: Pax8OrderLineRow[];
}

export interface SubmitLineOutcome {
  lineId: string;
  submitState: 'succeeded' | 'failed' | 'needs_reconcile';
  error: string | null;
  resultSubscriptionId: string | null;
}

export interface SubmitResult {
  orderId: string;
  status: Pax8OrderStatus;
  lines: Array<{ lineId: string; submitState: Pax8SubmitState; error: string | null }>;
}

export interface Pax8OrderSubmitRepository {
  loadResolvedOrder(input: { partnerId: string; orderId: string }): Promise<SubmitBundle>;
  claimOrder(input: { partnerId: string; orderId: string; actorUserId: string }): Promise<SubmitBundle>;
  createClient(bundle: SubmitBundle): Promise<Pax8Client>;
  claimLines(bundle: SubmitBundle): Promise<void>;
  persistPreflightFailure(bundle: SubmitBundle, errorBody: string): Promise<SubmitResult>;
  persistSubmitResults(
    bundle: SubmitBundle,
    outcomes: SubmitLineOutcome[],
    pax8OrderId: string | null,
  ): Promise<SubmitResult>;
  loadReconcileOrder(input: { partnerId: string; orderId: string }): Promise<SubmitBundle>;
  resetUnsentOrder(bundle: SubmitBundle): Promise<{ resolved: number; stillUnknown: number }>;
  persistReconcileResults(
    bundle: SubmitBundle,
    outcomes: SubmitLineOutcome[],
    pax8OrderId: string | null,
  ): Promise<{ resolved: number; stillUnknown: number }>;
}

interface ServiceDeps {
  repository: Pax8OrderSubmitRepository;
  runOutsideDbContext: typeof runOutsideDbContext;
}

function numberQuantity(value: string | null): number {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) {
    throw new Pax8OrderError('A Pax8 order line has an invalid quantity.', 422);
  }
  return quantity;
}

function newSubscriptionLines(bundle: SubmitBundle): Pax8OrderLineRow[] {
  return bundle.lines.filter((line) => line.action === 'new_subscription');
}

function buildCreateOrderInput(bundle: SubmitBundle): Pax8CreateOrderInput | null {
  const lines = newSubscriptionLines(bundle);
  if (lines.length === 0) return null;
  if (!bundle.order.pax8CompanyId) {
    throw new Pax8OrderError('Map this organization to a Pax8 company before ordering.', 422);
  }
  return {
    companyId: bundle.order.pax8CompanyId,
    lineItems: lines.map((line) => {
      if (!line.pax8ProductId || !line.billingTerm || line.quantity === null) {
        throw new Pax8OrderError('A new Pax8 subscription line is incomplete.', 422);
      }
      if (!Array.isArray(line.provisioningDetails)) {
        throw new Pax8OrderError('A new Pax8 subscription line has invalid provisioning details.', 422);
      }
      const provisioningDetails = line.provisioningDetails as Array<{ key: string; values: string[] }>;
      return {
        lineItemNumber: line.sortOrder + 1,
        productId: line.pax8ProductId,
        quantity: numberQuantity(line.quantity),
        billingTerm: line.billingTerm,
        ...(line.commitmentTermId ? { commitmentTermId: line.commitmentTermId } : {}),
        ...(provisioningDetails.length > 0
          ? { provisioningDetails }
          : {}),
      };
    }),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Pax8ApiError) return error.body || error.message;
  return error instanceof Error ? error.message : String(error);
}

function classifyWriteError(error: unknown): Pick<SubmitLineOutcome, 'submitState' | 'error'> {
  if ((error instanceof Pax8ApiError && error.status !== undefined
      && error.status >= 400 && error.status < 500)
    || error instanceof Pax8OrderError) {
    return { submitState: 'failed', error: errorText(error) };
  }
  return { submitState: 'needs_reconcile', error: errorText(error) };
}

function uniqueBijection<TLocal, TRemote>(
  local: TLocal[],
  remote: TRemote[],
  compatible: (local: TLocal, remote: TRemote) => boolean,
): number[] | null {
  if (local.length !== remote.length) return null;
  const assignments: number[][] = [];
  const used = new Set<number>();
  const current: number[] = [];
  const visit = (index: number): void => {
    if (assignments.length > 1) return;
    if (index === local.length) {
      assignments.push([...current]);
      return;
    }
    for (let remoteIndex = 0; remoteIndex < remote.length; remoteIndex += 1) {
      if (used.has(remoteIndex) || !compatible(local[index]!, remote[remoteIndex]!)) continue;
      used.add(remoteIndex);
      current.push(remoteIndex);
      visit(index + 1);
      current.pop();
      used.delete(remoteIndex);
    }
  };
  visit(0);
  return assignments.length === 1 ? assignments[0]! : null;
}

function createResponseAssignment(lines: Pax8OrderLineRow[], result: Pax8OrderResult): number[] | null {
  return uniqueBijection(lines, result.lineItems, (line, item) => {
    if (!item.subscriptionId) return false;
    const numberEvidence = item.lineItemNumber !== null;
    const productEvidence = item.productId !== null;
    if (!numberEvidence && !productEvidence) return false;
    if (numberEvidence && item.lineItemNumber !== line.sortOrder + 1) return false;
    if (productEvidence && item.productId !== line.pax8ProductId) return false;
    return true;
  });
}

async function preflightBundle(
  bundle: SubmitBundle,
  client: Pax8Client,
  outside: typeof runOutsideDbContext,
): Promise<{ ok: true } | { ok: false; errorBody: string }> {
  const createInput = buildCreateOrderInput(bundle);
  if (!createInput) return { ok: true };
  try {
    await outside(() => client.createOrder(createInput, { isMock: true }));
    return { ok: true };
  } catch (error) {
    return { ok: false, errorBody: errorText(error) };
  }
}

async function executeWrites(
  bundle: SubmitBundle,
  client: Pax8Client,
): Promise<{ outcomes: SubmitLineOutcome[]; pax8OrderId: string | null }> {
  const outcomes: SubmitLineOutcome[] = [];
  let pax8OrderId: string | null = null;
  const newLines = newSubscriptionLines(bundle);
  const createInput = buildCreateOrderInput(bundle);

  if (createInput && newLines.length > 0) {
    try {
      const result = await client.createOrder(createInput);
      pax8OrderId = result.pax8OrderId;
      const assignment = createResponseAssignment(newLines, result);
      if (!assignment || !result.pax8OrderId) {
        for (const line of newLines) {
          outcomes.push({
            lineId: line.id,
            submitState: 'needs_reconcile',
            error: 'Pax8 created the order, but its returned line mapping was missing or ambiguous.',
            resultSubscriptionId: null,
          });
        }
      } else {
        for (let index = 0; index < newLines.length; index += 1) {
          outcomes.push({
            lineId: newLines[index]!.id,
            submitState: 'succeeded',
            error: null,
            resultSubscriptionId: result.lineItems[assignment[index]!]!.subscriptionId,
          });
        }
      }
    } catch (error) {
      const classified = classifyWriteError(error);
      for (const line of newLines) {
        outcomes.push({
          lineId: line.id,
          ...classified,
          resultSubscriptionId: null,
        });
      }
    }
  }

  for (const line of bundle.lines) {
    if (line.action === 'new_subscription') continue;
    try {
      if (!line.targetSubscriptionId) {
        throw new Pax8OrderError('A subscription action has no target subscription.', 422);
      }
      if (line.action === 'change_quantity') {
        if (line.quantity === null) throw new Pax8OrderError('A quantity change has no quantity.', 422);
        await client.updateSubscriptionQuantity(line.targetSubscriptionId, numberQuantity(line.quantity));
      } else {
        await client.cancelSubscription(line.targetSubscriptionId, line.cancelDate);
      }
      outcomes.push({
        lineId: line.id,
        submitState: 'succeeded',
        error: null,
        resultSubscriptionId: line.targetSubscriptionId,
      });
    } catch (error) {
      outcomes.push({
        lineId: line.id,
        ...classifyWriteError(error),
        resultSubscriptionId: null,
      });
    }
  }
  return { outcomes, pax8OrderId };
}

function sameQuantity(left: string | null, right: string): boolean {
  return left !== null && Number(left) === Number(right);
}

function reconcileNewBatch(
  bundle: SubmitBundle,
  unknownNewLines: Pax8OrderLineRow[],
  orders: Pax8OrderRecord[],
): { outcomes: SubmitLineOutcome[]; pax8OrderId: string | null } {
  if (unknownNewLines.length === 0) return { outcomes: [], pax8OrderId: null };
  const allNewLines = newSubscriptionLines(bundle);
  const submittedDate = bundle.order.submittedAt?.toISOString().slice(0, 10) ?? null;
  const candidates: Array<{
    order: Pax8OrderRecord;
    subscriptionIds: string[];
  }> = [];
  if (submittedDate) {
    for (const order of orders) {
      if (order.pax8CompanyId !== bundle.order.pax8CompanyId || order.createdDate !== submittedDate) continue;
      if (bundle.order.pax8OrderId && order.pax8OrderId !== bundle.order.pax8OrderId) continue;
      const assignment = uniqueBijection(allNewLines, order.lineItems, (line, item) => {
        if (!item.quantityKnown || !sameQuantity(line.quantity, item.quantity)) return false;
        const numberEvidence = item.lineItemNumber !== null;
        const productEvidence = item.productId !== null;
        if (!numberEvidence && !productEvidence) return false;
        if (numberEvidence && item.lineItemNumber !== line.sortOrder + 1) return false;
        if (productEvidence && item.productId !== line.pax8ProductId) return false;
        return true;
      });
      if (!assignment) continue;
      const subscriptionIds = assignment.map((index) => order.lineItems[index]!.subscriptionId);
      if (subscriptionIds.some((id) => !id)
        || new Set(subscriptionIds).size !== allNewLines.length) continue;
      candidates.push({ order, subscriptionIds: subscriptionIds as string[] });
    }
  }
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const localIndex = new Map(allNewLines.map((line, index) => [line.id, index]));
    return {
      outcomes: unknownNewLines.map((line) => {
        const index = localIndex.get(line.id)!;
        return {
          lineId: line.id,
          submitState: 'succeeded',
          error: null,
          resultSubscriptionId: candidate.subscriptionIds[index]!,
        };
      }),
      pax8OrderId: candidate.order.pax8OrderId,
    };
  }
  // Pax8 Order.createdDate is only a date, not a timestamp. Multiple matching
  // same-day orders cannot be safely disambiguated, so human reconcile leaves
  // the line unknown rather than guessing which billable write landed.
  const error = candidates.length === 0
    ? 'No complete, conclusive Pax8 order match was found.'
    : 'Multiple matching same-day Pax8 orders were found.';
  return {
    outcomes: unknownNewLines.map((line) => ({
      lineId: line.id,
      submitState: 'needs_reconcile',
      error,
      resultSubscriptionId: null,
    })),
    pax8OrderId: null,
  };
}

function reconcileSubscriptionLine(
  line: Pax8OrderLineRow,
  pax8CompanyId: string,
  subscriptions: Pax8SubscriptionRecord[],
): SubmitLineOutcome {
  const target = subscriptions.filter((row) =>
    row.pax8SubscriptionId === line.targetSubscriptionId
    && row.pax8CompanyId === pax8CompanyId);
  if (target.length > 1) {
    return { lineId: line.id, submitState: 'needs_reconcile', error: 'Pax8 returned duplicate target subscriptions.', resultSubscriptionId: null };
  }
  if (line.action === 'cancel') {
    const subscription = target[0];
    const terminal = subscription?.status
      ? ['cancelled', 'canceled', 'terminated'].includes(subscription.status.toLowerCase())
      : false;
    const scheduled = !!line.cancelDate && subscription?.endDate === line.cancelDate;
    return terminal || scheduled
      ? { lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: line.targetSubscriptionId }
      : { lineId: line.id, submitState: 'needs_reconcile', error: 'Pax8 cancellation evidence is not conclusive.', resultSubscriptionId: null };
  }
  if (target.length === 1) {
    return target[0]!.quantityKnown && sameQuantity(line.quantity, target[0]!.quantity)
      ? { lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: target[0]!.pax8SubscriptionId }
      : { lineId: line.id, submitState: 'needs_reconcile', error: 'Pax8 quantity evidence is not conclusive.', resultSubscriptionId: null };
  }
  return { lineId: line.id, submitState: 'needs_reconcile', error: 'The target Pax8 subscription was not conclusively found.', resultSubscriptionId: null };
}

export function createPax8OrderSubmitService(deps: ServiceDeps) {
  return {
    async preflightOrder(input: { partnerId: string; orderId: string }) {
      const bundle = await deps.repository.loadResolvedOrder(input);
      if (newSubscriptionLines(bundle).length === 0) return { ok: true } as const;
      const client = await deps.repository.createClient(bundle);
      return preflightBundle(bundle, client, deps.runOutsideDbContext);
    },

    async submitOrder(input: { partnerId: string; orderId: string; actorUserId: string }): Promise<SubmitResult> {
      const bundle = await deps.repository.claimOrder(input);
      let client: Pax8Client;
      try {
        client = await deps.repository.createClient(bundle);
      } catch (error) {
        return deps.repository.persistPreflightFailure(bundle, errorText(error));
      }
      const preflight = await preflightBundle(bundle, client, deps.runOutsideDbContext);
      if (!preflight.ok) {
        return deps.repository.persistPreflightFailure(bundle, preflight.errorBody);
      }
      await deps.repository.claimLines(bundle);
      const execution = await deps.runOutsideDbContext(() => executeWrites(bundle, client));
      return deps.repository.persistSubmitResults(bundle, execution.outcomes, execution.pax8OrderId);
    },

    async reconcileOrder(input: { partnerId: string; orderId: string }): Promise<{ resolved: number; stillUnknown: number }> {
      const bundle = await deps.repository.loadReconcileOrder(input);
      // A crash can leave a line in_flight before or during the one real Pax8
      // attempt. Both states are ambiguous and require the same read-only human
      // reconciliation path; neither may be re-sent blindly.
      const unknown = bundle.lines.filter((line) =>
        line.submitState === 'in_flight' || line.submitState === 'needs_reconcile');
      if (unknown.length === 0) {
        if (bundle.order.status === 'submitting'
          && bundle.lines.length > 0
          && bundle.lines.every((line) => line.submitState === 'pending')) {
          return deps.repository.resetUnsentOrder(bundle);
        }
        return { resolved: 0, stillUnknown: 0 };
      }
      if (!bundle.order.pax8CompanyId) {
        throw new Pax8OrderError('Map this organization to a Pax8 company before reconciliation.', 422);
      }
      const client = await deps.repository.createClient(bundle);
      const [orders, subscriptions] = await deps.runOutsideDbContext(() => Promise.all([
        client.listOrders({ companyId: bundle.order.pax8CompanyId! }),
        client.listSubscriptions({ companyId: bundle.order.pax8CompanyId! }),
      ]));
      const unknownNew = unknown.filter((line) => line.action === 'new_subscription');
      const newBatch = reconcileNewBatch(bundle, unknownNew, orders);
      const outcomes = [
        ...newBatch.outcomes,
        ...unknown.filter((line) => line.action !== 'new_subscription')
          .map((line) => reconcileSubscriptionLine(line, bundle.order.pax8CompanyId!, subscriptions)),
      ];
      return deps.repository.persistReconcileResults(bundle, outcomes, newBatch.pax8OrderId);
    },
  };
}

const defaultService = createPax8OrderSubmitService({
  repository: pax8OrderSubmitRepository,
  runOutsideDbContext,
});

export const preflightOrder = defaultService.preflightOrder;
export const submitOrder = defaultService.submitOrder;
export const reconcileOrder = defaultService.reconcileOrder;
