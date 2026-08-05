import { toCents } from './quoteMath';

export type QuoteLineFulfillmentStatus = 'not_ordered' | 'ordered' | 'partially_received' | 'received';

export interface FulfillmentAllocationLike {
  orderedQty: string | number;
  receivedQty: string | number | null;
  cancelledAt: string | Date | null;
}

/** Derived, never persisted: absence of an active allocation IS "not ordered". */
export function deriveLineFulfillment(allocations: FulfillmentAllocationLike[]): QuoteLineFulfillmentStatus {
  const active = allocations.filter((x) => !x.cancelledAt);
  if (active.length === 0) return 'not_ordered';
  const ordered = active.reduce((s, x) => s + toCents(x.orderedQty), 0);
  const received = active.reduce((s, x) => s + toCents(x.receivedQty ?? 0), 0);
  if (received <= 0) return 'ordered';
  return received < ordered ? 'partially_received' : 'received';
}
