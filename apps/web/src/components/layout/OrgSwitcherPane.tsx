import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, CreditCard, LayoutDashboard, MapPin, Monitor, Ticket, type LucideIcon } from 'lucide-react';
import type { Organization } from '@/stores/orgStore';
import { formatAddress } from '@/lib/formatAddress';
import type { OrgSummary } from '@/components/organizations/record/orgRecordFetch';
import { OrgStatusBadge } from './OrgStatusGlyphs';
import { destinationTarget, type OrgSwitcherDestination } from './orgSwitcherDestinations';
import type { OrgSummaryStatus } from './useOrgSummaryCache';

export interface OrgSwitcherPaneProps {
  org: Organization;
  summary: OrgSummary | undefined;
  summaryStatus: OrgSummaryStatus;
  destinations: OrgSwitcherDestination[];
  onDestination: (orgId: string, target: string) => void;
}

const ICONS: Record<OrgSwitcherDestination, LucideIcon> = {
  overview: LayoutDashboard,
  devices: Monitor,
  tickets: Ticket,
  alerts: Bell,
  sites: MapPin,
  billing: CreditCard,
};

/** Destinations whose count is shown as a skeleton while the summary loads. */
const COUNTED: ReadonlySet<OrgSwitcherDestination> = new Set(['devices', 'tickets', 'alerts', 'sites']);

/**
 * The org switcher's right-hand pane: the highlighted org's status, billing
 * address, primary contact and six destinations with live counts. Pure — the
 * caller owns the data fetch and the switch itself.
 */
export default function OrgSwitcherPane({
  org,
  summary,
  summaryStatus,
  destinations,
  onDestination,
}: OrgSwitcherPaneProps) {
  const { t } = useTranslation('common');

  const address = formatAddress({
    line1: org.billingAddressLine1,
    line2: org.billingAddressLine2,
    city: org.billingAddressCity,
    region: org.billingAddressRegion,
    postalCode: org.billingAddressPostalCode,
    country: org.billingAddressCountry,
  });
  const contact = summary?.contacts?.primary;

  /** Plain text (for the accessible name) plus the styled node for display. */
  function countFor(dest: OrgSwitcherDestination): { text: string; node: ReactNode } | null {
    if (summaryStatus !== 'ready' || !summary) return null;
    switch (dest) {
      case 'devices': {
        if (!summary.devices) return null;
        const { total, offline } = summary.devices;
        const offlineText = t('layout.org.pane.offlineCount', { count: offline });
        return {
          text: `${total} · ${offlineText}`,
          node: (
            <>
              {total} · <span className={offline > 0 ? 'text-warning-strong' : undefined}>{offlineText}</span>
            </>
          ),
        };
      }
      case 'tickets': {
        if (!summary.tickets) return null;
        const text = t('layout.org.pane.openCount', { count: summary.tickets.open });
        return { text, node: text };
      }
      case 'alerts': {
        if (!summary.alerts) return null;
        const text =
          summary.alerts.critical > 0
            ? t('layout.org.pane.criticalCount', { count: summary.alerts.critical })
            : t('layout.org.pane.noCritical');
        return { text, node: text };
      }
      case 'sites': {
        const text = String(summary.sites.count);
        return { text, node: text };
      }
      default:
        return null;
    }
  }

  return (
    <div data-testid="org-switcher-pane" className="flex flex-col gap-2 py-1">
      <div className="space-y-1 px-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{org.name}</span>
          <OrgStatusBadge status={org.status} />
        </div>
        {address !== '' && (
          <p data-testid="org-switcher-pane-address" className="text-xs text-muted-foreground">
            {address}
          </p>
        )}
        {contact && (
          <p data-testid="org-switcher-pane-contact" className="text-xs text-muted-foreground">
            {contact.name !== '' && <span>{contact.name}</span>}
            {contact.name !== '' && contact.phone ? ' · ' : null}
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="underline-offset-2 hover:underline">
                {contact.phone}
              </a>
            )}
          </p>
        )}
      </div>

      <div className="space-y-0.5">
        {destinations.map((dest) => {
          const Icon = ICONS[dest];
          const label = t(/* i18n-dynamic */ `layout.org.pane.destinations.${dest}`);
          const count = countFor(dest);
          const showSkeleton = summaryStatus === 'loading' && COUNTED.has(dest);
          return (
            <button
              key={dest}
              type="button"
              data-testid={`org-switcher-dest-${dest}`}
              aria-label={[label, org.name, count?.text].filter(Boolean).join(', ')}
              onClick={() => onDestination(org.id, destinationTarget(dest, org.id))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{label}</span>
              {showSkeleton && (
                <span
                  data-testid="org-switcher-count-skeleton"
                  aria-hidden="true"
                  className="h-3 w-10 animate-pulse rounded bg-muted"
                />
              )}
              {count && (
                <span
                  data-testid={`org-switcher-count-${dest}`}
                  className={
                    dest === 'alerts' && summary?.alerts && summary.alerts.critical > 0
                      ? 'text-xs text-destructive'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {count.node}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p data-testid="org-switcher-hint" className="px-1 text-[11px] text-muted-foreground">
        {t('layout.org.pane.hint')}
      </p>
    </div>
  );
}
