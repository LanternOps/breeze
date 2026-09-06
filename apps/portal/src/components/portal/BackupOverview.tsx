import type { ReactNode } from 'react';
import type { BackupOverviewDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/utils';
import { PageHeader, StatusMark, type MarkTone } from './ui';

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
  // is available yet." directly above "Protected devices 2 of 2" and a ledger
  // listing a real restore point. The invariant: the band never contradicts what
  // the rows beneath it say, so any evidence of backups — protected devices, a
  // restore test, a restore point in the ledger — keeps it away, and the missing
  // verification is said plainly in its own summary row instead.
  const hasBackups =
    hasBackupActivity || (overview.protected ?? 0) > 0 || overview.lastTestRestoreAt !== null;
  const status =
    overview.dataStatus === 'no_data' && hasBackups ? null : STATUS_COPY[overview.dataStatus];

  const protectedDevices =
    overview.protected === null || overview.total === null
      ? null
      : `${overview.protected} of ${overview.total}`;
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
        <LedgerRow testId="portal-backup-overview-protected" label="Protected devices">
          <Figure value={protectedDevices} />
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
      </dl>

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
