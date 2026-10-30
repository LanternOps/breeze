import { useTranslation } from 'react-i18next';
import { formatCurrency } from '@/lib/i18n/format';
import { atBudgetCeiling, hoursUntil, spendMeterState, type SpendMeterState } from './wispSpend';

export type WispSpendMeterProps = {
  spentCents: number;
  budgetCents: number;
  /** ISO instant the UTC budget day resets (W05 `utcDayWindow(now).end`). */
  resetsAt: string;
  /** Opens the budget control — where the exhausted-budget notice (W05) sends the user. Omitted when raising the budget cannot help (a partner-disabled grant). */
  onRaise?: () => void;
  /** The plan's daily-budget ceiling in cents (entitlement `budgetCentsPerDayCeiling`); null/omitted when unknown. */
  budgetMax?: number | null;
};

const BAR: Record<SpendMeterState, string> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  exhausted: 'bg-destructive',
};

const TEXT: Record<SpendMeterState, string> = {
  ok: 'text-muted-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  exhausted: 'text-destructive',
};

/** "$0.42 of $2.00 today · resets in 6 h" (w00 A32). The API stays in cents. */
export default function WispSpendMeter({ spentCents, budgetCents, resetsAt, onRaise, budgetMax = null }: WispSpendMeterProps) {
  const { t } = useTranslation('ai');
  const state = spendMeterState(spentCents, budgetCents);
  // At the plan's ceiling the budget popover cannot raise anything, so say so instead of offering it (#10106).
  // Only where a raise would otherwise be offered: with no onRaise, raising is moot for another reason.
  const atCeiling = state === 'exhausted' && onRaise !== undefined && atBudgetCeiling(budgetCents, budgetMax);
  const hours = hoursUntil(resetsAt);
  const pct = budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 100;

  return (
    <div className="space-y-1" data-testid="wisp-spend-meter" data-state={state}>
      <div className={`flex flex-wrap items-center gap-x-1 ${TEXT[state]}`}>
        <span>{t('wisp.spend.meter', { spent: formatCurrency(spentCents / 100), budget: formatCurrency(budgetCents / 100) })}</span>
        {hours !== null && <span>· {t('wisp.spend.resets', { hours })}</span>}
        {atCeiling && (
          <span className="ml-auto flex flex-wrap items-center gap-x-1" data-testid="wisp-spend-at-ceiling">
            <span>{t('wisp.spend.atCeiling')}</span>
            <a href="/settings/plan" data-testid="wisp-spend-plan-link" className="font-medium underline underline-offset-2">
              {t('wisp.spend.seePlans')}
            </a>
          </span>
        )}
        {state === 'exhausted' && !atCeiling && onRaise && (
          <button
            type="button"
            data-testid="wisp-spend-raise"
            onClick={onRaise}
            className="ml-auto font-medium underline underline-offset-2"
          >
            {t('wisp.spend.raise')}
          </button>
        )}
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={budgetCents}
        aria-valuenow={Math.min(spentCents, budgetCents)}
        aria-label={t('wisp.spend.label')}
      >
        <div className={`h-full ${BAR[state]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
