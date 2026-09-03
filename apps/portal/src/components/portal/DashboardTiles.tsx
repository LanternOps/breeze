import type { DashboardDto, SecurityScoreBand, TileStatus } from '@breeze/shared';
import type { ReactNode } from 'react';
import { withBase } from '@/lib/basePath';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';
import { ErrorNotice, PageHeader, StatusMark } from './ui';

/**
 * The dashboard is a page of the Guest Ledger, not a wall of cards: the firm
 * states the account's condition in one sentence, says what is waiting on the
 * customer, and then rules the standing figures line by line. Nothing here is
 * boxed — hairlines carry the structure (apps/portal/DESIGN.md).
 */

const LABEL = 'text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const FIGURE = 'text-figures font-display text-lg font-semibold text-foreground';
const QUIET = 'text-sm text-muted-foreground';
const LINK =
  'font-semibold text-primary-on-tint underline underline-offset-4 transition-colors duration-150 hover:text-foreground';

/**
 * What the register says when a figure is not there. The customer reads plain
 * language and one muted mark — never a grey apology sentence, and never an
 * invented zero.
 */
const UNAVAILABLE: Record<Exclude<TileStatus, 'ok'>, string> = {
  no_data: 'Not yet available',
  not_configured: 'Not set up',
  stale: 'May be out of date',
};

const BAND_LABEL: Record<SecurityScoreBand, string> = {
  strong: 'Strong',
  good: 'Good',
  fair: 'Fair',
  at_risk: 'At risk',
};

/**
 * `formatRelativeTime` returns display-cased phrases ("Yesterday",
 * "Last Tuesday"); a blanket lowercase would ruin the weekday, so only the
 * capitalised leading words are lowered for mid-sentence use.
 */
function midSentenceWhen(value: string): string {
  const phrase = formatRelativeTime(value);
  if (phrase === 'Just now') return 'just now';
  if (phrase === 'Yesterday') return 'yesterday';
  return phrase.startsWith('Last ') ? `last ${phrase.slice(5)}` : phrase;
}

/**
 * One quotable sentence for the top of the page, assembled only from tiles the
 * API reports as `ok` — a stale or missing figure never gets stated as fact.
 */
function accountHeadline(dashboard: DashboardDto): string {
  const clauses: string[] = [];

  const devices = dashboard.devicesProtected;
  if (
    devices.status === 'ok' &&
    devices.protected != null &&
    devices.total != null &&
    devices.total > 0 &&
    devices.unknown !== devices.total
  ) {
    clauses.push(
      devices.protected === devices.total
        ? `All ${devices.total} ${devices.total === 1 ? 'device' : 'devices'} protected`
        : `${devices.protected} of ${devices.total} devices protected`,
    );
  }

  const backup = dashboard.backup;
  if (backup.status === 'ok' && backup.completedAt) {
    clauses.push(`backups verified ${midSentenceWhen(backup.completedAt)}`);
  }

  // Nothing to say about devices or backups: the security score is the next
  // thing the customer recognises as their own.
  const security = dashboard.securityScore;
  if (clauses.length === 0 && security.status === 'ok' && security.score != null) {
    clauses.push(
      security.band
        ? `Your security score is ${security.score} — ${BAND_LABEL[security.band].toLowerCase()}`
        : `Your security score is ${security.score}`,
    );
  }

  if (clauses.length === 0) return "We're still gathering data for this account.";
  return `${clauses.join(', ')}.`;
}

/**
 * A tile the API calls `ok` but sends without a figure has nothing to show;
 * the register says "not yet available" rather than ruling a blank line.
 */
function effectiveStatus(status: TileStatus, hasValue: boolean): TileStatus {
  return status === 'ok' && !hasValue ? 'no_data' : status;
}

/** One ruled line of the register: label on the left, figure on the right. */
function LedgerRow({
  testId,
  label,
  status,
  children,
}: {
  testId: string;
  label: string;
  status: TileStatus;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-1.5 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
    >
      <dt className={LABEL}>{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 sm:justify-end sm:text-right">
        {children}
        {status !== 'ok' && <StatusMark tone="neutral">{UNAVAILABLE[status]}</StatusMark>}
      </dd>
    </div>
  );
}

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The one line on this page the customer can act on, so it leads. */
function AwaitingYou({ awaitingYou }: { awaitingYou: DashboardDto['awaitingYou'] }) {
  const { status, proposals, invoices } = awaitingYou;

  const links: ReactNode[] = [];
  if (proposals != null && proposals > 0) {
    links.push(
      <a key="proposals" className={LINK} href={withBase('/quotes')}>
        {countPhrase(proposals, 'proposal', 'proposals')}
      </a>,
    );
  }
  if (invoices != null && invoices > 0) {
    links.push(
      <a key="invoices" className={LINK} href={withBase('/invoices')}>
        {countPhrase(invoices, 'invoice', 'invoices')}
      </a>,
    );
  }

  const bothKnown = proposals != null && invoices != null;
  const singular = links.length === 1 && (proposals === 1 || invoices === 1);

  let statement: ReactNode;
  if (links.length > 0) {
    statement = (
      <>
        {links.length === 2 ? (
          <>
            {links[0]} and {links[1]}
          </>
        ) : (
          links[0]
        )}
        {singular ? ' is waiting for you.' : ' are waiting for you.'}
      </>
    );
  } else if (bothKnown) {
    statement = 'Nothing is waiting on you.';
  } else {
    statement = "We're still gathering what's waiting on you.";
  }

  return (
    <section
      data-testid="portal-dashboard-tile-awaiting-you"
      className="border-y border-border/70 py-5"
    >
      <p className="text-[0.9375rem] leading-relaxed text-foreground sm:text-base">{statement}</p>
      {status !== 'ok' && (
        <StatusMark tone="neutral" className="mt-2">
          {UNAVAILABLE[status]}
        </StatusMark>
      )}
    </section>
  );
}

function SecurityValue({ tile }: { tile: DashboardDto['securityScore'] }) {
  if (tile.score == null) return null;

  const supporting: string[] = [];
  if (tile.band) supporting.push(BAND_LABEL[tile.band]);
  if (tile.delta30d != null) {
    supporting.push(
      tile.delta30d === 0
        ? 'no change in 30 days'
        : `${tile.delta30d > 0 ? 'up' : 'down'} ${Math.abs(tile.delta30d)} in 30 days`,
    );
  }

  return (
    <>
      <span className={FIGURE}>{tile.score}</span>
      {supporting.length > 0 && <span className={QUIET}>{supporting.join(', ')}</span>}
    </>
  );
}

function DevicesValue({ tile }: { tile: DashboardDto['devicesProtected'] }) {
  const { protected: safe, unknown, total } = tile;
  if (safe == null || unknown == null || total == null) return null;

  // A fleet nobody has heard from is not an unprotected fleet: say what we
  // actually know rather than printing "0 of 10 protected".
  if (unknown === total) {
    return <span className={QUIET}>Not yet known for all {total} devices</span>;
  }

  return (
    <>
      <span className={FIGURE}>
        {safe} of {total}
      </span>
      {unknown > 0 && <span className={QUIET}>{unknown} not yet known</span>}
    </>
  );
}

function BackupValue({ tile, timezone }: { tile: DashboardDto['backup']; timezone: string }) {
  if (tile.completedAt == null) return null;
  // A date is a figure column (tabular), but not a serif moment: Literata is
  // reserved for titles and money.
  return (
    <span className="text-figures text-sm text-foreground">
      {`${formatDateTime(tile.completedAt, timezone)} (${timezone})`}
    </span>
  );
}

export function DashboardTiles({ dashboard }: { dashboard: DashboardDto }) {
  const {
    securityScore,
    devicesProtected,
    patchesApplied,
    backup,
    support,
    actionItems,
    awaitingYou,
  } = dashboard;

  return (
    <div>
      <PageHeader title="Dashboard" lede={accountHeadline(dashboard)} />

      <AwaitingYou awaitingYou={awaitingYou} />

      <dl className="divide-y divide-border/70">
        <LedgerRow
          testId="portal-dashboard-tile-devices"
          label="Devices protected"
          status={effectiveStatus(
            devicesProtected.status,
            devicesProtected.protected != null &&
              devicesProtected.unknown != null &&
              devicesProtected.total != null,
          )}
        >
          <DevicesValue tile={devicesProtected} />
        </LedgerRow>

        <LedgerRow
          testId="portal-dashboard-tile-security"
          label="Security score"
          status={effectiveStatus(securityScore.status, securityScore.score != null)}
        >
          <SecurityValue tile={securityScore} />
        </LedgerRow>

        <LedgerRow
          testId="portal-dashboard-tile-action-items"
          label="Action items"
          status={effectiveStatus(actionItems.status, actionItems.count != null)}
        >
          {actionItems.count != null && <span className={FIGURE}>{actionItems.count}</span>}
        </LedgerRow>

        <LedgerRow
          testId="portal-dashboard-tile-patches"
          label="Patches applied this month"
          status={effectiveStatus(patchesApplied.status, patchesApplied.applied != null)}
        >
          {patchesApplied.applied != null && (
            <span className={FIGURE}>{patchesApplied.applied}</span>
          )}
        </LedgerRow>

        <LedgerRow
          testId="portal-dashboard-tile-backup"
          label="Last backup verified"
          status={effectiveStatus(backup.status, backup.completedAt != null)}
        >
          <BackupValue tile={backup} timezone={dashboard.timezone} />
        </LedgerRow>

        <LedgerRow
          testId="portal-dashboard-tile-support"
          label="Support"
          status={effectiveStatus(support.status, support.openTickets != null)}
        >
          {support.openTickets != null && (
            <>
              <span className={FIGURE}>{support.openTickets}</span>
              <span className={QUIET}>
                {support.openTickets === 1 ? 'open request' : 'open requests'}
              </span>
            </>
          )}
        </LedgerRow>
      </dl>

      {/* The register dates itself at the foot, the way a ledger page does. */}
      <p className="text-figures border-t border-border/70 pt-4 text-xs text-muted-foreground">
        {`Current as of ${formatDateTime(dashboard.asOf, dashboard.timezone)} (${dashboard.timezone}).`}
      </p>
    </div>
  );
}

/**
 * The failure state a customer actually sees. The raw API error used to land
 * here as body text ("Internal Server Error"); the concierge names the problem
 * and the way out instead.
 */
export function DashboardUnavailable({ supportEmail }: { supportEmail?: string | null }) {
  return (
    <div>
      <PageHeader title="Dashboard" />
      <ErrorNotice>
        <span data-testid="portal-dashboard-error">We couldn&apos;t load your dashboard just now. Your IT team can help.</span>
        {supportEmail && (
          <a
            className="ml-1 font-semibold underline underline-offset-4"
            href={`mailto:${supportEmail}`}
          >
            {supportEmail}
          </a>
        )}
      </ErrorNotice>
    </div>
  );
}
