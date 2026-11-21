import type { RiskTier } from './approvalGrouping';

/** Risk-tier badge colours, shared by the approval card and the cross-org
 *  review list so a tier never reads differently in the two places. */
export const riskClass: Record<RiskTier, string> = {
  low: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200',
};
