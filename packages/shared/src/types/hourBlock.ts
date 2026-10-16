/** Index C8 (#4547): the live figures for a block line's OPEN period. Hours are
 *  exact 2-dp numbers; money is a 2-dp string (overageValue()). */
export interface HourBlockEstimate {
  lineId: string;
  periodStart: string; periodEnd: string;          // the OPEN period, half-open
  includedHours: number; carriedInHours: number;
  consumedHours: number; unapprovedHours: number;  // unapproved ⊆ consumed (Decision 4)
  foreignCurrencyHours: number;                    // Decision 8 flag
  remainingHours: number; overageHours: number;
  overageUnitPrice: string; overageValue: string;
  alertPct: number | null;
  billingTiming: 'advance' | 'arrears';            // drives the "bills next invoice" note
  lateEntryHours: number;                          // not_billed entries in already-closed periods
}
