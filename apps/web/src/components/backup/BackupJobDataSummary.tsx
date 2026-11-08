import { useTranslation } from 'react-i18next';
import type { BackupJobDataAccounting } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatBytes } from './backupDashboardHelpers';
import '../../lib/i18n';

const INCREMENTAL_DOCS_URL = 'https://docs.breezermm.com/backup/incremental-backups/';

type Props =
  | { accounting: BackupJobDataAccounting; variant: 'cell' }
  | {
      accounting: BackupJobDataAccounting;
      variant: 'detail';
      resumedAt?: string | null;
      /** Still pending or running, so a processed figure is not "before it stopped". */
      inFlight?: boolean;
    };

function Cell({ accounting }: { accounting: BackupJobDataAccounting }) {
  const { t } = useTranslation('backup');
  const { protectedBytes, uploadedBytes, reusedBytes, processedBytes, runKind, fullRunReason } = accounting;

  let text: string;
  if (reusedBytes === null) {
    // Failed or cancelled: this is work done, not data kept.
    text = processedBytes
      ? t('jobDataSummary.processedBeforeStopped', { processed: formatBytes(processedBytes) })
      : '-';
  } else if (runKind === null || uploadedBytes === null) {
    // Hyper-V and SQL Server runs have no reuse to report.
    text = formatBytes(protectedBytes, '-');
  } else {
    text = t('jobDataSummary.uploadedAndReused', {
      uploaded: formatBytes(uploadedBytes),
      reused: formatBytes(reusedBytes),
    });
  }

  return (
    <span data-testid="backup-job-data-summary" className="inline-flex flex-wrap items-center gap-1.5">
      <span>{text}</span>
      {reusedBytes !== null && runKind === 'full' && fullRunReason && (
        <span
          data-testid="backup-run-full"
          title={t(/* i18n-dynamic */ `fullRunReason.${fullRunReason}`)}
          className="inline-flex items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
        >
          {t('jobDataSummary.full')}
        </span>
      )}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-foreground">{value}</p>
    </div>
  );
}

function Detail({
  accounting,
  resumedAt,
  inFlight = false,
}: {
  accounting: BackupJobDataAccounting;
  resumedAt?: string | null;
  inFlight?: boolean;
}) {
  const { t } = useTranslation('backup');
  const { protectedBytes, uploadedBytes, reusedBytes, processedBytes, runKind, fullRunReason } = accounting;
  const restorable = reusedBytes !== null;

  // "Ran before Breeze tracked it" holds for a finished run. A job that stopped
  // or is still waiting may simply not have been dispatched yet.
  const showRunKind = runKind !== null && (restorable || fullRunReason !== 'unrecorded');
  const stoppedProcessed = !restorable && !inFlight && processedBytes ? processedBytes : null;

  if (!restorable && !showRunKind && !stoppedProcessed && !resumedAt) return null;

  return (
    <div data-testid="backup-job-data-summary" className="mt-4 space-y-3">
      {restorable && (
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('jobDataSummary.heading')}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {restorable && <Row label={t('jobDataSummary.protected')} value={formatBytes(protectedBytes, '-')} />}
        {restorable && runKind !== null && (
          <>
            <Row label={t('jobDataSummary.uploadedThisRun')} value={formatBytes(uploadedBytes, '-')} />
            <Row label={t('jobDataSummary.reusedFromEarlier')} value={formatBytes(reusedBytes)} />
          </>
        )}
        {showRunKind && (
          <Row
            label={t('jobDataSummary.backupType')}
            value={
              runKind === 'full'
                ? t('jobDataSummary.fullWithReason', {
                    reason: t(/* i18n-dynamic */ `fullRunReason.${fullRunReason}`),
                  })
                : t('jobDataSummary.incremental')
            }
          />
        )}
      </div>
      {stoppedProcessed !== null && (
        <p className="text-xs text-muted-foreground">
          {t('jobDataSummary.processedBeforeStopped', { processed: formatBytes(stoppedProcessed) })}
        </p>
      )}
      {resumedAt && (
        <p data-testid="backup-job-resumed" className="text-xs text-muted-foreground">
          {t('jobDataSummary.resumedAt', {
            time: formatDateTime(resumedAt, {
              fallback: '--',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </p>
      )}
      {/* A failed run stored nothing, so the incremental explainer does not apply. */}
      {runKind !== null && (restorable || inFlight) && (
        <p className="text-xs text-muted-foreground">
          {t('jobDataSummary.explainer')}{' '}
          <a href={INCREMENTAL_DOCS_URL} target="_blank" rel="noopener noreferrer" className="underline">
            {t('jobDataSummary.learnMore')}
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * #11027: what a run stored. Only a run that ended restorable is described as
 * having uploaded anything, because the processed figure on any other run
 * counts files that were reused rather than sent.
 */
export default function BackupJobDataSummary(props: Props) {
  if (props.variant === 'cell') return <Cell accounting={props.accounting} />;
  return <Detail accounting={props.accounting} resumedAt={props.resumedAt} inFlight={props.inFlight} />;
}
