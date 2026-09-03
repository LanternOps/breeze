import React from 'react';
import { Download, Monitor } from 'lucide-react';
import { publicApiPath, type Device } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  BTN_SECONDARY,
  ROW,
  CELL,
  TH,
  PageHeader,
  StatusMark,
  EmptyState,
  ErrorNotice,
  type MarkTone,
} from './ui';

interface DeviceListProps {
  devices: Device[];
  error?: string | null;
}

// Local OS label for the customer's office manager, kept private rather than
// widening `@/lib/utils`, which the rest of the app shares.
const OS_LABELS: Record<string, string> = {
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
};

function osLabel(osType: string | null): string {
  if (!osType) return 'Unknown';
  return OS_LABELS[osType.toLowerCase()] ?? osType;
}

function lastSeenLabel(value: string | null): string {
  return value ?? 'Not known';
}

function statusMark(status: Device['status']): { tone: MarkTone; label: string } {
  switch (status) {
    case 'online':
      return { tone: 'success', label: 'Online' };
    case 'offline':
      return { tone: 'neutral', label: 'Offline' };
    case 'warning':
      return { tone: 'warning', label: 'Warning' };
    default:
      return { tone: 'neutral', label: status || 'Unknown' };
  }
}

export function DeviceList({ devices, error }: DeviceListProps) {
  if (error) {
    return <ErrorNotice>{error}</ErrorNotice>;
  }

  // The register's foot: what a glancing reader wants is one health sentence.
  const online = devices.filter((d) => d.status === 'online').length;
  const footLine =
    devices.length === 0
      ? null
      : online === devices.length
        ? devices.length === 1
          ? 'Your device is online'
          : `All ${devices.length} devices online`
        : `${online} of ${devices.length} online`;

  return (
    <div>
      <PageHeader
        title="Devices"
        lede="The machines your IT team looks after for you."
        action={
          <a
            href={publicApiPath('/portal/devices/export.csv')}
            data-testid="portal-devices-export"
            className={BTN_SECONDARY}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Export CSV
          </a>
        }
      />

      {devices.length === 0 ? (
        <EmptyState icon={<Monitor className="h-10 w-10" strokeWidth={1.5} />} title="No devices">
          <p className="mt-1 text-sm text-muted-foreground">
            Your IT team hasn't linked any devices to your account yet.
          </p>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          {/* One inventory, one treatment: the same hairline-ruled ledger the
              rest of the portal keeps (Equipment reads these machines the same
              way) — not a card grid holding a second belief about this data. */}
          <table
            className="block w-full sm:table sm:min-w-[70rem]"
            data-testid="portal-device-table"
          >
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Device
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Type
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Status
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Last online
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Last patch
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Protection
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Encryption
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Last backup
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Warranty ends
                </th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {devices.map((device) => {
                const mark = statusMark(device.status);
                return (
                  <tr
                    key={device.id}
                    className={ROW}
                    data-testid={`portal-device-${device.id}`}
                  >
                    {/* order-* reorders the phone card: name and status share
                        the first line, platform and last-seen trail muted. The
                        friendly name only — the raw hostname is a technician's
                        handle and stays the fallback, not a subtitle. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      <span className="font-semibold text-foreground">
                        {device.displayName || device.hostname}
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-3 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Type </span>
                      {osLabel(device.osType)}
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <StatusMark tone={mark.tone}>
                        {mark.label}
                      </StatusMark>
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Last online </span>
                      {lastSeenLabel(device.lastSeenAt)}
                    </td>
                    <td className={cn(CELL, 'order-5')}>
                      <span className="sm:hidden">Last patch </span>
                      {device.lastPatchAt ?? 'Not available'}
                    </td>
                    <td className={cn(CELL, 'order-6')}>
                      <span className="sm:hidden">Protection </span>
                      {device.protection[0].toUpperCase() + device.protection.slice(1)}
                    </td>
                    <td className={cn(CELL, 'order-7')}>
                      <span className="sm:hidden">Encryption </span>
                      {device.encryption ?? 'Not available'}
                    </td>
                    <td className={cn(CELL, 'order-8')}>
                      <span className="sm:hidden">Last backup </span>
                      {device.lastBackupAt ?? 'Not available'}
                    </td>
                    <td className={cn(CELL, 'order-9')}>
                      <span className="sm:hidden">Warranty ends </span>
                      {device.warrantyEndsAt ?? 'Not available'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {footLine && (
            <div
              className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
              data-testid="device-ledger-foot"
            >
              {footLine}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DeviceList;
