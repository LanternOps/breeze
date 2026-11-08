import type { ReactNode } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionMenu, type ActionMenuItem } from '@/components/shared/ActionMenu';
import { useAiStore, type WispState } from '@/stores/aiStore';
import WispHeaderNotice from '../wisp/WispHeaderNotice';
import { WispPopoverPanel } from '../wisp/WispPopover';
import WispSpendPopover from '../wisp/WispSpendPopover';
import WispGrantSettingsPanel from './WispGrantSettingsPanel';
import { aiCreditsExhausted, useAiUsage } from './useAiUsage';
import type { WispGrantControls } from './useWispGrantControls';

type Wisp = NonNullable<WispState>;

type StatusKey = Wisp['status'] | 'budgetReached';

/** Active is the brand's green; paused or over budget amber; ended or partner-disabled gray. */
const DOT: Record<'active' | 'paused' | 'off', string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  off: 'bg-muted-foreground',
};
const STATUS_TEXT: Record<'active' | 'paused' | 'off', string> = {
  active: 'text-emerald-700 dark:text-emerald-400',
  paused: 'text-amber-700 dark:text-amber-400',
  off: 'text-muted-foreground',
};

function statusTone(wisp: Wisp, key: StatusKey): 'active' | 'paused' | 'off' {
  if (key === 'active') return 'active';
  if (key === 'revoked' || key === 'expired' || wisp.pausedReason === 'partner_disabled') return 'off';
  return 'paused';
}

const ICON_BUTTON = 'rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

export type WispThreadHeaderCompactProps = {
  wisp: Wisp;
  wideningAvailable: boolean;
  showFocus: boolean;
  controls: WispGrantControls;
  paneActions?: ReactNode;
  paneMenuItems?: ActionMenuItem[];
  closeAction?: ReactNode;
  usageEnabled?: boolean;
};

/**
 * The docked pane's Wisp header (#critique), two rows instead of seven:
 *   A  ✦ Wisp ● scope                  [pane actions] [⋯] [close]
 *   B  [Working on: focus ▾]                         [$spent / $budget ▬]
 * then at most one escalation notice. Settings open as an overlay, never
 * inline, so the conversation does not move.
 */
export default function WispThreadHeaderCompact({
  wisp,
  wideningAvailable,
  showFocus,
  controls,
  paneActions,
  paneMenuItems = [],
  closeAction,
  usageEnabled = true,
}: WispThreadHeaderCompactProps) {
  const { t } = useTranslation('ai');
  const isStreaming = useAiStore((s) => s.isStreaming);
  const errorCode = useAiStore((s) => s.errorCode);
  // Account-wide AI usage (the cost indicator row's numbers) for the spend popover and the credits notice.
  const usage = useAiUsage({ enabled: usageEnabled, isStreaming });
  const {
    updateWisp, focusOptions, focusPending, changeFocus, openRefresh, askRevoke, openSettings, closeSettings, settings,
    showRefreshHint, startNewConversation, dismissRefreshHint, budgetReached, scopeLabel, dialogs,
  } = controls;

  const statusKey: StatusKey = budgetReached ? 'budgetReached' : wisp.status;
  const tone = statusTone(wisp, statusKey);
  const statusText = t(/* i18n-dynamic */ `wisp.header.status.${statusKey}`);
  const onRaise = wisp.pausedReason === 'partner_disabled' ? undefined : () => openSettings(true);

  const menuItems: ActionMenuItem[] = [
    { id: 'wisp-home', label: t('wisp.header.menu.openHome'), href: '/wisp', testId: 'wisp-sidebar-open-home' },
    ...paneMenuItems,
    { id: 'wisp-settings', label: t('wisp.header.menu.settings'), onSelect: () => openSettings(true), testId: 'wisp-settings' },
    { id: 'wisp-refresh', label: t('wisp.header.menu.refresh'), onSelect: () => openRefresh(false), testId: 'wisp-refresh-grant' },
    { id: 'wisp-revoke', label: t('wisp.header.menu.revoke'), onSelect: askRevoke, tone: 'destructive', separatorBefore: true, testId: 'wisp-revoke' },
  ];

  return (
    <div className="relative border-b" data-testid="wisp-thread-header" data-variant="compact">
      {/* Row A: identity and actions */}
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="shrink-0 text-sm font-semibold text-foreground">{t('wisp.title')}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              role="img"
              aria-label={statusText}
              title={statusText}
              data-testid="wisp-grant-status"
              data-status={statusKey}
              className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`}
            />
            {statusKey !== 'active' && (
              <span className={`shrink-0 font-medium ${STATUS_TEXT[tone]}`} data-testid="wisp-grant-status-text">{statusText}</span>
            )}
            <span className="truncate" data-testid="wisp-scope">{scopeLabel}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {paneActions}
          <ActionMenu label={t('wisp.header.menu.label')} testId="wisp-header-menu" triggerClassName={ICON_BUTTON} items={menuItems} />
          {closeAction}
        </div>
      </div>

      {/* Row B: what Wisp is working on, and what it has spent */}
      <div className="flex items-center justify-between gap-2 px-4 pb-2 text-xs">
        {showFocus ? (
          <label className="flex h-6 min-w-0 items-center gap-1 rounded-full border px-2 hover:bg-muted focus-within:ring-1 focus-within:ring-primary">
            <span className="shrink-0 text-muted-foreground">{t('wisp.focus.label')}</span>
            <select
              data-testid="wisp-focus"
              aria-label={t('wisp.focus.label')}
              value={wisp.focusOrgId ?? ''}
              disabled={focusPending}
              onChange={(e) => void changeFocus(e.target.value || null)}
              className="min-w-0 max-w-[11rem] cursor-pointer appearance-none truncate bg-transparent font-medium text-foreground focus:outline-hidden disabled:cursor-wait disabled:opacity-50"
            >
              <option value="">{t('wisp.focus.none')}</option>
              {focusOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </label>
        ) : <span />}
        <WispSpendPopover
          wisp={wisp}
          budgetMax={settings.budgetMax}
          onRaise={onRaise}
          usage={usage}
          onWispChange={updateWisp}
        />
      </div>

      <WispHeaderNotice
        wisp={wisp}
        wideningAvailable={wideningAvailable}
        showRefreshHint={showRefreshHint}
        // The error banner already offers Buy credits after a refused send; say it once.
        creditsExhausted={aiCreditsExhausted(usage) && errorCode !== 'credits_exhausted'}
        budgetMax={settings.budgetMax}
        onRaise={onRaise}
        onRefresh={() => openRefresh(false)}
        onStartNewConversation={() => void startNewConversation()}
        onDismissRefreshHint={dismissRefreshHint}
        onWispChange={updateWisp}
      />

      <WispPopoverPanel
        open={settings.open}
        onClose={closeSettings}
        label={t('wisp.settings.title')}
        className="absolute inset-x-2 top-full mt-1 max-h-[70vh] overflow-y-auto p-3 text-xs"
      >
        <WispGrantSettingsPanel settings={settings} className="space-y-2" />
      </WispPopoverPanel>

      {dialogs}
    </div>
  );
}
