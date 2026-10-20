/**
 * #9303 — an org's OTHER contracts, shown on a contract's page so a second
 * contract for the same services (e.g. a draft auto-created by a quote accept
 * next to a hand-built one) is visible before both are activated and the
 * customer is billed twice.
 *
 * Warn-and-confirm only. Several active contracts per org are legitimate
 * (per-site, per-service), so nothing here blocks a transition server-side.
 */

/** Statuses that bill now or can be turned on to bill. Cancelled/expired
 *  contracts are history, not a double-billing risk. */
export const RELATED_CONTRACT_STATUSES = ['draft', 'active', 'paused'] as const;
export type RelatedContractStatus = typeof RELATED_CONTRACT_STATUSES[number];

/** One sibling contract in the same org, as returned on the contract detail
 *  read (`GET /contracts/:id` → `data.relatedContracts`). */
export interface RelatedContract {
  id: string;
  name: string;
  status: RelatedContractStatus;
  intervalMonths: number;
  currencyCode: string;
  /** Estimated value per billing period (same estimate the contracts list
   *  shows), as a decimal string. Null when it cannot be computed (a device
   *  group that fails to evaluate, a deleted group) or is withheld for a
   *  site-restricted reader. */
  recurringTotal: string | null;
  /** Active service deliverables attached to the contract. */
  deliverableCount: number;
  /** Executed agreement snapshots linked to the contract. */
  signedAgreementCount: number;
  /** Same billing cadence AND overlapping date ranges as the contract being
   *  viewed — activating both bills the customer for both. */
  overlapsCadence: boolean;
}

/** The fields the cadence-overlap rule reads. Dates are ISO `YYYY-MM-DD`;
 *  a null end date is open-ended. */
export interface CadenceWindow {
  intervalMonths: number;
  startDate: string;
  endDate: string | null;
}

/**
 * True when both contracts bill on the same cadence over at least one shared
 * day. Inclusive on both ends: a contract ending on the day another starts
 * still bills that day. ISO date strings compare correctly as strings.
 */
export function contractsOverlapCadence(a: CadenceWindow, b: CadenceWindow): boolean {
  if (a.intervalMonths !== b.intervalMonths) return false;
  const aEndsBeforeB = a.endDate !== null && a.endDate < b.startDate;
  const bEndsBeforeA = b.endDate !== null && b.endDate < a.startDate;
  return !aEndsBeforeB && !bEndsBeforeA;
}
