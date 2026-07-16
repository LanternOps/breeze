import type { Pax8BillingTerm } from '@breeze/shared';
import type { Pax8OrderAction, Pax8OrderStatus, Pax8OrderLine } from '../../lib/api/pax8Orders';

export const PAX8_ORDER_STATUS_I18N_KEYS: Record<Pax8OrderStatus, string> = {
  draft: 'pax8.enums.orderStatus.draft',
  awaiting_details: 'pax8.enums.orderStatus.awaitingDetails',
  ready: 'pax8.enums.orderStatus.ready',
  submitting: 'pax8.enums.orderStatus.submitting',
  completed: 'pax8.enums.orderStatus.completed',
  partially_failed: 'pax8.enums.orderStatus.partiallyFailed',
  failed: 'pax8.enums.orderStatus.failed',
  cancelled: 'pax8.enums.orderStatus.cancelled',
};

export const PAX8_ORDER_ACTION_I18N_KEYS: Record<Pax8OrderAction, string> = {
  new_subscription: 'pax8.enums.lineAction.newSubscription',
  change_quantity: 'pax8.enums.lineAction.changeQuantity',
  cancel: 'pax8.enums.lineAction.cancel',
};

export const PAX8_SUBMIT_STATE_I18N_KEYS: Record<Pax8OrderLine['submitState'], string> = {
  pending: 'pax8.enums.submitState.pending',
  in_flight: 'pax8.enums.submitState.inFlight',
  succeeded: 'pax8.enums.submitState.succeeded',
  failed: 'pax8.enums.submitState.failed',
  needs_reconcile: 'pax8.enums.submitState.needsReconcile',
};

export const PAX8_BILLING_TERM_I18N_KEYS: Record<Pax8BillingTerm, string> = {
  Monthly: 'pax8.enums.billingTerm.monthly',
  Annual: 'pax8.enums.billingTerm.annual',
  '2-Year': 'pax8.enums.billingTerm.twoYear',
  '3-Year': 'pax8.enums.billingTerm.threeYear',
  'One-Time': 'pax8.enums.billingTerm.oneTime',
  Trial: 'pax8.enums.billingTerm.trial',
  Activation: 'pax8.enums.billingTerm.activation',
};

export interface PreflightErrors {
  byLine: Map<number, string[]>;
  order: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Pax8 varies detail keys; preserve readable raw messages and fail safely. */
export function extractPax8PreflightErrors(body: unknown): PreflightErrors {
  const result: PreflightErrors = { byLine: new Map(), order: [] };
  const root = record(body);
  const details = Array.isArray(root?.details) ? root.details : [];
  for (const raw of details) {
    const detail = record(raw);
    if (!detail) continue;
    const message = [detail.message, detail.detail, detail.error, detail.description]
      .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
    if (!message) continue;
    const numberValue = detail.lineItemNumber ?? detail.line_item_number;
    const lineItemNumber = typeof numberValue === 'number'
      ? numberValue
      : typeof numberValue === 'string' && /^\d+$/.test(numberValue)
        ? Number(numberValue)
        : null;
    if (lineItemNumber === null) {
      result.order.push(message);
    } else {
      const messages = result.byLine.get(lineItemNumber) ?? [];
      messages.push(message);
      result.byLine.set(lineItemNumber, messages);
    }
  }
  if (details.length === 0 && typeof root?.error === 'string' && root.error.trim()) {
    result.order.push(root.error);
  }
  return result;
}

export function displayQuantity(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
