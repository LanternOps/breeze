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
      return {
        lineItemNumber: line.sortOrder + 1,
        productId: line.pax8ProductId,
        quantity: numberQuantity(line.quantity),
        billingTerm: line.billingTerm,
        ...(line.commitmentTermId ? { commitmentTermId: line.commitmentTermId } : {}),
        ...(line.provisioningDetails.length > 0
          ? { provisioningDetails: line.provisioningDetails as Array<{ key: string; values: string[] }> }
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
  if (error instanceof Pax8ApiError && error.status !== undefined
    && error.status >= 400 && error.status < 500) {
    return { submitState: 'failed', error: errorText(error) };
  }
  return { submitState: 'needs_reconcile', error: errorText(error) };
}

function matchingSubscriptionId(
  line: Pax8OrderLineRow,
  result: Pax8OrderResult,
): string | null {
  const numbered = result.lineItems.filter((item) => item.lineItemNumber === line.sortOrder + 1);
  if (numbered.length === 1) return numbered[0]!.subscriptionId;
  const productMatches = result.lineItems.filter((item) => item.productId === line.pax8ProductId);
  return productMatches.length === 1 ? productMatches[0]!.subscriptionId : null;
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
      for (const line of newLines) {
        outcomes.push({
          lineId: line.id,
          submitState: 'succeeded',
          error: null,
          resultSubscriptionId: matchingSubscriptionId(line, result),
        });
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

function reconcileNewLine(
  bundle: SubmitBundle,
  line: Pax8OrderLineRow,
  orders: Pax8OrderRecord[],
): SubmitLineOutcome {
  const createdDate = bundle.order.createdAt.toISOString().slice(0, 10);
  const sameDayItems = orders
    .filter((order) => order.createdDate === createdDate)
    .flatMap((order) => order.lineItems);
  const exactNumber = sameDayItems.filter((item) =>
    item.lineItemNumber === line.sortOrder + 1
    && item.productId === line.pax8ProductId
    && sameQuantity(line.quantity, item.quantity));
  const productQuantity = sameDayItems.filter((item) =>
    item.productId === line.pax8ProductId && sameQuantity(line.quantity, item.quantity));
  const candidates = exactNumber.length > 0 ? exactNumber : productQuantity;
  if (candidates.length === 1) {
    return {
      lineId: line.id,
      submitState: 'succeeded',
      error: null,
      resultSubscriptionId: candidates[0]!.subscriptionId,
    };
  }
  if (candidates.length === 0) {
    return { lineId: line.id, submitState: 'failed', error: 'No matching Pax8 order was found.', resultSubscriptionId: null };
  }
  // Pax8 Order.createdDate is only a date, not a timestamp. Multiple matching
  // same-day orders cannot be safely disambiguated, so human reconcile leaves
  // the line unknown rather than guessing which billable write landed.
  return { lineId: line.id, submitState: 'needs_reconcile', error: 'Multiple matching same-day Pax8 orders were found.', resultSubscriptionId: null };
}

function reconcileSubscriptionLine(
  line: Pax8OrderLineRow,
  subscriptions: Pax8SubscriptionRecord[],
): SubmitLineOutcome {
  const target = subscriptions.filter((row) => row.pax8SubscriptionId === line.targetSubscriptionId);
  if (target.length > 1) {
    return { lineId: line.id, submitState: 'needs_reconcile', error: 'Pax8 returned duplicate target subscriptions.', resultSubscriptionId: null };
  }
  if (line.action === 'cancel') {
    return target.length === 0
      ? { lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: line.targetSubscriptionId }
      : { lineId: line.id, submitState: 'failed', error: 'The Pax8 subscription is still present.', resultSubscriptionId: null };
  }
  if (target.length === 1) {
    return sameQuantity(line.quantity, target[0]!.quantity)
      ? { lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: target[0]!.pax8SubscriptionId }
      : { lineId: line.id, submitState: 'failed', error: 'The Pax8 subscription quantity does not match.', resultSubscriptionId: null };
  }
  const fallback = subscriptions.filter((row) =>
    line.pax8ProductId !== null
    && row.productId === line.pax8ProductId
    && sameQuantity(line.quantity, row.quantity));
  return fallback.length === 1
    ? { lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: fallback[0]!.pax8SubscriptionId }
    : fallback.length === 0
      ? { lineId: line.id, submitState: 'failed', error: 'No matching Pax8 subscription was found.', resultSubscriptionId: null }
      : { lineId: line.id, submitState: 'needs_reconcile', error: 'Multiple matching Pax8 subscriptions were found.', resultSubscriptionId: null };
}

export function createPax8OrderSubmitService(deps: ServiceDeps) {
  return {
    async preflightOrder(input: { partnerId: string; orderId: string }) {
      const bundle = await deps.repository.loadResolvedOrder(input);
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
      const outcomes = unknown.map((line) => line.action === 'new_subscription'
        ? reconcileNewLine(bundle, line, orders)
        : reconcileSubscriptionLine(line, subscriptions));
      return deps.repository.persistReconcileResults(bundle, outcomes);
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
