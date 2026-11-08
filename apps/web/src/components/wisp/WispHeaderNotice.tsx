import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WispState } from '@/stores/aiStore';
import BuyCreditsLink from '../ai/BuyCreditsLink';
import WispGrantPauseControl from './WispGrantPauseControl';
import { WispSpendEscalation } from './WispSpendMeter';
import { hoursUntil, spendMeterState, systemPauseKind } from './wispSpend';

type Wisp = NonNullable<WispState>;

export type WispHeaderNoticeKind = 'systemPaused' | 'userPaused' | 'budget' | 'widening' | 'refreshHint' | 'credits';

export type WispHeaderNoticeConditions = {
  wisp: Wisp;
  wideningAvailable: boolean;
  /** #10142: a refresh happened while this conversation was open under the grant. */
  showRefreshHint: boolean;
  creditsExhausted: boolean;
};

/** The day's budget is spent on a live grant (the meter's own rule: both A32 fields present). */
export function wispBudgetExhausted(wisp: Wisp): boolean {
  return wisp.status === 'active'
    && typeof wisp.spentTodayCents === 'number'
    && typeof wisp.budgetResetsAt === 'string'
    && spendMeterState(wisp.spentTodayCents, wisp.budgetCentsPerDay) === 'exhausted';
}

/**
 * The one notice the docked pane's header shows, by priority: a partner or
 * system pause (its reason), a user pause (Resume), an exhausted budget
 * (Raise / See plans), reach the grant no longer covers (Refresh grant), the
 * refresh-keeps-terms note, then spent credits. Null when nothing needs saying.
 */
export function pickWispHeaderNotice({ wisp, wideningAvailable, showRefreshHint, creditsExhausted }: WispHeaderNoticeConditions): WispHeaderNoticeKind | null {
  if (wisp.status === 'paused') {
    const system = wisp.pausedReason === 'partner_disabled' || systemPauseKind(wisp.status, wisp.pausedReason) !== null;
    return system ? 'systemPaused' : 'userPaused';
  }
  if (wispBudgetExhausted(wisp)) return 'budget';
  if (wideningAvailable) return 'widening';
  if (showRefreshHint) return 'refreshHint';
  if (creditsExhausted) return 'credits';
  return null;
}

const TONE: Record<WispHeaderNoticeKind, string> = {
  systemPaused: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  userPaused: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  budget: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  credits: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  widening: 'bg-primary/5 text-foreground',
  refreshHint: 'bg-primary/5 text-foreground',
};

export type WispHeaderNoticeProps = WispHeaderNoticeConditions & {
  budgetMax: number | null;
  /** Opens the budget settings; omitted when raising cannot help (a partner-disabled grant). */
  onRaise?: () => void;
  onRefresh: () => void;
  onStartNewConversation: () => void;
  onDismissRefreshHint: () => void;
  onWispChange: (patch: Partial<Wisp>) => void;
};

/**
 * The escalation strip under the pane header (#critique): at most one notice,
 * so a paused grant is visible without opening anything and nothing stacks.
 * The copy and conditions are the ones the full header, the pause control and
 * the spend meter already use; only the layout is new.
 */
export default function WispHeaderNotice(props: WispHeaderNoticeProps) {
  const { t } = useTranslation('ai');
  const kind = pickWispHeaderNotice(props);
  if (kind === null) return null;
  const { wisp } = props;

  const body = (() => {
    switch (kind) {
      case 'systemPaused':
      case 'userPaused':
        // The pause control names the reason and offers Resume only for a user pause (#10106/#10145).
        return <WispGrantPauseControl wisp={wisp} onChange={props.onWispChange} />;
      case 'budget': {
        const hours = typeof wisp.budgetResetsAt === 'string' ? hoursUntil(wisp.budgetResetsAt) : null;
        return (
          <div className="flex flex-1 flex-wrap items-center gap-x-1">
            <span className="font-medium">{t('wisp.header.status.budgetReached')}</span>
            {hours !== null && <span>· {t('wisp.spend.resets', { hours })}</span>}
            <WispSpendEscalation
              state="exhausted"
              budgetCents={wisp.budgetCentsPerDay}
              budgetMax={props.budgetMax}
              onRaise={props.onRaise}
            />
          </div>
        );
      }
      case 'widening':
        return (
          <>
            <p className="flex-1" data-testid="wisp-widening">{t('wisp.header.widening')}</p>
            <button
              type="button"
              data-testid="wisp-widening-refresh"
              onClick={props.onRefresh}
              className="shrink-0 rounded bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('wisp.header.refresh')}
            </button>
          </>
        );
      case 'refreshHint':
        return (
          <div className="flex flex-1 items-start gap-2" data-testid="wisp-refresh-hint">
            <p className="flex-1">{t('wisp.header.refreshKeepsTerms')}</p>
            <button
              type="button"
              data-testid="wisp-refresh-new-conversation"
              onClick={props.onStartNewConversation}
              className="shrink-0 font-medium text-primary hover:underline"
            >
              {t('wisp.header.startNewConversation')}
            </button>
            <button
              type="button"
              data-testid="wisp-refresh-hint-dismiss"
              onClick={props.onDismissRefreshHint}
              title={t('wisp.header.dismissNote')}
              aria-label={t('wisp.header.dismissNote')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      case 'credits':
        return (
          <>
            <p className="flex-1">{t('wisp.notice.creditsExhausted')}</p>
            <BuyCreditsLink className="shrink-0 font-medium underline underline-offset-2" />
          </>
        );
    }
  })();

  return (
    <div
      className={`flex items-center gap-2 border-t px-4 py-1.5 text-xs ${TONE[kind]}`}
      data-testid="wisp-header-notice"
      data-kind={kind}
      role="status"
    >
      {body}
    </div>
  );
}
