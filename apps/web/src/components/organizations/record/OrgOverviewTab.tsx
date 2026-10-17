import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveAlertTitle } from '@breeze/shared';
import { formatDate, formatDateTime } from '@/lib/dateTimeFormat';
import { formatCurrency, formatNumber } from '@/lib/i18n/format';
import { useAuditActionFormatter } from '@/lib/auditFormat';
import type { AlertRow, AuditLogEntry } from '@/components/dashboard/types';
import { EntityLink } from '@/components/shared/EntityLink';
import HashLink from '@/components/shared/HashLink';
import OrgKeyDatesCard from './OrgKeyDatesCard';
import { useLatest, type OrgFetch, type OrgSummary } from './orgRecordFetch';
import { ORG_RECORD_TABS, type OrgRecordTab, type ServiceManagementMode } from './orgRecordTabs';

export interface OrgOverviewTabProps {
  orgId: string;
  orgFetch: OrgFetch;
  summary: OrgSummary | null;
  summaryFailed: boolean;
  /**
   * The partner's Service Management mode (#5075 W04). Anything but `native`
   * withdraws the three stats the module owns.
   *
   * Deliberately COARSER than the tab gate in `orgRecordTabs.ts`, which keeps
   * the Tickets tab under `external` because it lists the shadow rows Breeze
   * still writes. A summary COUNT is the part that misleads under `external`:
   * it would read as the customer's ticket position while the real numbers live
   * in the PSA. The tab, which links out to those rows, does not have that
   * problem. `off` hides all three for the plainer reason that none of them
   * exist.
   *
   * Defaults to `native` so a caller that has not wired the store yet (and any
   * existing test) keeps today's behaviour.
   */
  mode?: ServiceManagementMode;
  /**
   * The record tabs this user can open (`visibleTabs`). A stat links to its
   * tab only when the tab is in this list: a link to a hidden tab would bounce
   * straight back to Overview, which reads as a broken link. Defaults to every
   * tab for callers that do not gate.
   */
  tabs?: readonly OrgRecordTab[];
  /**
   * An archived org's summary, alerts and activity reads all 404 by design
   * (sweep B3): the API scopes those endpoints to accessible orgs, and
   * archived is deliberately outside that set. Rendering the stats and the
   * two feeds anyway produced a wall of "Couldn't load…" error panels
   * instead of the read-only state the banner above already announces. When
   * true, skip the fetches entirely and show one quiet notice instead.
   */
  archived?: boolean;
}

/** Stats owned by the Service Management module; hidden unless mode is `native`. */
const SERVICE_MANAGEMENT_STAT_KEYS: ReadonlySet<string> = new Set(['tickets', 'contracts', 'invoices']);

/** Where a stat leads: a record tab (hash), or a page outside the record. */
type StatTarget = { tab: OrgRecordTab } | { href: string };

/** One number inside a fleet stat. Zero-valued metrics are never built. */
interface Metric {
  key: string;
  value: number;
  label: string;
  /** Colour only for a non-zero severe count. */
  tone?: 'critical' | 'high';
}

interface FleetStat {
  key: 'devices' | 'alerts' | 'tickets';
  label: string;
  target: StatTarget;
  metrics: Metric[];
  /** Muted copy shown in place of (or after) the numbers: "All online". */
  note?: string;
}

interface AccountStat {
  key: 'contracts' | 'invoices' | 'contacts' | 'portalUsers';
  label: string;
  target: StatTarget;
  value: string;
  sub?: string;
  subTone?: 'critical';
}

const TONE_CLASS: Record<NonNullable<Metric['tone']>, string> = {
  critical: 'text-destructive',
  // The bright --warning is ~2.3:1 on a light card; the strong variant clears
  // 4.5:1 as text.
  high: 'text-warning-strong',
};

const CRITICAL_ALERTS_PATH = '/alerts?status=active&severity=critical&limit=10';
const RECENT_ACTIVITY_PATH = '/audit-logs/logs?limit=20&skipCount=true';

/** Feed timestamps: minute precision is what triage needs; seconds are noise. */
const FEED_TIME_FORMAT = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** `null` = still loading; `'failed'` = we could not find out; otherwise rows. */
type FeedState<T> = T[] | 'failed' | null;

/**
 * One feed load, with "we could not find out" kept distinct from "there is
 * nothing".
 *
 * A non-2xx is a FAILURE, not an empty list. Collapsing a 403 (no
 * `alerts:read`) or a 500 into `[]` renders "No open critical alerts" — a
 * confident false negative in a monitoring tool, which a tech triaging a
 * customer could reasonably act on by not escalating. It is the same lie the
 * summary stats deliberately avoid by omitting a section rather than showing a
 * zero; the feeds have to hold the same line.
 */
async function loadFeed<T>(
  request: Promise<Response>,
  pick: (body: Record<string, unknown>) => T[],
  label: string,
): Promise<T[] | 'failed'> {
  try {
    const res = await request;
    if (!res.ok) {
      console.warn(`[OrgRecord] ${label} feed failed: HTTP ${res.status}`);
      return 'failed';
    }
    return pick((await res.json()) as Record<string, unknown>);
  } catch (err) {
    console.warn(`[OrgRecord] ${label} feed failed`, err);
    return 'failed';
  }
}

const STAT_LINK_CLASS =
  'transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/**
 * A stat's container: a link when it has somewhere the user can go, a plain
 * block otherwise. The test id stays on whichever element renders, so callers
 * can assert "linked" vs "not linked" on the same id.
 */
function StatContainer({
  target,
  testId,
  className,
  children,
}: {
  target: StatTarget | null;
  testId: string;
  className: string;
  children: ReactNode;
}) {
  if (!target) {
    return (
      <div data-testid={testId} className={className}>
        {children}
      </div>
    );
  }
  if ('tab' in target) {
    return (
      <HashLink hash={target.tab} data-testid={testId} className={`${className} ${STAT_LINK_CLASS}`}>
        {children}
      </HashLink>
    );
  }
  return (
    <a href={target.href} data-testid={testId} className={`${className} ${STAT_LINK_CLASS}`}>
      {children}
    </a>
  );
}

/**
 * The record's landing tab, in two tiers.
 *
 * Tier 1, the fleet strip, answers "is this customer OK": devices online and
 * offline, open alerts by severity, open tickets. Tier 2, the account row, is
 * the money-and-people context (contracts, outstanding invoices, contacts,
 * portal users) beside the key dates card. Every stat links to where its
 * detail lives.
 *
 * A stat whose summary section is ABSENT is not rendered at all — the section
 * is missing because the caller lacks the read permission, and a "0" there
 * would be a confident lie about a customer's fleet. Within a present section a
 * zero reads as muted words ("All online", "No open alerts"), never as a big 0.
 * The two feeds below hold the same line: a failed load says so, rather than
 * rendering the empty state.
 */
export default function OrgOverviewTab({
  orgId,
  orgFetch,
  summary,
  summaryFailed,
  mode = 'native',
  tabs = ORG_RECORD_TABS,
  archived = false,
}: OrgOverviewTabProps) {
  const { t } = useTranslation('organizations');
  const formatAuditAction = useAuditActionFormatter();
  const fleetHeadingId = useId();
  const accountHeadingId = useId();
  const [activity, setActivity] = useState<FeedState<AuditLogEntry>>(null);
  const [alerts, setAlerts] = useState<FeedState<AlertRow>>(null);
  const activityLatest = useLatest<AuditLogEntry[] | 'failed'>();
  const alertsLatest = useLatest<AlertRow[] | 'failed'>();

  const loadFeeds = useCallback(async () => {
    // The two feeds are independent: one failing (a tech without audit:read
    // gets a 403 on activity) must leave the other, and the stats, intact.
    const activityRun = activityLatest
      .run(
        loadFeed<AuditLogEntry>(
          orgFetch(RECENT_ACTIVITY_PATH),
          (j) => (j.logs ?? j.auditLogs ?? j.data ?? []) as AuditLogEntry[],
          'activity',
        ),
      )
      .then((result) => result !== undefined && setActivity(result));

    const alertsRun = alertsLatest
      .run(
        loadFeed<AlertRow>(orgFetch(CRITICAL_ALERTS_PATH), (j) => (j.data ?? []) as AlertRow[], 'critical alerts'),
      )
      .then((result) => result !== undefined && setAlerts(result));

    await Promise.all([activityRun, alertsRun]);
  }, [orgFetch, activityLatest, alertsLatest]);

  useEffect(() => {
    if (archived) return;
    void loadFeeds();
  }, [loadFeeds, orgId, archived]);

  /** A tab target survives only if this user can open that tab. */
  const resolveTarget = (target: StatTarget): StatTarget | null =>
    'tab' in target && !tabs.includes(target.tab) ? null : target;

  const fleet: FleetStat[] = [];
  if (summary?.devices) {
    const { total, online, offline } = summary.devices;
    const metrics: Metric[] = [];
    let note: string | undefined;
    if (total === 0) {
      note = t('orgRecord.overview.fleet.noDevices');
    } else if (offline === 0) {
      metrics.push({ key: 'total', value: total, label: t('orgRecord.overview.fleet.total') });
      note = t('orgRecord.overview.fleet.allOnline');
    } else {
      if (online > 0) metrics.push({ key: 'online', value: online, label: t('orgRecord.devices.status.online') });
      metrics.push({ key: 'offline', value: offline, label: t('orgRecord.devices.status.offline') });
      metrics.push({ key: 'total', value: total, label: t('orgRecord.overview.fleet.total') });
    }
    fleet.push({ key: 'devices', label: t('orgRecord.overview.tiles.devices'), target: { tab: 'devices' }, metrics, note });
  }
  if (summary?.alerts) {
    const { open, critical, high } = summary.alerts;
    const other = Math.max(0, open - critical - high);
    const metrics: Metric[] = [];
    if (critical > 0) metrics.push({ key: 'critical', value: critical, label: t('orgRecord.overview.fleet.critical'), tone: 'critical' });
    if (high > 0) metrics.push({ key: 'high', value: high, label: t('orgRecord.overview.fleet.high'), tone: 'high' });
    if (other > 0) metrics.push({ key: 'other', value: other, label: t('orgRecord.overview.fleet.otherAlerts') });
    fleet.push({
      key: 'alerts',
      label: t('orgRecord.overview.tiles.alerts'),
      // No alerts tab on the record — the org-filtered alert list is the detail.
      target: { href: `/alerts?orgId=${encodeURIComponent(orgId)}` },
      metrics,
      note: metrics.length === 0 ? t('orgRecord.overview.fleet.noAlerts') : undefined,
    });
  }
  if (summary?.tickets) {
    const { open, awaitingCustomer } = summary.tickets;
    const metrics: Metric[] = [];
    if (open > 0) metrics.push({ key: 'open', value: open, label: t('orgRecord.tickets.tabs.open') });
    if (awaitingCustomer > 0) {
      metrics.push({ key: 'awaiting', value: awaitingCustomer, label: t('orgRecord.overview.fleet.awaitingCustomer') });
    }
    fleet.push({
      key: 'tickets',
      label: t('orgRecord.overview.tiles.tickets'),
      target: { tab: 'tickets' },
      metrics,
      note: metrics.length === 0 ? t('orgRecord.overview.fleet.noTickets') : undefined,
    });
  }

  const account: AccountStat[] = [];
  if (summary?.contracts) {
    account.push({
      key: 'contracts',
      label: t('orgRecord.overview.tiles.contracts'),
      target: { tab: 'billing' },
      value: formatNumber(summary.contracts.active),
      sub: summary.contracts.nextRenewalAt
        ? t('orgRecord.overview.tiles.contractsSub', { date: formatDate(summary.contracts.nextRenewalAt) })
        : t('orgRecord.overview.tiles.contractsNoRenewal'),
    });
  }
  if (summary?.invoices) {
    const outstanding = Number(summary.invoices.outstanding);
    const overdue = summary.invoices.overdueCount > 0;
    account.push({
      key: 'invoices',
      label: t('orgRecord.overview.account.invoices'),
      target: { tab: 'billing' },
      // The API sends a decimal STRING so cents survive the wire; only the
      // display crosses into float, and a malformed value degrades to the raw
      // string rather than rendering "NaN".
      value: Number.isFinite(outstanding)
        ? formatCurrency(outstanding, summary.invoices.currencyCode ?? 'USD')
        : summary.invoices.outstanding,
      sub: overdue
        ? t('orgRecord.overview.tiles.invoicesOverdue', { count: summary.invoices.overdueCount })
        : summary.invoices.nextDueAt
          ? t('orgRecord.overview.tiles.invoicesSub', { date: formatDate(summary.invoices.nextDueAt) })
          : t('orgRecord.overview.tiles.invoicesNothingDue'),
      subTone: overdue ? 'critical' : undefined,
    });
  }
  if (summary?.contacts) {
    account.push({
      key: 'contacts',
      label: t('orgRecord.overview.tiles.contacts'),
      target: { tab: 'contacts' },
      value: formatNumber(summary.contacts.count),
    });
  }
  if (summary?.portalUsers) {
    account.push({
      key: 'portalUsers',
      label: t('orgRecord.overview.tiles.portalUsers'),
      // Portal users are managed on the org's settings page, not a record tab.
      target: { href: `/settings/organizations/${encodeURIComponent(orgId)}#portal` },
      value: formatNumber(summary.portalUsers.count),
    });
  }

  // Filtered once, after every push, rather than guarding each push: a stat
  // added later cannot slip past the module gate by forgetting the condition —
  // it only has to be named in SERVICE_MANAGEMENT_STAT_KEYS to be covered.
  const moduleGate = <T extends { key: string }>(stats: T[]): T[] =>
    mode === 'native' ? stats : stats.filter((stat) => !SERVICE_MANAGEMENT_STAT_KEYS.has(stat.key));
  const visibleFleet = moduleGate(fleet);
  const visibleAccount = moduleGate(account);

  if (archived) {
    return (
      <div data-testid="org-overview-tab" className="space-y-6">
        <p data-testid="org-overview-archived-notice" className="text-sm text-muted-foreground">
          {t('orgRecord.overview.archivedNotice')}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="org-overview-tab" className="space-y-6">
      {summaryFailed && (
        <p data-testid="org-overview-summary-error" className="text-sm text-muted-foreground">
          {t('orgRecord.overview.noSummary')}
        </p>
      )}

      {visibleFleet.length > 0 && (
        <section data-testid="org-overview-fleet" aria-labelledby={fleetHeadingId} className="space-y-2">
          <h2 id={fleetHeadingId} className="text-sm font-semibold">
            {t('orgRecord.overview.fleet.title')}
          </h2>
          <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card md:flex-row md:divide-x md:divide-y-0">
            {visibleFleet.map((stat) => (
              <StatContainer
                key={stat.key}
                target={resolveTarget(stat.target)}
                testId={`org-overview-stat-${stat.key}`}
                className="block flex-1 px-4 py-3"
              >
                <span className="block text-xs font-medium text-muted-foreground">{stat.label}</span>
                <span className="mt-1 flex flex-wrap items-end gap-x-5 gap-y-1">
                  {stat.metrics.map((metric) => (
                    <span
                      key={metric.key}
                      data-testid={`org-overview-stat-${stat.key}-${metric.key}`}
                      className="flex flex-col"
                    >
                      <span
                        className={`text-lg font-semibold leading-tight tabular-nums ${metric.tone ? TONE_CLASS[metric.tone] : ''}`}
                      >
                        {formatNumber(metric.value)}
                      </span>
                      <span className="text-xs text-muted-foreground">{metric.label}</span>
                    </span>
                  ))}
                  {stat.note && <span className="pb-px text-sm text-muted-foreground">{stat.note}</span>}
                </span>
              </StatContainer>
            ))}
          </div>
        </section>
      )}

      <div data-testid="org-overview-account-tier" className="grid items-start gap-4 lg:grid-cols-3">
        {visibleAccount.length > 0 && (
          <section
            data-testid="org-overview-account"
            aria-labelledby={accountHeadingId}
            className="space-y-2 lg:col-span-2"
          >
            <h2 id={accountHeadingId} className="text-sm font-semibold">
              {t('orgBoard.lens.account')}
            </h2>
            <div className="grid grid-cols-1 gap-1 rounded-lg border bg-card p-1 sm:grid-cols-2 xl:grid-cols-4">
              {visibleAccount.map((stat) => (
                <StatContainer
                  key={stat.key}
                  target={resolveTarget(stat.target)}
                  testId={`org-overview-stat-${stat.key}`}
                  className="block rounded-md px-3 py-2"
                >
                  <span className="block text-xs text-muted-foreground">{stat.label}</span>
                  <span className="block text-sm font-semibold tabular-nums">{stat.value}</span>
                  {stat.sub && (
                    <span
                      className={`block text-xs ${stat.subTone ? TONE_CLASS[stat.subTone] : 'text-muted-foreground'}`}
                    >
                      {stat.sub}
                    </span>
                  )}
                </StatContainer>
              ))}
            </div>
          </section>
        )}
        <div className={visibleAccount.length > 0 ? undefined : 'lg:col-span-3'}>
          <OrgKeyDatesCard orgId={orgId} orgFetch={orgFetch} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section data-testid="org-overview-critical-alerts" className="rounded-lg border bg-card">
          <header className="flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-sm font-semibold">{t('orgRecord.overview.criticalAlerts.title')}</h2>
            <a className="text-xs text-primary hover:underline" href={`/alerts?orgId=${orgId}`}>
              {t('orgRecord.overview.criticalAlerts.viewAll')}
            </a>
          </header>
          {alerts === null ? (
            <div className="space-y-2 px-4 py-3">
              <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          ) : alerts === 'failed' ? (
            <div data-testid="org-overview-critical-alerts-failed" className="px-4 py-4 text-sm">
              <p className="text-muted-foreground">{t('orgRecord.overview.criticalAlerts.failed')}</p>
              <button type="button" onClick={() => void loadFeeds()} className="mt-2 text-xs text-primary hover:underline">
                {t('orgRecord.actions.retry')}
              </button>
            </div>
          ) : alerts.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('orgRecord.overview.criticalAlerts.empty')}</p>
          ) : (
            <ul className="divide-y">
              {alerts.map((alert) => (
                <li key={alert.id} className="px-4 py-2.5 text-sm">
                  <a className="font-medium hover:underline" href={`/alerts/${alert.id}`}>
                    {resolveAlertTitle(alert.title ?? alert.message, alert.deviceHostname, alert.id)}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {alert.deviceHostname && (
                      <>
                        <EntityLink kind="device" id={alert.deviceId ?? ''} name={alert.deviceHostname} />
                        {' · '}
                      </>
                    )}
                    {formatDateTime(alert.triggeredAt ?? alert.createdAt, FEED_TIME_FORMAT)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="org-overview-activity" className="rounded-lg border bg-card">
          <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2.5">
            <h2 className="text-sm font-semibold">{t('orgRecord.overview.activity.title')}</h2>
            <div className="flex items-center gap-3">
              {summary?.lastActivityAt && (
                <span className="text-xs text-muted-foreground">
                  {t('orgRecord.overview.lastActivity', {
                    date: formatDateTime(summary.lastActivityAt, FEED_TIME_FORMAT),
                  })}
                </span>
              )}
              {tabs.includes('activity') && (
                <HashLink
                  hash="activity"
                  data-testid="org-overview-activity-view-all"
                  className="text-xs text-primary hover:underline"
                >
                  {t('orgRecord.overview.activity.viewAll')}
                </HashLink>
              )}
            </div>
          </header>
          {activity === null ? (
            <div className="space-y-2 px-4 py-3">
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          ) : activity === 'failed' ? (
            <div data-testid="org-overview-activity-failed" className="px-4 py-4 text-sm">
              <p className="text-muted-foreground">{t('orgRecord.overview.activity.failed')}</p>
              <button type="button" onClick={() => void loadFeeds()} className="mt-2 text-xs text-primary hover:underline">
                {t('orgRecord.actions.retry')}
              </button>
            </div>
          ) : activity.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('orgRecord.overview.activity.empty')}</p>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto">
              {activity.map((row) => (
                <li key={row.id} className="px-4 py-2 text-sm">
                  <span className="font-medium">{formatAuditAction(row.action)}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[
                      row.userName ?? row.user?.name,
                      formatDateTime(row.timestamp ?? row.createdAt ?? '', FEED_TIME_FORMAT),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
