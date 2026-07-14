// Pax8 order vocabularies. Append-only — order is load-bearing for any UI that
// renders these in sequence, and DB CHECK constraints mirror these lists.

export const PAX8_ORDER_ACTIONS = ['new_subscription', 'change_quantity', 'cancel'] as const;
export type Pax8OrderAction = (typeof PAX8_ORDER_ACTIONS)[number];

export const PAX8_ORDER_STATUSES = [
  'draft',
  'awaiting_details',
  'ready',
  'submitting',
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
] as const;
export type Pax8OrderStatus = (typeof PAX8_ORDER_STATUSES)[number];

export const PAX8_SUBMIT_STATES = [
  'pending',
  'in_flight',
  'succeeded',
  'failed',
  'needs_reconcile',
] as const;
export type Pax8SubmitState = (typeof PAX8_SUBMIT_STATES)[number];

// Verbatim from Pax8's CreateLineItem.billingTerm enum. These strings are sent
// on the wire exactly as written — do not lowercase or reformat them.
export const PAX8_BILLING_TERMS = ['Monthly', 'Annual', '2-Year', '3-Year', 'One-Time', 'Trial', 'Activation'] as const;
export type Pax8BillingTerm = (typeof PAX8_BILLING_TERMS)[number];

export const PAX8_ORDER_SOURCES = ['direct', 'quote'] as const;
export type Pax8OrderSource = (typeof PAX8_ORDER_SOURCES)[number];
