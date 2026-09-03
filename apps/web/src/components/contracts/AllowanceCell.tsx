import { useTranslation } from 'react-i18next';
import type { ContractEstimateLine, ContractLine, OverageSummary } from '../../lib/api/contracts';
import { AUTO_QTY_TYPES } from './lineTypes';

/**
 * #3205 W04 (#4607): the quantity cell body for both contract tables. Five
 * states, so the operator can always tell an allowance from a raw count:
 *   no allowance          -> exactly as before (live count, manual qty, or 1)
 *   allowance, no estimate-> "25 included" from the row alone (never blank)
 *   within the allowance  -> "18 of 25 included"
 *   over, bill            -> "25 included · 3 over (billed)"
 *   over, flag            -> the same, amber, "(flagged)"
 */
export default function AllowanceCell(
  { line, estimate }: { line: ContractLine; estimate?: ContractEstimateLine },
) {
  const { t } = useTranslation('billing');
  // W02: a group line whose group was deleted has no resolvable quantity at all.
  if (estimate?.unresolved === 'group_deleted') return <>{t('contracts.shared.values.groupDeleted')}</>;

  const base = AUTO_QTY_TYPES.has(line.lineType)
    ? (estimate ? String(estimate.quantity) : <span className="text-muted-foreground">{t('contracts.shared.values.auto')}</span>)
    : (line.lineType === 'manual' ? (line.manualQuantity ?? '0') : '1');

  if (line.includedQuantity == null) return <>{base}</>;
  const included = Number(line.includedQuantity);

  if (!estimate) {
    return <span data-testid="allowance-included-only">{t('contracts.shared.allowance.includedOnly', { included })}</span>;
  }
  if (estimate.overage <= 0) {
    return (
      <span data-testid="allowance-within">
        {t('contracts.shared.allowance.includedOf', { counted: estimate.counted, included })}
      </span>
    );
  }
  const flagged = estimate.overageMode === 'flag';
  return (
    <span
      data-testid={flagged ? 'allowance-over-flagged' : 'allowance-over-billed'}
      className={flagged ? 'text-amber-600 dark:text-amber-500' : undefined}
    >
      {t(/* i18n-dynamic */ flagged ? 'contracts.shared.allowance.overFlagged' : 'contracts.shared.allowance.overBilled',
        { included, overage: estimate.overage })}
    </span>
  );
}

/**
 * The contract-level digest, rendered directly under <DeviceCoverageNotice /> in
 * both estimate panels. Flagged entries are amber (money left on the table that
 * only a human can act on); billed entries are muted (already on the invoice).
 */
export function OverageNotice({ overages }: { overages: OverageSummary[] | undefined }) {
  const { t } = useTranslation('billing');
  if (!overages || overages.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {overages.map((o) => (
        <p
          key={o.contractLineId}
          data-testid={o.mode === 'flag' ? 'contract-overage-flagged' : 'contract-overage-billed'}
          className={o.mode === 'flag'
            ? 'rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
            : 'text-xs text-muted-foreground'}
        >
          {t(/* i18n-dynamic */ o.mode === 'flag' ? 'contracts.shared.overage.flagged' : 'contracts.shared.overage.billed',
            { description: o.description, included: o.included, overage: o.overage })}
        </p>
      ))}
    </div>
  );
}
