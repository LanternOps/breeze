import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatDateTime } from '../../lib/dateTimeFormat';
import { PARTNER_WIDE, type MigrationWindow } from './ticketImportApi';
import { Notice, Panel, buttonDanger, buttonSecondary, formatCount, importFriendly } from './importUi';

/**
 * Migration windows on the import page (#8313 W6; spec 2026-10-19 §5.11;
 * windows spec 2026-10-10 §3.3, §3.5): every window of the partner with its
 * counts (live while open, the frozen summary once closed), and the close
 * action, which any partner-wide admin may take (it narrows). The close step
 * (step 8) reuses the summary table and the close button.
 */

export function WindowSummaryTable({ win, nameOfOrg }: { win: MigrationWindow; nameOfOrg: (orgId: string) => string }) {
  const { t } = useTranslation('ticketImport');
  return (
    <table className="w-full text-sm" data-testid={`ticket-import-window-summary-${win.id}`}>
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-medium">{t('windows.org')}</th>
          <th className="py-1 pr-2 text-right font-medium">{t('windows.tickets')}</th>
          <th className="py-1 pr-2 text-right font-medium">{t('windows.comments')}</th>
          <th className="py-1 text-right font-medium">{t('windows.attachments')}</th>
        </tr>
      </thead>
      <tbody>
        {win.counts.orgs.map((o) => (
          <tr key={o.orgId} className="border-t">
            <td className="py-1 pr-2">{nameOfOrg(o.orgId)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCount(o.ticketsImported)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCount(o.commentsImported)}</td>
            <td className="py-1 text-right tabular-nums">{formatCount(o.attachmentsImported)}</td>
          </tr>
        ))}
        <tr className="border-t font-medium">
          <td className="py-1 pr-2">{t('windows.total')}</td>
          <td className="py-1 pr-2 text-right tabular-nums" data-testid={`ticket-import-window-total-tickets-${win.id}`}>{formatCount(win.counts.ticketsImported)}</td>
          <td className="py-1 pr-2 text-right tabular-nums">{formatCount(win.counts.commentsImported)}</td>
          <td className="py-1 text-right tabular-nums">{formatCount(win.counts.attachmentsImported)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function CloseWindowButton({ win, onClosed, label }: { win: MigrationWindow; onClosed: () => void; label?: string }) {
  const { t } = useTranslation('ticketImport');
  const [confirm, setConfirm] = useState(false);
  const [closing, setClosing] = useState(false);

  const close = async () => {
    setClosing(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/migration-windows/${win.id}/close`, { ...PARTNER_WIDE, method: 'POST' }),
        errorFallback: t('windows.closeFailed'),
        friendly: importFriendly(t),
        successMessage: t('windows.closed'),
      });
      onClosed();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('windows.closeFailed') });
    } finally {
      setClosing(false);
      setConfirm(false);
    }
  };

  return (
    <>
      <button type="button" className={buttonDanger} onClick={() => setConfirm(true)} disabled={closing}
        data-testid={`ticket-import-window-close-${win.id}`}>{label ?? t('windows.close')}</button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void close()}
        title={t('windows.closeTitle', { label: win.sourceLabel })}
        message={t('windows.closeMessage')}
        confirmLabel={t('windows.close')}
        variant="warning"
        isLoading={closing}
        confirmTestId="ticket-import-window-close-confirm"
      />
    </>
  );
}

export function closedReasonLabel(t: ReturnType<typeof useTranslation>['t'], win: MigrationWindow): string {
  return win.closedReason ? t(/* i18n-dynamic */ `windows.reason.${win.closedReason}`) : '';
}

export default function MigrationWindowList({ windows, loadFailed, nameOfOrg, onChanged }: {
  windows: MigrationWindow[];
  loadFailed: boolean;
  nameOfOrg: (orgId: string) => string;
  onChanged: () => void;
}) {
  const { t } = useTranslation('ticketImport');
  const [expanded, setExpanded] = useState<string | null>(null);
  const sorted = [...windows].sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  return (
    <Panel title={t('windows.title')} testId="ticket-import-windows">
      {loadFailed && <Notice tone="error" testId="ticket-import-windows-failed">{t('windows.loadFailed')}</Notice>}
      {!loadFailed && sorted.length === 0 && <p className="text-sm text-muted-foreground" data-testid="ticket-import-windows-empty">{t('windows.empty')}</p>}
      {sorted.length > 0 && (
        <ul className="divide-y" data-testid="ticket-import-windows-list">
          {sorted.map((w) => (
            <li key={w.id} className="py-2" data-testid={`ticket-import-window-row-${w.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <span className="font-medium">{w.sourceLabel}</span>{' '}
                  <span className="rounded-md border px-1.5 py-0.5 text-xs" data-testid={`ticket-import-window-status-${w.id}`}>
                    {w.status === 'open' ? t('windows.statusOpen') : t('windows.statusClosed')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {w.status === 'open'
                      ? t('windows.openSummary', { opened: formatDateTime(w.openedAt), ends: formatDateTime(w.endsAt) })
                      : t('windows.closedSummary', { opened: formatDateTime(w.openedAt), closed: formatDateTime(w.closedAt), reason: closedReasonLabel(t, w) })}
                    {' · '}
                    {t('windows.countsLine', {
                      tickets: formatCount(w.counts.ticketsImported),
                      comments: formatCount(w.counts.commentsImported),
                      attachments: formatCount(w.counts.attachmentsImported),
                    })}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={buttonSecondary} onClick={() => setExpanded(expanded === w.id ? null : w.id)}
                    aria-expanded={expanded === w.id} data-testid={`ticket-import-window-toggle-${w.id}`}>
                    {expanded === w.id ? t('windows.hideOrgs') : t('windows.showOrgs')}
                  </button>
                  {w.status === 'open' && <CloseWindowButton win={w} onClosed={onChanged} />}
                </div>
              </div>
              {expanded === w.id && <div className="mt-2"><WindowSummaryTable win={w} nameOfOrg={nameOfOrg} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
