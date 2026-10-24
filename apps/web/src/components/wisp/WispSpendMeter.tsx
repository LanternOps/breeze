import { useTranslation } from 'react-i18next';
import { hoursUntil, spendMeterState, type SpendMeterState } from './wispSpend';

export type WispSpendMeterProps = {
  spentCents: number;
  budgetCents: number;
  /** ISO instant the UTC budget day resets (W05 `utcDayWindow(now).end`). */
  resetsAt: string;
  /** Opens the budget control — where the exhausted-budget notice (W05) sends the user. */
  onRaise: () => void;
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

/** "42¢ of 200¢ today · resets in 6 h" (w00 A32). */
export default function WispSpendMeter({ spentCents, budgetCents, resetsAt, onRaise }: WispSpendMeterProps) {
  const { t } = useTranslation('ai');
  const state = spendMeterState(spentCents, budgetCents);
  const hours = hoursUntil(resetsAt);
  const pct = budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 100;

  return (
    <div className="space-y-1" data-testid="wisp-spend-meter" data-state={state}>
      <div className={`flex flex-wrap items-center gap-x-1 ${TEXT[state]}`}>
        <span>{t('wisp.spend.meter', { spent: spentCents, budget: budgetCents })}</span>
        {hours !== null && <span>· {t('wisp.spend.resets', { hours })}</span>}
        {state === 'exhausted' && (
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
