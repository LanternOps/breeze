import { useTranslation } from 'react-i18next';
import { formatCurrency, formatNumber } from '@/lib/i18n/format';
import type { WispState } from '@/stores/aiStore';
import BuyCreditsLink from '../ai/BuyCreditsLink';
import { aiMonthlyAmount, type AiUsageData } from '../ai/useAiUsage';
import WispGrantPauseControl from './WispGrantPauseControl';
import { WispPopover } from './WispPopover';
import WispSpendMeter from './WispSpendMeter';

type Wisp = NonNullable<WispState>;

export type WispSpendPopoverProps = {
  wisp: Wisp;
  budgetMax: number | null;
  /** Opens the budget settings; omitted when raising cannot help (a partner-disabled grant). */
  onRaise?: () => void;
  /** Account-wide AI usage (`/ai/usage`); null until it loads or where it is unavailable. */
  usage: AiUsageData | null;
  onWispChange: (patch: Partial<Wisp>) => void;
};

const CHIP = 'flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-primary';

/**
 * The pane header's spend chip (#critique): "$0.42 / $2" and a short bar.
 * It opens the full meter with its raise, the account's AI usage (what the
 * cost indicator row used to show, a different scope from Wisp's daily
 * budget), the credits balance, and Pause / Resume.
 */
export default function WispSpendPopover({ wisp, budgetMax, onRaise, usage, onWispChange }: WispSpendPopoverProps) {
  const { t } = useTranslation('ai');
  const hasSpend = typeof wisp.spentTodayCents === 'number' && typeof wisp.budgetResetsAt === 'string';
  const spent = wisp.spentTodayCents ?? 0;
  const resetsAt = wisp.budgetResetsAt ?? '';
  const budgetText = formatCurrency(wisp.budgetCentsPerDay / 100);

  const trigger = hasSpend ? (
    <WispSpendMeter variant="compact" spentCents={spent} budgetCents={wisp.budgetCentsPerDay} resetsAt={resetsAt} />
  ) : (
    // No A32 fields on this payload: the chip still opens the usage and Pause.
    <span className="text-muted-foreground">
      {t('wisp.settings.budget')} <span className="font-medium text-foreground">{budgetText}</span>
    </span>
  );
  const triggerLabel = hasSpend
    ? t('wisp.spend.meter', { spent: formatCurrency(spent / 100), budget: budgetText })
    : `${t('wisp.settings.budget')} ${budgetText}`;

  return (
    <WispPopover
      label={t('wisp.spend.label')}
      triggerLabel={triggerLabel}
      trigger={trigger}
      triggerClassName={CHIP}
      testId="wisp-spend-chip"
      panelTestId="wisp-spend-popover"
      panelClassName="right-0 top-full mt-1 w-72 space-y-3 p-3 text-xs"
    >
      {(close) => (
        <>
          {hasSpend && (
            <WispSpendMeter
              spentCents={spent}
              budgetCents={wisp.budgetCentsPerDay}
              resetsAt={resetsAt}
              budgetMax={budgetMax}
              onRaise={onRaise ? () => { close(); onRaise(); } : undefined}
            />
          )}
          {usage && (
            <div className="space-y-1 border-t pt-2 text-muted-foreground" data-testid="wisp-spend-account">
              <p>
                {t('wisp.spend.allAiMonth', { amount: aiMonthlyAmount(usage) })}
                {' · '}
                {t('wisp.spend.allAiMessages', { count: usage.monthly.messageCount, formatted: formatNumber(usage.monthly.messageCount) })}
              </p>
              {usage.credits && (
                <p className="flex flex-wrap items-center gap-x-1">
                  <span>{t('aiCostIndicator.credits', { count: usage.credits.remaining, formatted: formatNumber(usage.credits.remaining) })}</span>
                  <BuyCreditsLink className="font-medium text-primary underline underline-offset-2 hover:opacity-80" />
                </p>
              )}
            </div>
          )}
          <div className="border-t pt-2">
            <WispGrantPauseControl wisp={wisp} onChange={onWispChange} />
          </div>
        </>
      )}
    </WispPopover>
  );
}
