import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { usePermissions } from '../../lib/permissions';
import { formatTimeAgo } from '@/lib/formatTime';
import { formatDateTime } from '@/lib/dateTimeFormat';
import ConnectDesktopButton from '../remote/ConnectDesktopButton';
import { formatIdle } from '../devices/DeviceUserIdleStat';
import { useTicketEndpoint, type TicketEndpoint } from './useTicketEndpoint';
import { TicketDeviceEditor } from './TicketDeviceEditor';

// Product names, the same in every language.
const OS_NAMES: Record<string, string> = { windows: 'Windows', macos: 'macOS', darwin: 'macOS', linux: 'Linux' };

const KNOWN_STATUSES = new Set(['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

// Severity is status: tint + ink, never colour alone (the word is printed).
const severityClass: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive-ink border-destructive/30',
  high: 'bg-warning/15 text-warning-ink border-warning/30',
  medium: 'bg-warning/10 text-warning-ink border-warning/20',
  low: 'bg-muted text-foreground/70 border-border dark:text-muted-foreground',
  info: 'bg-muted text-foreground/70 border-border dark:text-muted-foreground',
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface Props {
  deviceId: string | null;
  /** The ticket's own copy of the hostname: what we can always show. */
  deviceHostname: string | null;
  orgId: string;
  hasAssignee: boolean;
  /** Merged tombstone: no link/unlink. */
  readOnly: boolean;
  onLinkDevice: (deviceId: string) => void;
  onUnlinkDevice: () => void;
  /** The host's read of the device (useTicketEndpoint); omitted, the panel reads it. */
  endpoint?: TicketEndpoint;
}

/**
 * The machine beside the requester's words: is it up, who is signed in, what
 * is alerting, and a way in. Every read needs devices:read; Remote in also
 * needs remote:access (the server adds MFA). Degrades to the ticket's own
 * hostname when the caller cannot read the device.
 */
export default function TicketEndpointPanel({ deviceId, deviceHostname, orgId, hasAssignee, readOnly, onLinkDevice, onUnlinkDevice, endpoint }: Props) {
  const { t } = useTranslation('tickets');
  const { t: tDevices } = useTranslation('devices');
  const { t: tAlerts } = useTranslation('alerts');
  const { can } = usePermissions();
  const canReadDevice = can('devices', 'read');
  const canRemote = can('remote', 'access');

  // One read of the device, shared with the narrow-width endpoint line when
  // the host supplies it.
  const own = useTicketEndpoint(endpoint ? null : deviceId, canReadDevice);
  const { state, session, alerts } = endpoint ?? own;

  const editor = !readOnly && (
    <TicketDeviceEditor orgId={orgId} hasDevice={!!deviceId} hasAssignee={hasAssignee} onSelect={onLinkDevice} onUnlink={onUnlinkDevice} />
  );

  if (!deviceId) {
    return (
      <section className="space-y-1.5" data-testid="ticket-workbench-device" aria-label={t('common:labels.device')}>
        {deviceHostname ? (
          // A hostname with no device record (removed device, imported ticket): text, not a dead link.
          <p className="truncate text-sm">{deviceHostname}</p>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="ticket-endpoint-none">{t('ticketFocus.endpoint.noDevice')}</p>
        )}
        {editor}
      </section>
    );
  }

  const device = state.kind === 'ready' ? state.device : null;
  const hostname = device?.displayName ?? device?.hostname ?? deviceHostname ?? deviceId;
  const live = canReadDevice && state.kind !== 'denied';
  const status = device?.status && KNOWN_STATUSES.has(device.status) ? device.status : device ? 'unknown' : null;
  const online = status === 'online';
  const statusWord = status ? tDevices(/* i18n-dynamic */ `deviceList.statuses.full.${status}`) : null;
  const lastSeen = device?.lastSeenAt && !Number.isNaN(new Date(device.lastSeenAt).getTime()) ? device.lastSeenAt : null;
  const osName = device?.osType ? OS_NAMES[device.osType.toLowerCase()] ?? device.osType : null;
  // "Windows 11.0.22631"; a version that already names its OS is printed as is.
  const os = !device ? ''
    : device.osVersion && osName && device.osVersion.toLowerCase().startsWith(osName.toLowerCase()) ? device.osVersion
    : [osName, device.osVersion].filter(Boolean).join(' ');

  return (
    <section className="space-y-2" data-testid="ticket-workbench-device" aria-label={t('common:labels.device')}>
      {/* The name on its own line, wrapping to two before any ellipsis; the
          status line carries Remote in. */}
      <a
        href={`/devices/${deviceId}`}
        className="line-clamp-2 break-words text-sm font-medium text-foreground underline-offset-4 hover:underline"
        data-testid="ticket-workbench-device-link"
        title={hostname}
      >
        {hostname}
      </a>
      {device && (statusWord || (online && canRemote)) && (
        <div className="flex items-center justify-between gap-2" data-testid="ticket-endpoint-status-row">
          {statusWord && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs" data-testid="ticket-endpoint-status" data-status={status ?? undefined}>
              <span
                aria-hidden="true"
                className={cn('inline-block h-2 w-2 shrink-0 rounded-full', online ? 'bg-success' : status === 'offline' ? 'bg-muted-foreground' : 'bg-warning')}
              />
              <span className={cn('font-medium', online ? 'text-success-ink' : 'text-foreground')}>{statusWord}</span>
              {!online && lastSeen && (
                <span className="min-w-0 truncate text-muted-foreground" title={formatDateTime(lastSeen)}>
                  {'· '}{t('ticketFocus.endpoint.lastSeen', { ago: formatTimeAgo(lastSeen) })}
                </span>
              )}
            </p>
          )}
          {online && canRemote && (
            <ConnectDesktopButton
              deviceId={device.id}
              compact
              desktopAccess={device.desktopAccess}
              remoteAccessPolicy={device.remoteAccessPolicy}
              isHeadless={device.isHeadless}
              helperLifecycleMode={device.helperLifecycleMode}
            />
          )}
        </div>
      )}

      {live && state.kind === 'loading' && (
        <div className="space-y-1.5 animate-pulse" data-testid="ticket-endpoint-loading" aria-busy="true" aria-label={t('ticketFocus.endpoint.loading')}>
          <div className="h-3 w-2/3 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted/70" />
        </div>
      )}
      {live && state.kind === 'failed' && (
        <p className="text-xs text-muted-foreground" data-testid="ticket-endpoint-failed">{t('ticketFocus.endpoint.loadFailed')}</p>
      )}

      {device && (
        <dl className="space-y-1 text-xs">
          {os && (
            <div className="flex gap-2">
              <dt className="sr-only">{t('ticketFocus.endpoint.os')}</dt>
              <dd className="min-w-0 truncate text-muted-foreground" data-testid="ticket-endpoint-os">{os}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('ticketFocus.endpoint.signedIn')}</dt>
            <dd className="min-w-0 truncate" data-testid="ticket-endpoint-user">
              {session === null
                ? <span className="text-muted-foreground">…</span>
                : session.value
                  ? `${session.value.username} · ${formatIdle(session.value, tDevices)}`
                  : session.failed && device.lastUser
                    ? t('ticketFocus.endpoint.lastUser', { user: device.lastUser })
                    : <span className="text-muted-foreground">{t('ticketFocus.endpoint.nobodySignedIn')}</span>}
            </dd>
          </div>
          {device.uptimeSeconds !== null && online && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">{tDevices('deviceDetails.uptime')}</dt>
              <dd className="tabular-nums">{formatUptime(device.uptimeSeconds)}</dd>
            </div>
          )}
          {device.pendingReboot && (
            <p className="font-medium text-warning-ink" data-testid="ticket-endpoint-reboot">{tDevices('deviceList.rebootPending')}</p>
          )}
        </dl>
      )}

      {device && (
        <div>
          <h4 className="text-xs text-muted-foreground">{t('ticketFocus.endpoint.activeAlerts')}</h4>
          {alerts === null ? (
            <div className="mt-1 h-3 w-1/2 animate-pulse rounded bg-muted" />
          ) : alerts === 'failed' ? (
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="ticket-endpoint-alerts-failed">{t('ticketFocus.endpoint.alertsFailed')}</p>
          ) : alerts.length === 0 ? (
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="ticket-endpoint-no-alerts">{t('ticketFocus.endpoint.noAlerts')}</p>
          ) : (
            <ul className="mt-1 space-y-1" data-testid="ticket-endpoint-alerts">
              {alerts.map((a) => {
                const sev = SEVERITIES.has(a.severity) ? a.severity : 'info';
                return (
                  <li key={a.id} className="flex min-w-0 items-center gap-1.5 text-xs" data-testid={`ticket-endpoint-alert-${a.id}`}>
                    <span className={cn('inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 font-medium', severityClass[sev])}>
                      {tAlerts(/* i18n-dynamic */ `alertDetails.severity.${sev}`)}
                    </span>
                    <a href={`/alerts#${a.id}`} className="min-w-0 truncate hover:underline" title={a.title || undefined}>{a.title || t('ticketFocus.endpoint.untitledAlert')}</a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {editor}
    </section>
  );
}
