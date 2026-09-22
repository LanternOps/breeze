import type { NetworkOverviewDto } from '@breeze/shared';
import { PageHeader } from './ui';

/**
 * Network is a page of the Guest Ledger, not a wall of cards: the standing
 * figures are ruled line by line, the way the dashboard and backups pages
 * rule their own (DashboardTiles, BackupOverview). Nothing here is boxed —
 * hairlines carry the structure (apps/portal/DESIGN.md, "data is never
 * boxed").
 */

const LABEL = 'text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const FIGURE = 'text-figures font-display text-lg font-semibold text-foreground';
const QUIET = 'text-sm text-muted-foreground';

function Figure({ value }: { value: number }) {
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
  children: React.ReactNode;
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

/**
 * `dataStatus: 'not_enabled'` never reaches this component — the page
 * redirects to the portal home before rendering it (network/index.astro).
 * Only `ok` and `no_data` are handled here.
 */
export function NetworkOverview({ overview }: { overview: NetworkOverviewDto }) {
  if (overview.dataStatus !== 'ok') {
    return (
      <section data-testid="portal-network-overview">
        <PageHeader
          title="Network"
          lede="Reachability and monitoring status for your network assets."
        />
        <p className="border-y border-border/70 py-4 text-sm text-muted-foreground" data-testid="portal-network-overview-empty">
          No network assets have been discovered yet.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="portal-network-overview">
      <PageHeader
        title="Network"
        lede="Reachability and monitoring status for your network assets."
      />

      <dl
        className="divide-y divide-border/70 border-t border-border/70"
        data-testid="portal-network-overview-summary"
      >
        <LedgerRow testId="portal-network-overview-total" label="Total assets">
          <Figure value={overview.totalAssets} />
        </LedgerRow>

        <LedgerRow testId="portal-network-overview-online" label="Online (verified)">
          <Figure value={overview.onlineAssets} />
        </LedgerRow>

        <LedgerRow testId="portal-network-overview-offline" label="Offline (verified)">
          <Figure value={overview.offlineAssets} />
        </LedgerRow>

        <LedgerRow testId="portal-network-overview-snmp-polling" label="SNMP devices polling">
          <Figure value={overview.snmpDevicesPolling} />
        </LedgerRow>

        <LedgerRow testId="portal-network-overview-monitors-down" label="Monitors down">
          <Figure value={overview.monitorsDown} />
        </LedgerRow>
      </dl>

      {/* Online + offline never sums to the total: an asset whose reachability
          hasn't been verified counts in neither row, so the two figures above
          must never be read as though they add up to it. */}
      <p className={`border-t border-border/70 pt-4 ${QUIET}`} data-testid="portal-network-overview-footnote">
        Online and offline counts exclude unverified assets, so they may not add up to the
        total above.
      </p>
    </section>
  );
}

export default NetworkOverview;
