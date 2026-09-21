import '../../lib/i18n';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../billing/shared/format';

/** Read-only fields returned by ticket defaults and time-entry projections. */
export interface BillingOutcomeStamp {
  coverage?: 'billable' | 'included' | 'non_billable' | null;
  hourlyRate?: string | null;
  currencyCode?: string | null;
  minimumMinutes?: number | null;
  isBillable: boolean;
}

export default function BillingOutcome({ stamp, overrides, pending = false, testId }: {
  stamp?: BillingOutcomeStamp | null;
  overrides?: Partial<Pick<BillingOutcomeStamp, 'hourlyRate' | 'isBillable'>>;
  pending?: boolean;
  testId: string;
}) {
  const { t } = useTranslation('tickets');
  // Preview only explicit edits. Untouched inputs continue to use the server
  // stamp; a changed work type may need server resolution, handled by pending.
  if (stamp && overrides) {
    const rateChanged = overrides.hourlyRate !== undefined && overrides.hourlyRate !== null
      && (stamp.hourlyRate == null || Number(overrides.hourlyRate) !== Number(stamp.hourlyRate));
    const coverage = stamp.coverage === 'included' && rateChanged ? 'billable'
      : stamp.coverage === 'non_billable' && overrides.isBillable === true ? 'billable' : stamp.coverage;
    stamp = { ...stamp, ...overrides, coverage };
  }
  let text: string;
  if (pending) text = t('billingOutcome.recalculated');
  else if (!stamp) text = t('billingOutcome.unavailable');
  else if (!stamp.isBillable || stamp.coverage === 'non_billable') text = t('billingOutcome.nonBillable');
  else if (stamp.coverage === 'included') text = t('billingOutcome.included');
  else if (stamp.hourlyRate != null && stamp.currencyCode) {
    text = t('billingOutcome.hourly', { rate: formatMoney(stamp.hourlyRate, stamp.currencyCode) });
    if (stamp.minimumMinutes) text += ` · ${t('billingOutcome.minimum', { minutes: stamp.minimumMinutes })}`;
  } else text = t('billingOutcome.missingRate');
  return <p className="text-xs text-muted-foreground" data-testid={testId} aria-live="polite">{text}</p>;
}
