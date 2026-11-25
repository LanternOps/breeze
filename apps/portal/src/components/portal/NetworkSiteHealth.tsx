import type { NetworkAssetAlertSeverity, NetworkSiteHealthDto, NetworkSiteHealthRowDto } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { CELL, LINK, ROW, TH } from './ui';

/**
 * Per-site health summary for /network (CPEV-W2), between the overview ledger
 * and the asset register. Server-rendered only: no hooks, no `client:`. A site
 * name links to `#site=<id>`, the hash the asset table already understands
 * (NetworkAssetTable reads it on mount and on `hashchange`).
 *
 * The alert columns exist only when the API sent them (the org's alert flag is
 * on). An absent field means "flag off", so it is never shown as zero.
 */

const PHONE_LABEL =
  'mb-0.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:hidden';
const NUM = 'text-figures text-sm text-foreground';
const QUIET = 'text-sm text-muted-foreground';

const SEVERITY_LABELS: Record<NetworkAssetAlertSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const hasAlertFields = (rows: ReadonlyArray<NetworkSiteHealthRowDto>) =>
  rows.some((r) => r.activeAlertCount !== undefined);

/** Dash, not a made-up value, when the site has no alert to rank. */
function severityLabel(row: NetworkSiteHealthRowDto): string {
  return row.highestAlertSeverity ? SEVERITY_LABELS[row.highestAlertSeverity] : '—';
}

export function NetworkSiteHealth({ health }: { health: NetworkSiteHealthDto }) {
  if (health.dataStatus !== 'ok' || health.data.length === 0) return null;

  const rows = health.data;
  const showAlerts = hasAlertFields(rows);

  return (
    <section className="mt-10" data-testid="portal-network-site-health">
      <h2 className="mb-4 font-display text-lg font-semibold text-foreground">Sites</h2>

      <div className="overflow-x-auto">
        <table className="block w-full sm:table sm:min-w-[48rem]">
          <thead className="hidden border-b border-border sm:table-header-group">
            <tr>
              <th scope="col" className={cn(TH, 'text-left')}>Site</th>
              <th scope="col" className={cn(TH, 'text-left')}>Assets</th>
              <th scope="col" className={cn(TH, 'text-left')}>Online</th>
              <th scope="col" className={cn(TH, 'text-left')}>Offline</th>
              <th scope="col" className={cn(TH, 'text-left')}>Unverified</th>
              <th scope="col" className={cn(TH, 'text-left')}>SNMP polling</th>
              <th scope="col" className={cn(TH, 'text-left')}>Monitors down</th>
              {showAlerts && (
                <>
                  <th scope="col" className={cn(TH, 'text-left')}>Active alerts</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Highest severity</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="block divide-y divide-border/70 sm:table-row-group">
            {rows.map((r) => (
              <tr key={r.siteId} className={ROW} data-testid="portal-network-site-health-row">
                {/* No `order-*` on any cell: ROW is a wrapping flex on phones, so an
                    order on the name alone would push it after the figures. The DOM
                    already puts the name first. */}
                <td className={cn(CELL, 'grow font-semibold text-foreground')}>
                  <a
                    className={LINK}
                    href={`#site=${encodeURIComponent(r.siteId)}`}
                    data-testid="portal-network-site-health-link"
                  >
                    {r.siteName}
                  </a>
                </td>
                <td className={cn(CELL, NUM)}>
                  <span className={PHONE_LABEL}>Assets</span>
                  {r.totalAssets}
                </td>
                <td className={cn(CELL, NUM)}>
                  <span className={PHONE_LABEL}>Online</span>
                  {r.onlineAssets}
                </td>
                <td className={cn(CELL, NUM)}>
                  <span className={PHONE_LABEL}>Offline</span>
                  {r.offlineAssets}
                </td>
                <td className={cn(CELL, NUM)}>
                  <span className={PHONE_LABEL}>Unverified</span>
                  {r.unverifiedAssets}
                </td>
                <td className={cn(CELL, NUM)}>
                  <span className={PHONE_LABEL}>SNMP polling</span>
                  {r.snmpDevicesPolling}
                </td>
                <td className={cn(CELL, NUM)}>
                  <span className={PHONE_LABEL}>Monitors down</span>
                  {r.monitorsDown}
                </td>
                {showAlerts && (
                  <>
                    <td className={cn(CELL, NUM)}>
                      <span className={PHONE_LABEL}>Active alerts</span>
                      {r.activeAlertCount ?? '—'}
                    </td>
                    <td className={cn(CELL, 'text-sm text-foreground')}>
                      <span className={PHONE_LABEL}>Highest severity</span>
                      {severityLabel(r)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Same caveat as the overview, plus: a site is listed only when it has
          discovered assets and some monitors belong to no site, so the rows
          add up to at most the overview, never necessarily to it. */}
      <p
        className={`border-t border-border/70 pt-4 ${QUIET}`}
        data-testid="portal-network-site-health-footnote"
      >
        Online and offline counts exclude unverified assets. Site figures add up to at most the
        totals above, not necessarily to them.
      </p>
    </section>
  );
}

export default NetworkSiteHealth;
