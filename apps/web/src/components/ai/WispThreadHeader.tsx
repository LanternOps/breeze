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

export type WispThreadHeaderProps = {
  wisp: NonNullable<WispState>;
  /** Name of the grant's org; ignored for a partner-wide grant. */
  orgName: string | null;
  wideningAvailable: boolean;
  /** The pane's own buttons left of the overflow menu (History, New). */
  paneActions?: ReactNode;
  /** The pane's items in the overflow menu, after "Open Wisp home" (Flag). */
  paneMenuItems?: ActionMenuItem[];
  /** The pane's Close, right of the overflow menu. */
  closeAction?: ReactNode;
  /** Poll the account's AI usage for the spend popover (the pane passes whether it is open). */
  usageEnabled?: boolean;
};

const ICON_BUTTON = 'rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * Refresh (primary and labelled when the user's live reach has outgrown the
 * grant), operational settings and turn-off. The Wisp rail ends its identity
 * card's title row with them; the caller supplies the flex container.
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
};

/**
 * Everything under the rail identity card's title row: the widening note, the
 * refresh-keeps-terms note, the spend meter, pause / resume, the settings
 * panel and the dialogs. The card states scope, status and the live line;
 * customer focus is a chat-session setting (spec §6.1), so only the pane's
 * header offers it.
 */
export function WispGrantDetails({ wisp, wideningAvailable, controls }: WispGrantDetailsProps) {
  const { t } = useTranslation('ai');
  const {
    updateWisp, openSettings, settings, showRefreshHint, startNewConversation, dismissRefreshHint, dialogs,
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

      {settings.open && <WispGrantSettingsPanel settings={settings} className="space-y-2 rounded border p-2" />}

      {dialogs}
    </div>
  );
}

/**
 * The docked pane's Wisp header (W04 Task 8, spec §4.4/§6.1/§9; #critique):
 * the grant controls' state laid out in two rows by WispThreadHeaderCompact.
 * The Wisp rail lays out the same controls in its identity card instead, with
 * WispGrantActions and WispGrantDetails.
 */
export default function WispThreadHeader({ wisp, orgName, wideningAvailable, ...pane }: WispThreadHeaderProps) {
  const controls = useWispGrantControls({ wisp, orgName });
  return <WispThreadHeaderCompact wisp={wisp} wideningAvailable={wideningAvailable} controls={controls} {...pane} />;
}
