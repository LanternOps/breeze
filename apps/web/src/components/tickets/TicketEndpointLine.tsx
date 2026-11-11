import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/formatTime';
import ConnectDesktopButton from '../remote/ConnectDesktopButton';
import type { TicketEndpoint } from './useTicketEndpoint';

interface Props {
  deviceId: string;
  deviceHostname: string | null;
  endpoint: TicketEndpoint;
  canRemote: boolean;
  /** The line is a way to the full panel on the Details tab. */
  onOpenDetails: () => void;
}

const KNOWN_STATUSES = new Set(['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']);

/**
 * Below 1024px the situation column is a tab away; this one line keeps the
 * machine beside the requester's words: up or down, who is signed in, how
 * much is alerting, and Remote in.
 */
export default function TicketEndpointLine({ deviceId, deviceHostname, endpoint, canRemote, onOpenDetails }: Props) {
  const { t } = useTranslation('tickets');
  const { t: tDevices } = useTranslation('devices');
  const device = endpoint.state.kind === 'ready' ? endpoint.state.device : null;
  const name = device?.displayName ?? device?.hostname ?? deviceHostname ?? deviceId;
  const status = device?.status && KNOWN_STATUSES.has(device.status) ? device.status : null;
  const online = status === 'online';
  const lastSeen = device?.lastSeenAt && !Number.isNaN(new Date(device.lastSeenAt).getTime()) ? device.lastSeenAt : null;
  const user = endpoint.session?.value?.username ?? null;
  const alertCount = Array.isArray(endpoint.alerts) ? endpoint.alerts.length : 0;
  // The count takes the colour of its worst alert (status colour for status).
  const severities = Array.isArray(endpoint.alerts) ? endpoint.alerts.map((a) => a.severity) : [];
  const alertTone = severities.includes('critical') ? 'text-destructive-ink'
    : severities.some((v) => v === 'high' || v === 'medium') ? 'text-warning-ink'
    : 'text-foreground';

  // Order by what must survive a narrow line: the device, then the alert
  // count (never truncated), then up/down, then who is signed in (cut first).
  const parts: string[] = [];
  if (status) parts.push(tDevices(/* i18n-dynamic */ `deviceList.statuses.full.${status}`));
  if (device && online && endpoint.session) parts.push(user ? t('ticketFocus.endpoint.userSignedIn', { user }) : t('ticketFocus.endpoint.nobodySignedIn'));
  if (device && !online && lastSeen) parts.push(formatTimeAgo(lastSeen));

  return (
    <div className="-my-1 flex min-w-0 items-center gap-2 text-xs" data-testid="ticket-endpoint-line">
      <button
        type="button"
        onClick={onOpenDetails}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        title={t('ticketFocus.endpoint.openDetails', { device: name })}
        data-testid="ticket-endpoint-line-open"
      >
        <span
          aria-hidden="true"
          className={cn('inline-block h-2 w-2 shrink-0 rounded-full', online ? 'bg-success' : status === 'offline' ? 'bg-muted-foreground' : status ? 'bg-warning' : 'bg-border')}
        />
        <span className="min-w-0 max-w-[50%] shrink truncate font-medium text-foreground">{name}</span>
        {alertCount > 0 && (
          <span className={cn('shrink-0 font-medium', alertTone)} data-testid="ticket-endpoint-line-alerts">
            · {t('ticketFocus.endpoint.alertCount', { count: alertCount })}
          </span>
        )}
        {parts.length > 0 && (
          <span className="min-w-0 truncate text-muted-foreground" data-testid="ticket-endpoint-line-state">
            {parts.map((p) => `· ${p}`).join(' ')}
          </span>
        )}
      </button>
      {device && online && canRemote && (
        <ConnectDesktopButton
          deviceId={device.id}
          iconOnly
          className="shrink-0 rounded-md border"
          desktopAccess={device.desktopAccess}
          remoteAccessPolicy={device.remoteAccessPolicy}
          isHeadless={device.isHeadless}
          helperLifecycleMode={device.helperLifecycleMode}
        />
      )}
    </div>
  );
}
