import type { DashboardDto, TileStatus } from '@breeze/shared';
import type { ReactNode } from 'react';
import { PageHeader } from './ui';
import { Sparkline } from './Sparkline';

function Tile({
  testId,
  title,
  status,
  children,
}: {
  testId: string;
  title: string;
  status: TileStatus;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="mt-2">{children}</div>
      {status === 'stale' && (
        <p className="mt-2 text-xs text-muted-foreground">Data may be stale.</p>
      )}
    </section>
  );
}

export function DashboardTiles({ dashboard }: { dashboard: DashboardDto }) {
  const unavailable = (
    status: TileStatus,
    noDataCopy: string,
    notConfiguredCopy: string,
  ) =>
    status === 'not_configured'
      ? notConfiguredCopy
      : noDataCopy;

  return (
    <div>
      <PageHeader title="Dashboard" lede={`Current as of ${dashboard.timezone}.`} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Tile
          testId="portal-dashboard-tile-security"
          title="Security score"
          status={dashboard.securityScore.status}
        >
          {dashboard.securityScore.score == null
            ? unavailable(
                dashboard.securityScore.status,
                'No security score is available',
                'Security scoring is not configured',
              )
            : <>
                <strong>{dashboard.securityScore.score}</strong>{' '}
                {dashboard.securityScore.band}
                <Sparkline
                  values={dashboard.securityScore.delta30d == null
                    ? [dashboard.securityScore.score]
                    : [
                        dashboard.securityScore.score - dashboard.securityScore.delta30d,
                        dashboard.securityScore.score,
                      ]}
                  label="Security score, 30-day change"
                />
              </>}
        </Tile>

        <Tile
          testId="portal-dashboard-tile-devices"
          title="Devices protected"
          status={dashboard.devicesProtected.status}
        >
          {dashboard.devicesProtected.protected == null || dashboard.devicesProtected.total == null
            ? unavailable(
                dashboard.devicesProtected.status,
                'No device protection data is available',
                'Device protection is not configured',
              )
            : `${dashboard.devicesProtected.protected} of ${dashboard.devicesProtected.total}`}
        </Tile>

        <Tile
          testId="portal-dashboard-tile-patches"
          title="Patches applied this month"
          status={dashboard.patchesApplied.status}
        >
          {dashboard.patchesApplied.applied == null
            ? unavailable(
                dashboard.patchesApplied.status,
                'No patch data is available',
                'Patch reporting is not configured',
              )
            : dashboard.patchesApplied.applied}
        </Tile>

        <Tile
          testId="portal-dashboard-tile-backup"
          title="Last backup verified"
          status={dashboard.backup.status}
        >
          {dashboard.backup.status === 'not_configured'
            ? 'Backups are not configured'
            : dashboard.backup.completedAt == null
              ? 'No verification data is available'
              : `${dashboard.backup.completedAt} (${dashboard.timezone})`}
        </Tile>

        <Tile
          testId="portal-dashboard-tile-support"
          title="Support"
          status={dashboard.support.status}
        >
          {dashboard.support.openTickets == null
            ? unavailable(
                dashboard.support.status,
                'No support data is available',
                'Support reporting is not configured',
              )
            : `${dashboard.support.openTickets} open`}
        </Tile>

        <Tile
          testId="portal-dashboard-tile-action-items"
          title="Action items"
          status={dashboard.actionItems.status}
        >
          {dashboard.actionItems.count == null
            ? unavailable(
                dashboard.actionItems.status,
                'No action-item data is available',
                'Action-item reporting is not configured',
              )
            : dashboard.actionItems.count}
        </Tile>

        <Tile
          testId="portal-dashboard-tile-awaiting-you"
          title="Awaiting you"
          status={dashboard.awaitingYou.status}
        >
          {dashboard.awaitingYou.proposals == null && dashboard.awaitingYou.invoices == null
            ? unavailable(
                dashboard.awaitingYou.status,
                'No awaiting-you data is available',
                'Awaiting-you reporting is not configured',
              )
            : <>
                {dashboard.awaitingYou.proposals == null
                  ? 'Proposal count unavailable'
                  : `${dashboard.awaitingYou.proposals} proposals`}
                {' · '}
                {dashboard.awaitingYou.invoices == null
                  ? 'Invoice count unavailable'
                  : `${dashboard.awaitingYou.invoices} invoices`}
              </>}
        </Tile>
      </div>
    </div>
  );
}
