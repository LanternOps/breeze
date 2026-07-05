import { KEV_EXPLANATION } from './vulnExplanations';

/**
 * CISA Known Exploited Vulnerability marker. One shared component so the
 * badge can't drift between the group table, the drawers, and the CVE
 * metadata (it previously existed as three slightly different copies).
 *
 * Deliberately a native `title` (not HelpTooltip): the badge repeats on every
 * row, and a focusable trigger per row would litter the keyboard tab order.
 * The KEV column header carries the accessible HelpTooltip with the same
 * phrasing (vulnExplanations.ts keeps them identical).
 */
export function KevBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
      title={KEV_EXPLANATION}
    >
      KEV
    </span>
  );
}

export default KevBadge;
