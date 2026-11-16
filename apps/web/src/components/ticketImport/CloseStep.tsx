import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/dateTimeFormat';
import type { ImportSource, MigrationWindow } from './ticketImportApi';
import { CloseWindowButton, WindowSummaryTable, closedReasonLabel } from './MigrationWindows';
import { Notice, Panel, buttonSecondary } from './importUi';

/**
 * Step 8, Close the window (#8313 W6; spec 2026-10-19 §5.11 step 8, §7 steps
 * 10 and 11): close this source's window once mail points at Breeze, and
 * read its summary — each org then gets its `migration.window_closed` event.
 * After it, the runbook revokes the source (or keeps it for a later
 * re-import) and the source token.
 */
type Props = {
  source: ImportSource;
  /** This source's newest window (open or closed). */
  latestWindow: MigrationWindow | null;
  runActive: boolean;
  nameOfOrg: (orgId: string) => string;
  onClosed: () => void;
  onManageSource: () => void;
};

export default function CloseStep({ source, latestWindow, runActive, nameOfOrg, onClosed, onManageSource }: Props) {
  const { t } = useTranslation('ticketImport');

  return (
    <Panel title={t('close.title')} testId="ticket-import-close">
      <p className="mb-4 text-sm text-muted-foreground">{t('close.intro')}</p>
      {!latestWindow && <Notice testId="ticket-import-close-no-window">{t('close.noWindow')}</Notice>}
      {latestWindow?.status === 'open' && (
        <div className="space-y-3">
          {runActive && <Notice tone="warning" testId="ticket-import-close-run-active">{t('close.runActive')}</Notice>}
          <p className="text-sm">{t('close.liveCounts', { ends: formatDateTime(latestWindow.endsAt) })}</p>
          <WindowSummaryTable win={latestWindow} nameOfOrg={nameOfOrg} />
          <CloseWindowButton win={latestWindow} onClosed={onClosed} label={t('close.closeNow')} />
        </div>
      )}
      {latestWindow?.status === 'closed' && (
        <div className="space-y-3" data-testid="ticket-import-close-summary">
          <Notice tone="success">
            {t('close.closedOn', { closed: formatDateTime(latestWindow.closedAt), reason: closedReasonLabel(t, latestWindow) })}
          </Notice>
          <WindowSummaryTable win={latestWindow} nameOfOrg={nameOfOrg} />
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('close.afterTitle')}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              <li>{source.hasCredentials ? t('close.afterRevokeSource') : t('close.afterSourceRevoked')}</li>
              <li>{t('close.afterRevokeToken')}</li>
              <li>{t('close.afterGroups')}</li>
            </ul>
            {source.hasCredentials && (
              <button type="button" className={`${buttonSecondary} mt-3`} onClick={onManageSource} data-testid="ticket-import-close-manage-source">
                {t('close.manageSource')}
              </button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
