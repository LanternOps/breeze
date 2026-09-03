import type { BackupOverviewDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/utils';
import { PageHeader, StatusMark, type MarkTone } from './ui';

const STATUS_COPY: Record<
  BackupOverviewDto['dataStatus'],
  { message: string; tone: MarkTone } | null
> = {
  ok: null,
  not_configured: {
    message: 'Backups are not configured.',
    tone: 'neutral',
  },
  no_data: {
    message: 'No backup data is available yet.',
    tone: 'neutral',
  },
  stale: {
    message: 'Backup data may be out of date.',
    tone: 'warning',
  },
};

function valueOrUnavailable(value: number | null): number | string {
  return value ?? 'Not available';
}

export function BackupOverview({ overview }: { overview: BackupOverviewDto }) {
  const status = STATUS_COPY[overview.dataStatus];
  const protectedDevices =
    overview.protected === null || overview.total === null
      ? 'Not available'
      : `${overview.protected} of ${overview.total}`;

  return (
    <section data-testid="portal-backup-overview">
      <PageHeader
        title="Backups"
        lede="Restore readiness and recovery coverage for your devices."
      />

      {status && (
        <div
          className="mb-6 border-y border-border/70 py-4"
          data-testid="portal-backup-overview-status"
        >
          <StatusMark tone={status.tone}>{status.message}</StatusMark>
        </div>
      )}

      <dl className="grid gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-3">
        <div
          className="bg-card px-5 py-4"
          data-testid="portal-backup-overview-protected"
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Protected devices
          </dt>
          <dd className="mt-2 font-display text-2xl font-semibold text-foreground">
            {protectedDevices}
          </dd>
        </div>
        <div
          className="bg-card px-5 py-4"
          data-testid="portal-backup-overview-last-verification"
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Last verification
          </dt>
          <dd className="mt-2 text-sm font-medium text-foreground">
            {overview.lastPassedVerification?.completedAt
              ? formatDateTime(overview.lastPassedVerification.completedAt)
              : 'No verification is available'}
          </dd>
        </div>
        <div
          className="bg-card px-5 py-4"
          data-testid="portal-backup-overview-last-test-restore"
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Last test restore
          </dt>
          <dd className="mt-2 text-sm font-medium text-foreground">
            {overview.lastTestRestoreAt
              ? `${formatDateTime(overview.lastTestRestoreAt)}${
                  overview.lastTestRestoreStatus
                    ? ` — ${overview.lastTestRestoreStatus}`
                    : ''
                }`
              : 'No test restore is available'}
          </dd>
        </div>
        <div
          className="bg-card px-5 py-4"
          data-testid="portal-backup-overview-readiness"
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Mean readiness
          </dt>
          <dd className="mt-2 font-display text-2xl font-semibold text-foreground">
            {valueOrUnavailable(overview.meanReadinessScore)}
          </dd>
          {overview.readinessScoredDevices !== null &&
            overview.readinessTotalDevices !== null && (
              <p className="mt-1 text-xs text-muted-foreground">
                mean over {overview.readinessScoredDevices} of{' '}
                {overview.readinessTotalDevices} devices
              </p>
            )}
        </div>
        <div
          className="bg-card px-5 py-4"
          data-testid="portal-backup-overview-rpo-breaches"
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Open RPO breaches
          </dt>
          <dd className="mt-2 font-display text-2xl font-semibold text-foreground">
            {valueOrUnavailable(overview.openRpoBreaches)}
          </dd>
        </div>
        <div
          className="bg-card px-5 py-4"
          data-testid="portal-backup-overview-rto-breaches"
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Open RTO breaches
          </dt>
          <dd className="mt-2 font-display text-2xl font-semibold text-foreground">
            {valueOrUnavailable(overview.openRtoBreaches)}
          </dd>
        </div>
      </dl>

      <p
        className="mt-3 text-xs text-muted-foreground"
        data-testid="portal-backup-overview-as-of"
      >
        As of {formatDateTime(overview.asOf)}
      </p>
    </section>
  );
}

export default BackupOverview;
