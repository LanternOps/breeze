import type { ReactNode } from 'react';
import type { BackupHealth, BackupOverviewDto } from '@breeze/shared';
import { cn, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { CELL, ROW, TH, PageHeader, StatusMark, type MarkTone } from './ui';

/**
 * Backups are a page of the Guest Ledger, not a wall of cards: the standing
 * figures are ruled line by line, the way the dashboard rules its own
 * (DashboardTiles). Nothing here is boxed — hairlines carry the structure
 * (apps/portal/DESIGN.md, "data is never boxed").
 */

/**
 * What the band says about the page's data. Every one of these is a condition
 * of OUR data collection, not something the customer can act on, so none of
 * them wears amber — that ink is reserved for what the reader can do something
 * about (apps/portal/DESIGN.md, "Don't use amber for anything the customer
 * cannot act on"). Staleness in particular was shouting a warning at a person
 * with no way to refresh it.
 */
const STATUS_COPY: Record<BackupOverviewDto['dataStatus'], string | null> = {
  ok: null,
  not_configured: 'Backups are not configured.',
  no_data: 'No backup data is available yet.',
  stale: 'Backup data may be out of date.',
};

const LABEL = 'text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const FIGURE = 'text-figures font-display text-lg font-semibold text-foreground';
const QUIET = 'text-sm text-muted-foreground';
/** A date is a figure column (tabular) but never a serif moment. */
const WHEN = 'text-figures text-sm text-foreground';
const PHONE_LABEL = `${LABEL} mb-0.5 block sm:hidden`;

const WORKLOAD_LABELS: Record<string, string> = {
  m365_mail: 'Microsoft 365 mail',
  m365_exchange: 'Exchange',
  m365_onedrive: 'OneDrive',
  m365_sharepoint: 'SharePoint',
  m365_teams: 'Teams',
  gws_mail: 'Google Workspace mail',
  gws_drive: 'Google Drive',
  gws_shared_drive: 'Google shared drives',
};

/**
 * One backup-health verdict, one face, wherever it appears (this summary and the
 * per-device ledger below). Exported so the two never disagree on a tone.
 */
export const HEALTH_TONE: Record<BackupHealth, MarkTone> = {
  healthy: 'success',
  warning: 'warning',
  critical: 'destructive',
  unknown: 'neutral',
};

export const HEALTH_LABEL: Record<BackupHealth, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

export const HEALTH_ORDER: BackupHealth[] = ['healthy', 'warning', 'critical', 'unknown'];

/** A raw status wearing the reader's word: "in_progress" is a database value,
 *  not something a customer should have to translate. */
export function humanizeStatus(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

/**
 * Restore-test status → the register's tone plus a plain word. Exported so the
 * per-device ledger below reads the same raw status the same way; one status
 * must never wear two faces on one page.
 */
export function testRestoreMark(status: string): { tone: MarkTone; label: string } {
  const value = status.trim().toLowerCase();
  if (value === 'passed') return { tone: 'success', label: 'Passed' };
  if (value === 'failed') return { tone: 'destructive', label: 'Failed' };
  return { tone: 'neutral', label: humanizeStatus(status) };
}

/**
 * A real figure speaks in the register's serif; a dead end never does. "Not
 * available" set in Literata is the money face doing dead-end duty — it reads
 * as a number until you get to the words.
 */
function Figure({ value }: { value: number | string | null }) {
  if (value === null) return <span className={QUIET}>Not available</span>;
  return <span className={FIGURE}>{value}</span>;
}

/** One ruled line of the register: label on the left, value on the right. */
function LedgerRow({
  testId,
  label,
  children,
}: {
  testId: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-1.5 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
    >
      <dt className={LABEL}>{label}</dt>
      <dd className="flex flex-col gap-1 sm:items-end sm:text-right">{children}</dd>
    </div>
  );
}

export function BackupOverview({
  overview,
  timezone = 'UTC',
  hasBackupActivity = false,
}: {
  overview: BackupOverviewDto;
  /**
   * The org's own zone. This page renders on the server, so without it every
   * stamp below is the droplet's clock wearing the customer's date. Defaults to
   * UTC, which is what the API falls back to when an org has no zone set.
   */
  timezone?: string;
  /** Whether the device ledger on this page holds a real restore point. */
  hasBackupActivity?: boolean;
}) {
  // `no_data` means "no passed verification yet" (services/portal/backupReadModel
  // backupTile), NOT "no backups". Banding the page on it printed "No backup data
  // is available yet." directly above "Devices backed up 2 of 2" and a ledger
  // listing a real restore point. The invariant: the band never contradicts what
  // the rows beneath it say, so any evidence of backups — protected devices, a
  // restore test, a restore point in the ledger — keeps it away, and the missing
  // verification is said plainly in its own summary row instead.
  const saasWorkloads = overview.saasWorkloads ?? [];
  const hasBackups =
    hasBackupActivity || (overview.protected ?? 0) > 0 || overview.lastTestRestoreAt !== null ||
    saasWorkloads.length > 0;
  const status =
    overview.dataStatus === 'no_data' && hasBackups ? null : STATUS_COPY[overview.dataStatus];

  // "Backed up" = covered by ANY backup source (Breeze or a connected provider),
  // counted over the same rows the device ledger below lists (#7505). The
  // dashboard's "Endpoint protection" tile is the security concept, not this.
  const protectedDevices =
    overview.protected === null || overview.total === null
      ? null
      : `${overview.protected} of ${overview.total}`;
  const healthBuckets = HEALTH_ORDER.filter((h) => (overview.byHealth?.[h] ?? 0) > 0);
  const restoreTestMark = overview.lastTestRestoreStatus
    ? testRestoreMark(overview.lastTestRestoreStatus)
    : null;

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
          {/* A sentence is body copy. Set in the small-caps label style it read
              as 32 characters of shouting above the ledger. */}
          <p className="text-sm text-muted-foreground">{status}</p>
        </div>
      )}

      <dl
        className="divide-y divide-border/70 border-t border-border/70"
        data-testid="portal-backup-overview-summary"
      >
        <LedgerRow testId="portal-backup-overview-protected" label="Devices backed up">
          <Figure value={protectedDevices} />
        </LedgerRow>

        <LedgerRow testId="portal-backup-overview-health" label="Backup health">
          {healthBuckets.length === 0 ? (
            <span className={QUIET}>No devices assessed</span>
          ) : (
            <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              {healthBuckets.map((h) => (
                <StatusMark key={h} tone={HEALTH_TONE[h]}>
                  {overview.byHealth[h]} {HEALTH_LABEL[h]}
                </StatusMark>
              ))}
            </span>
          )}
        </LedgerRow>

        <LedgerRow testId="portal-backup-overview-last-verification" label="Last verification">
          {overview.lastPassedVerification?.completedAt ? (
            <span className={WHEN}>
              {formatDateTime(overview.lastPassedVerification.completedAt, timezone, true)}
            </span>
          ) : (
            <span className={QUIET}>No verification has run yet.</span>
          )}
        </LedgerRow>

        <LedgerRow testId="portal-backup-overview-last-test-restore" label="Last restore test">
          {overview.lastTestRestoreAt ? (
            <span className={WHEN}>{formatDateTime(overview.lastTestRestoreAt, timezone, true)}</span>
          ) : (
            <span className={QUIET}>No restore test has run yet.</span>
          )}
          {restoreTestMark && (
            <StatusMark tone={restoreTestMark.tone}>{restoreTestMark.label}</StatusMark>
          )}
        </LedgerRow>

        <LedgerRow testId="portal-backup-overview-readiness" label="Recovery readiness">
          <Figure value={overview.meanReadinessScore} />
          {overview.readinessScoredDevices !== null &&
            overview.readinessTotalDevices !== null && (
              <span className="text-xs text-muted-foreground">
                Average across {overview.readinessScoredDevices} of{' '}
                {overview.readinessTotalDevices} devices
              </span>
            )}
        </LedgerRow>

        <LedgerRow testId="portal-backup-overview-rpo-breaches" label="Backups behind schedule">
          <Figure value={overview.openRpoBreaches} />
        </LedgerRow>

        <LedgerRow
          testId="portal-backup-overview-rto-breaches"
          label="Restores slower than promised"
        >
          <Figure value={overview.openRtoBreaches} />
        </LedgerRow>

        <LedgerRow testId="portal-backup-overview-providers" label="Third-party backup">
          {overview.externalProviders?.length ? (
            <span className={WHEN}>{overview.externalProviders.join(', ')}</span>
          ) : (
            <span className={QUIET}>None connected</span>
          )}
        </LedgerRow>
      </dl>

      {saasWorkloads.length > 0 && (
        <section className="mt-10" data-testid="portal-backup-saas" aria-labelledby="portal-backup-saas-title">
          <h2 id="portal-backup-saas-title" className="mb-4 font-display text-lg font-semibold text-foreground">
            Microsoft 365 / Google Workspace backup
          </h2>
          <table className="block w-full sm:table">
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>Workload</th>
                <th scope="col" className={cn(TH, 'text-left')}>Health</th>
                <th scope="col" className={cn(TH, 'text-right')}>Last successful backup</th>
                <th scope="col" className={cn(TH, 'text-right')}>Items</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {saasWorkloads.map((workload, index) => (
                <tr key={`${workload.workload}-${index}`} className={ROW} data-testid="portal-backup-saas-row">
                  <td className={cn(CELL, 'font-medium')}>
                    {WORKLOAD_LABELS[workload.workload] ?? humanizeStatus(workload.workload)} backup
                    {workload.providerLabel && <span className="mt-1 block text-xs font-normal text-muted-foreground">{workload.providerLabel}</span>}
                  </td>
                  <td className={CELL}>
                    <span className={PHONE_LABEL}>Health</span>
                    <StatusMark tone={HEALTH_TONE[workload.health]}>{HEALTH_LABEL[workload.health]}</StatusMark>
                  </td>
                  <td className={cn(CELL, 'sm:text-right')}>
                    <span className={PHONE_LABEL}>Last successful backup</span>
                    {workload.lastSuccessAt ? (
                      <time className={WHEN} dateTime={workload.lastSuccessAt} title={formatDateTime(workload.lastSuccessAt, timezone, true)}>
                        {formatRelativeTime(workload.lastSuccessAt)}
                      </time>
                    ) : <span className={QUIET}>No successful backup yet</span>}
                  </td>
                  <td className={cn(CELL, 'sm:text-right')} data-testid="portal-backup-saas-items">
                    <span className={PHONE_LABEL}>Items</span>
                    <span className={workload.itemCount === null ? QUIET : WHEN}>{workload.itemCount ?? 'Not available'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* The register dates itself at the foot, the way a ledger page does. */}
      <p
        className="text-figures border-t border-border/70 pt-4 text-xs text-muted-foreground"
        data-testid="portal-backup-overview-as-of"
      >
        As of {formatDateTime(overview.asOf, timezone, true)}
      </p>
    </section>
  );
}

export default BackupOverview;
