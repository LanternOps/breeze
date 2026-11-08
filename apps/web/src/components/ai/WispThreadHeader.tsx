import type { ReactNode } from 'react';
import { RefreshCw, Power, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ActionMenuItem } from '@/components/shared/ActionMenu';
import type { WispState } from '@/stores/aiStore';
import WispGrantPauseControl from '../wisp/WispGrantPauseControl';
import WispSpendMeter from '../wisp/WispSpendMeter';
import WispGrantSettingsPanel from './WispGrantSettingsPanel';
import WispThreadHeaderCompact from './WispThreadHeaderCompact';
import { useWispGrantControls, type WispGrantControls } from './useWispGrantControls';
import type { CurrentActivity } from '@breeze/shared';

export type WispThreadHeaderProps = {
  wisp: NonNullable<WispState>;
  /** Name of the grant's org; ignored for a partner-wide grant. */
  orgName: string | null;
  wideningAvailable: boolean;
  /**
   * Thread-page mode (W06): the page owns its Wisp state, so grant patches
   * (settings, refresh, pause/resume) go here instead of the chat store.
   */
  onWispChange?: (patch: Partial<NonNullable<WispState>>) => void;
  /** Thread-page mode: called after a revoke instead of leaving chat Wisp mode. */
  onRevoked?: () => void | Promise<void>;
  /** Customer focus is a chat-session setting (spec §6.1); the thread page hides it. */
  showFocus?: boolean;
  /** The running assessment, for the live "Checking …" line (w00 A31); the panel passes none. */
  currentActivity?: CurrentActivity;
  /**
   * `full` (default): scope, status and actions over the stacked controls. `compact`: the docked
   * pane's whole header in two rows — identity plus one overflow menu, then
   * the focus and spend chips — and at most one escalation notice (#critique).
   */
  variant?: 'full' | 'compact';
  /** Compact only: the pane's own buttons left of the overflow menu (History, New). */
  paneActions?: ReactNode;
  /** Compact only: the pane's items in the overflow menu, after "Open Wisp home" (Flag). */
  paneMenuItems?: ActionMenuItem[];
  /** Compact only: the pane's Close, right of the overflow menu. */
  closeAction?: ReactNode;
  /** Compact only: poll the account's AI usage for the spend popover (the pane passes whether it is open). */
  usageEnabled?: boolean;
};

const STATUS_TONE: Record<NonNullable<WispState>['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  paused: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  revoked: 'bg-red-500/15 text-red-600 dark:text-red-400',
  expired: 'bg-muted text-muted-foreground',
};

const ICON_BUTTON = 'rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * Refresh (primary and labelled when the user's live reach has outgrown the
 * grant), operational settings and turn-off. The full header ends its scope
 * row with them; the Wisp rail ends its identity card's title row with them.
 * The caller supplies the flex container.
 */
export function WispGrantActions({ controls, wideningAvailable }: { controls: WispGrantControls; wideningAvailable: boolean }) {
  const { t } = useTranslation('ai');
  const { openRefresh, openSettings, askRevoke, settings } = controls;
  return (
    <>
      <button
        type="button"
        data-testid="wisp-refresh-grant"
        data-variant={wideningAvailable ? 'primary' : 'secondary'}
        onClick={() => openRefresh(false)}
        title={t('wisp.header.refresh')}
        className={
          wideningAvailable
            ? 'flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground'
            : ICON_BUTTON
        }
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {wideningAvailable && <span>{t('wisp.header.refresh')}</span>}
      </button>
      <button type="button" data-testid="wisp-settings" onClick={() => openSettings()} title={t('wisp.settings.title')} className={ICON_BUTTON} aria-expanded={settings.open}>
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>
      <button type="button" data-testid="wisp-revoke" onClick={askRevoke} title={t('wisp.header.revoke')} className={ICON_BUTTON}>
        <Power className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

export type WispGrantDetailsProps = {
  wisp: NonNullable<WispState>;
  wideningAvailable: boolean;
  controls: WispGrantControls;
  /** Customer focus is a chat-session setting (spec §6.1); the rail hides it. */
  showFocus?: boolean;
  /** The running assessment, for the live "Checking …" line (w00 A31). */
  currentActivity?: CurrentActivity;
};

/**
 * Everything under the full header's scope row: the widening note, the
 * refresh-keeps-terms note, the live line, the spend meter, pause / resume,
 * the focus select, the settings panel and the dialogs.
 */
export function WispGrantDetails({ wisp, wideningAvailable, controls, showFocus = true, currentActivity = null }: WispGrantDetailsProps) {
  const { t } = useTranslation('ai');
  const {
    updateWisp, focusOptions, focusPending, changeFocus, openSettings, settings,
    showRefreshHint, startNewConversation, dismissRefreshHint, dialogs,
  } = controls;

  return (
    <div className="space-y-2 text-xs" data-testid="wisp-grant-details">
      {wideningAvailable && (
        <p className="text-amber-600 dark:text-amber-400" data-testid="wisp-widening">{t('wisp.header.widening')}</p>
      )}

      {showRefreshHint && (
        <div className="flex items-start gap-2 rounded border border-primary/30 bg-primary/5 px-2 py-1.5" data-testid="wisp-refresh-hint" role="status">
          <p className="flex-1 text-foreground">{t('wisp.header.refreshKeepsTerms')}</p>
          <button
            type="button"
            data-testid="wisp-refresh-new-conversation"
            onClick={() => void startNewConversation()}
            className="shrink-0 font-medium text-primary hover:underline"
          >
            {t('wisp.header.startNewConversation')}
          </button>
          <button
            type="button"
            data-testid="wisp-refresh-hint-dismiss"
            onClick={dismissRefreshHint}
            title={t('wisp.header.dismissNote')}
            aria-label={t('wisp.header.dismissNote')}
            className={ICON_BUTTON}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {currentActivity && (
        <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="wisp-live-line" aria-live="polite">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          {currentActivity.orgName
            ? t('wisp.live.checking', { org: currentActivity.orgName })
            : t('wisp.live.checkingUnnamed')}
        </p>
      )}

      {typeof wisp.spentTodayCents === 'number' && typeof wisp.budgetResetsAt === 'string' && (
        <WispSpendMeter
          spentCents={wisp.spentTodayCents}
          budgetCents={wisp.budgetCentsPerDay}
          resetsAt={wisp.budgetResetsAt}
          budgetMax={settings.budgetMax}
          onRaise={wisp.pausedReason === 'partner_disabled' ? undefined : () => openSettings(true)}
        />
      )}

      <WispGrantPauseControl wisp={wisp} onChange={updateWisp} />

      {showFocus && <label className="flex items-center gap-2">
        <span className="shrink-0 text-muted-foreground">{t('wisp.focus.label')}</span>
        <select
          data-testid="wisp-focus"
          aria-label={t('wisp.focus.label')}
          value={wisp.focusOrgId ?? ''}
          disabled={focusPending}
          onChange={(e) => void changeFocus(e.target.value || null)}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
        >
          <option value="">{t('wisp.focus.none')}</option>
          {focusOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </label>}

      {settings.open && <WispGrantSettingsPanel settings={settings} className="space-y-2 rounded border p-2" />}

      {dialogs}
    </div>
  );
}

/**
 * The Wisp thread's header (W04 Task 8, spec §4.4/§6.1/§9): scope, customer
 * focus, grant status, refresh (primary when the user's live reach has
 * outgrown the grant), operational settings, and turn-off. The docked pane
 * renders it compact; the Wisp rail lays out its parts (WispGrantActions,
 * WispGrantDetails) in its identity card instead.
 */
export default function WispThreadHeader(props: WispThreadHeaderProps) {
  const {
    wisp,
    orgName,
    wideningAvailable,
    onWispChange,
    onRevoked,
    showFocus = true,
    currentActivity = null,
    variant = 'full',
  } = props;
  const { t } = useTranslation('ai');
  const controls = useWispGrantControls({ wisp, orgName, onWispChange, onRevoked });

  if (variant === 'compact') {
    return (
      <WispThreadHeaderCompact
        wisp={wisp}
        wideningAvailable={wideningAvailable}
        showFocus={showFocus}
        controls={controls}
        paneActions={props.paneActions}
        paneMenuItems={props.paneMenuItems}
        closeAction={props.closeAction}
        usageEnabled={props.usageEnabled}
      />
    );
  }

  const { budgetReached, scopeLabel } = controls;

  return (
    <div className="space-y-2 border-b px-4 py-2 text-xs" data-testid="wisp-thread-header">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-foreground" data-testid="wisp-scope">{scopeLabel}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[budgetReached ? 'paused' : wisp.status]}`} data-testid="wisp-grant-status">
          {t(/* i18n-dynamic */ `wisp.header.status.${budgetReached ? 'budgetReached' : wisp.status}`)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <WispGrantActions controls={controls} wideningAvailable={wideningAvailable} />
        </div>
      </div>
      <WispGrantDetails wisp={wisp} wideningAvailable={wideningAvailable} controls={controls} showFocus={showFocus} currentActivity={currentActivity} />
    </div>
  );
}
