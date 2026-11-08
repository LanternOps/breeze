import { useTranslation } from 'react-i18next';
import { formatCurrency } from '@/lib/i18n/format';
import { atBudgetCeiling, hoursUntil, spendMeterState, type SpendMeterState } from './wispSpend';

export type WispSpendMeterProps = {
  /** `compact`: the docked pane's chip — "$0.42 / $2" and a short bar, nothing to click inside it (#critique). */
  variant?: 'full' | 'compact';
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
  warn: 'text-amber-700 dark:text-amber-400',
  exhausted: 'text-destructive',
};

const percentOf = (spentCents: number, budgetCents: number) =>
  budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 100;

/** Whole-dollar budgets drop the cents on the chip ("$10", not "$10.00"). */
const chipBudget = (budgetCents: number) =>
  formatCurrency(budgetCents / 100, 'USD', budgetCents % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {});

/**
 * What an exhausted budget offers (#10106/#10145): "Raise today's budget", or
 * at the plan's ceiling a pointer to the plans instead. Nothing while the
 * budget has room, or with no `onRaise` (raising cannot help: a
 * partner-disabled grant). Shared by the full meter and the pane's notice strip.
 */
export function WispSpendEscalation({ state, budgetCents, budgetMax = null, onRaise, className = 'ml-auto' }: {
  state: SpendMeterState;
  budgetCents: number;
  budgetMax?: number | null;
  onRaise?: () => void;
  className?: string;
}) {
  const { t } = useTranslation('ai');
  if (state !== 'exhausted' || !onRaise) return null;
  // At the plan's ceiling the budget popover cannot raise anything, so say so instead of offering it (#10106).
  if (atBudgetCeiling(budgetCents, budgetMax)) {
    return (
      <span className={`${className} flex flex-wrap items-center gap-x-1`} data-testid="wisp-spend-at-ceiling">
        <span>{t('wisp.spend.atCeiling')}</span>
        <a href="/settings/plan" data-testid="wisp-spend-plan-link" className="font-medium underline underline-offset-2">
          {t('wisp.spend.seePlans')}
        </a>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="wisp-spend-raise"
      onClick={onRaise}
      className={`${className} font-medium underline underline-offset-2`}
    >
      {t('wisp.spend.raise')}
    </button>
  );
}

/** "$0.42 of $2.00 today · resets in 6 h" (w00 A32). The API stays in cents. */
export default function WispSpendMeter({ variant = 'full', spentCents, budgetCents, resetsAt, onRaise, budgetMax = null }: WispSpendMeterProps) {
  const { t } = useTranslation('ai');
  const state = spendMeterState(spentCents, budgetCents);
  const hours = hoursUntil(resetsAt);
  const pct = percentOf(spentCents, budgetCents);

  if (variant === 'compact') {
    // Presentational: the pane wraps it in the spend popover's trigger, which carries the accessible name.
    return (
      <span className="flex items-center gap-1.5" data-testid="wisp-spend-meter-compact" data-state={state}>
        <span className={`tabular-nums ${TEXT[state]}`}>
          {formatCurrency(spentCents / 100)} / {chipBudget(budgetCents)}
        </span>
        <span className="h-1 w-8 overflow-hidden rounded bg-muted" aria-hidden="true">
          <span className={`block h-full ${BAR[state]}`} style={{ width: `${pct}%` }} />
        </span>
      </span>
    );
  }

  return (
    <div className="space-y-1" data-testid="wisp-spend-meter" data-state={state}>
      <div className={`flex flex-wrap items-center gap-x-1 ${TEXT[state]}`}>
        <span>{t('wisp.spend.meter', { spent: formatCurrency(spentCents / 100), budget: formatCurrency(budgetCents / 100) })}</span>
        {hours !== null && <span>· {t('wisp.spend.resets', { hours })}</span>}
        <WispSpendEscalation state={state} budgetCents={budgetCents} budgetMax={budgetMax} onRaise={onRaise} />
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
