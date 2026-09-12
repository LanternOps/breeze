import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Monitor, Receipt, ScrollText, Ticket, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatDateTime } from '@/lib/dateTimeFormat';
import { formatCurrency, formatNumber } from '@/lib/i18n/format';
import { useAuditActionFormatter } from '@/lib/auditFormat';
import type { AlertRow, AuditLogEntry } from '@/components/dashboard/types';
import OrgKeyDatesCard from './OrgKeyDatesCard';
import { useLatest, type OrgFetch, type OrgSummary } from './orgRecordFetch';
import type { ServiceManagementMode } from './orgRecordTabs';

export interface OrgOverviewTabProps {
  orgId: string;
  orgFetch: OrgFetch;
  summary: OrgSummary | null;
  summaryFailed: boolean;
  /**
   * The partner's Service Management mode (#5075 W04). Anything but `native`
   * withdraws the three tiles the module owns.
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
}

/** Tiles owned by the Service Management module; hidden unless mode is `native`. */
const SERVICE_MANAGEMENT_TILE_KEYS: ReadonlySet<string> = new Set(['tickets', 'contracts', 'invoices']);

interface Tile {
  key: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}

const CRITICAL_ALERTS_PATH = '/alerts?status=active&severity=critical&limit=10';
const RECENT_ACTIVITY_PATH = '/audit-logs/logs?limit=20&skipCount=true';

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
 * summary tiles deliberately avoid by omitting a section rather than showing a
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

/**
 * The record's landing tab: the counts an MSP tech needs before opening a
 * customer's ticket, plus the two feeds that answer "what has been happening
 * here".
 *
 * A tile whose summary section is ABSENT is not rendered at all — the section
 * is missing because the caller lacks the read permission, and a "0" there
 * would be a confident lie about a customer's fleet. The two feeds below hold
 * the same line: a failed load says so, rather than rendering the empty state.
 */
export default function OrgOverviewTab({ orgId, orgFetch, summary, summaryFailed, mode = 'native' }: OrgOverviewTabProps) {
  const { t } = useTranslation('organizations');
  const formatAuditAction = useAuditActionFormatter();
  const [activity, setActivity] = useState<FeedState<AuditLogEntry>>(null);
  const [alerts, setAlerts] = useState<FeedState<AlertRow>>(null);
  const activityLatest = useLatest<AuditLogEntry[] | 'failed'>();
  const alertsLatest = useLatest<AlertRow[] | 'failed'>();

  const loadFeeds = useCallback(async () => {
    // The two feeds are independent: one failing (a tech without audit:read
    // gets a 403 on activity) must leave the other, and the tiles, intact.
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
    void loadFeeds();
  }, [loadFeeds, orgId]);

  const tiles: Tile[] = [];
  if (summary?.devices) {
    tiles.push({
      key: 'devices',
      icon: <Monitor className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.devices'),
      value: formatNumber(summary.devices.total),
      sub: t('orgRecord.overview.tiles.devicesSub', {
        online: formatNumber(summary.devices.online),
        total: formatNumber(summary.devices.total),
      }),
    });
  }
  if (summary?.alerts) {
    tiles.push({
      key: 'alerts',
      icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.alerts'),
      value: formatNumber(summary.alerts.open),
      sub: t('orgRecord.overview.tiles.alertsSub', {
        critical: formatNumber(summary.alerts.critical),
        high: formatNumber(summary.alerts.high),
      }),
    });
  }
  if (summary?.tickets) {
    tiles.push({
      key: 'tickets',
      icon: <Ticket className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.tickets'),
      value: formatNumber(summary.tickets.open),
      sub: t('orgRecord.overview.tiles.ticketsSub', { count: summary.tickets.awaitingCustomer }),
    });
  }
  if (summary?.contracts) {
    tiles.push({
      key: 'contracts',
      icon: <ScrollText className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.contracts'),
      value: formatNumber(summary.contracts.active),
      sub: summary.contracts.nextRenewalAt
        ? t('orgRecord.overview.tiles.contractsSub', { date: formatDate(summary.contracts.nextRenewalAt) })
        : t('orgRecord.overview.tiles.contractsNoRenewal'),
    });
  }
  if (summary?.invoices) {
    const outstanding = Number(summary.invoices.outstanding);
    tiles.push({
      key: 'invoices',
      icon: <Receipt className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.invoices'),
      // The API sends a decimal STRING so cents survive the wire; only the
      // display crosses into float, and a malformed value degrades to the raw
      // string rather than rendering "NaN".
      value: Number.isFinite(outstanding)
        ? formatCurrency(outstanding, summary.invoices.currencyCode ?? 'USD')
        : summary.invoices.outstanding,
      sub:
        summary.invoices.overdueCount > 0
          ? t('orgRecord.overview.tiles.invoicesOverdue', { count: summary.invoices.overdueCount })
          : summary.invoices.nextDueAt
            ? t('orgRecord.overview.tiles.invoicesSub', { date: formatDate(summary.invoices.nextDueAt) })
            : t('orgRecord.overview.tiles.invoicesNothingDue'),
    });
  }
  if (summary?.contacts) {
    tiles.push({
      key: 'contacts',
      icon: <Users className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.contacts'),
      value: formatNumber(summary.contacts.count),
    });
  }
  if (summary?.portalUsers) {
    tiles.push({
      key: 'portalUsers',
      icon: <Users className="h-4 w-4" aria-hidden="true" />,
      label: t('orgRecord.overview.tiles.portalUsers'),
      value: formatNumber(summary.portalUsers.count),
    });
  }

  // Filtered once, after every push, rather than guarding each push: a tile
  // added later cannot slip past the module gate by forgetting the condition —
  // it only has to be named in SERVICE_MANAGEMENT_TILE_KEYS to be covered.
  const visibleTiles = mode === 'native' ? tiles : tiles.filter((tile) => !SERVICE_MANAGEMENT_TILE_KEYS.has(tile.key));

  return (
    <div data-testid="org-overview-tab" className="space-y-6">
      {summaryFailed && (
        <p data-testid="org-overview-summary-error" className="text-sm text-muted-foreground">
          {t('orgRecord.overview.noSummary')}
        </p>
      )}

      {visibleTiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visibleTiles.map((tile) => (
            <div
              key={tile.key}
              data-testid={`org-overview-tile-${tile.key}`}
              className="rounded-lg border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {tile.icon}
                {tile.label}
              </div>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</p>
              {tile.sub && <p className="mt-0.5 text-xs text-muted-foreground">{tile.sub}</p>}
            </div>
          ))}
        </div>
      )}

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
                    {alert.title ?? alert.message ?? alert.id}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[alert.deviceHostname, formatDateTime(alert.triggeredAt ?? alert.createdAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="org-overview-activity" className="rounded-lg border bg-card">
          <header className="flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-sm font-semibold">{t('orgRecord.overview.activity.title')}</h2>
            {summary?.lastActivityAt && (
              <span className="text-xs text-muted-foreground">
                {t('orgRecord.overview.lastActivity', { date: formatDateTime(summary.lastActivityAt) })}
              </span>
            )}
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
                    {[row.userName ?? row.user?.name, formatDateTime(row.timestamp ?? row.createdAt ?? '')]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <OrgKeyDatesCard orgId={orgId} orgFetch={orgFetch} />
      </div>
    </div>
  );
}
