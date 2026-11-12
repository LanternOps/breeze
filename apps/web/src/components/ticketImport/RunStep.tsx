import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { PARTNER_WIDE, isRunActive, type ImportRun, type ImportSourceDetail, type MigrationWindow, type RunIssueKind } from './ticketImportApi';
import { useRunPolling } from './useRunPolling';
import RunReport, { stateLabel, stopReasonLabel } from './RunReport';
import CreatedContactsPanel from './CreatedContactsPanel';
import { Notice, Panel, buttonDanger, buttonPrimary, buttonSecondary, formatCount, importFriendly } from './importUi';

/**
 * Steps 4, 6 and 7 (#8313 W6; spec 2026-10-19 §5.11, §7): the dry run, the
 * bulk run and the delta run. Each starts a run (POST /sources/:id/runs),
 * follows it every 5 s until it ends, and reads its report. Bulk and delta
 * are both import runs through the source's open window; the delta is the
 * same pass on a frozen source (§5.9), so the step asks for the freeze first
 * and reads the report in the runbook's order (§7 step 9).
 */
export type RunStepKind = 'dry_run' | 'bulk' | 'delta';

type Props = {
  kind: RunStepKind;
  source: ImportSourceDetail;
  runs: ImportRun[];
  openWindow: MigrationWindow | null;
  nameOfOrg: (orgId: string) => string;
  onRunsChanged: () => void;
  onContinue: () => void;
  onOpenWindowStep: () => void;
};

/** The delta report's reading order (§7 step 9): a flipped internal flag first. */
const DELTA_FOCUS: readonly RunIssueKind[] = ['comments_changed', 'requester_changed', 'status_kept', 'deleted_in_source', 'hidden_in_source'];
const DRY_FOCUS: readonly RunIssueKind[] = ['skipped_no_org', 'owner_unmatched', 'failed', 'row_unreadable'];

/** The run a step shows: the newest of its kind (an import step: in the open window, when there is one). */
export function runForStep(kind: RunStepKind, runs: readonly ImportRun[], openWindow: MigrationWindow | null): ImportRun | null {
  if (kind === 'dry_run') return runs.find((r) => r.kind === 'dry_run') ?? null;
  return runs.find((r) => r.kind === 'import' && (!openWindow || r.windowId === openWindow.id)) ?? null;
}

function handleError(err: unknown, fallback: string) {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
}

export default function RunStep({ kind, source, runs, openWindow, nameOfOrg, onRunsChanged, onContinue, onOpenWindowStep }: Props) {
  const { t } = useTranslation('ticketImport');
  const prefix = kind === 'dry_run' ? 'dryRun' : kind;
  const listed = runForStep(kind, runs, openWindow);
  const [startedId, setStartedId] = useState<string | null>(null);
  const runId = startedId ?? listed?.id ?? null;
  const { run: polled, missing, readFailed } = useRunPolling(runId, () => onRunsChanged());
  const run = polled ?? (listed && listed.id === runId ? listed : null);
  const [starting, setStarting] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // A run started here wins until the list catches up with it.
  useEffect(() => {
    if (startedId && listed?.id === startedId) setStartedId(null);
  }, [startedId, listed?.id]);

  const active = run ? isRunActive(run.state) : false;
  const otherActive = source.activeRunId !== null && source.activeRunId !== run?.id;
  const needsWindow = kind !== 'dry_run' && !openWindow;
  const revoked = !source.hasCredentials;
  const canStart = !starting && !active && !otherActive && !needsWindow && !revoked && (kind !== 'delta' || frozen);

  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const body = kind === 'dry_run' ? { kind: 'dry_run' } : { kind: 'import', windowId: openWindow!.id };
      const result = await runAction<{ data: ImportRun }>({
        request: () => fetchWithAuth(`/ticket-imports/sources/${source.id}/runs`, {
          ...PARTNER_WIDE,
          method: 'POST',
          body: JSON.stringify(body),
        }),
        errorFallback: t('run.startFailed'),
        friendly: importFriendly(t),
        successMessage: t(/* i18n-dynamic */ `run.started.${prefix}`),
      });
      setStartedId(result.data.id);
      onRunsChanged();
    } catch (err) {
      handleError(err, t('run.startFailed'));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-imports/runs/${run.id}/cancel`, { ...PARTNER_WIDE, method: 'POST' }),
        errorFallback: t('run.cancelFailed'),
        friendly: importFriendly(t),
        successMessage: t('run.cancelRequested'),
      });
      onRunsChanged();
    } catch (err) {
      handleError(err, t('run.cancelFailed'));
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title={t(/* i18n-dynamic */ `run.title.${prefix}`)}
        testId={`ticket-import-run-${kind}`}
        actions={(
          <>
            {active && (
              <button type="button" className={buttonDanger} onClick={() => setConfirmCancel(true)} disabled={cancelling}
                data-testid="ticket-import-run-cancel">{t('run.cancel')}</button>
            )}
            <button type="button" className={run ? buttonSecondary : buttonPrimary} onClick={() => void start()} disabled={!canStart}
              data-testid="ticket-import-run-start">
              {starting ? t('run.starting') : run ? t(/* i18n-dynamic */ `run.startAgain.${prefix}`) : t(/* i18n-dynamic */ `run.start.${prefix}`)}
            </button>
          </>
        )}
      >
        <p className="mb-3 text-sm text-muted-foreground">{t(/* i18n-dynamic */ `run.intro.${prefix}`)}</p>
        <div className="space-y-2">
          {revoked && <Notice tone="warning">{t('run.revoked')}</Notice>}
          {needsWindow && (
            <Notice tone="warning" testId="ticket-import-run-needs-window">
              {t('run.needsWindow')}{' '}
              <button type="button" className="font-medium underline underline-offset-2" onClick={onOpenWindowStep}
                data-testid="ticket-import-run-go-window">{t('run.goWindow')}</button>
            </Notice>
          )}
          {otherActive && <Notice tone="warning" testId="ticket-import-run-other-active">{t('run.otherActive')}</Notice>}
          {kind === 'delta' && !active && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={frozen} onChange={(e) => setFrozen(e.target.checked)}
                data-testid="ticket-import-run-frozen" />
              <span>{t('run.frozen')}</span>
            </label>
          )}
          {missing && <Notice tone="error" testId="ticket-import-run-missing">{t('run.missing')}</Notice>}
          {readFailed && <Notice tone="warning" testId="ticket-import-run-read-failed">{t('run.readFailed')}</Notice>}
        </div>

        {run && (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="ticket-import-run-status" data-state={run.state}>
              <span className="rounded-md border px-2 py-0.5 font-medium" data-testid="ticket-import-run-state">{stateLabel(t, run)}</span>
              {active && (
                <span className="text-muted-foreground" data-testid="ticket-import-run-progress">
                  {t('run.progress', { seen: formatCount(run.counters.tickets.seen), phase: t(/* i18n-dynamic */ `run.phase.${run.phase}`) })}
                </span>
              )}
              {run.stopReason && (
                <span className="text-muted-foreground" data-testid="ticket-import-run-stop-reason">{stopReasonLabel(t, run.stopReason)}</span>
              )}
            </div>
            <RunReport run={run} nameOfOrg={nameOfOrg} focusKinds={kind === 'delta' ? DELTA_FOCUS : kind === 'dry_run' ? DRY_FOCUS : []} />
            {!active && (
              <button type="button" className={buttonPrimary} onClick={onContinue} data-testid="ticket-import-run-continue">
                {t('common.continue')}
              </button>
            )}
          </div>
        )}
      </Panel>

      {kind !== 'dry_run' && <CreatedContactsPanel source={source} nameOfOrg={nameOfOrg} runActive={active || otherActive} />}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => void cancel()}
        title={t('run.cancelTitle')}
        message={t('run.cancelMessage')}
        confirmLabel={t('run.cancel')}
        variant="warning"
        isLoading={cancelling}
        confirmTestId="ticket-import-run-cancel-confirm"
      />
    </div>
  );
}
