import { HardDrive } from 'lucide-react';
import type { BackupDeviceRow } from '@breeze/shared';
import { cn, formatDateTime } from '@/lib/utils';
import { CELL, EmptyState, ErrorNotice, ROW, TH } from './ui';

export function BackupDeviceTable({
  devices,
  total,
  error,
}: {
  devices: BackupDeviceRow[];
  total?: number;
  error?: string | null;
}) {
  if (error) {
    return (
      <div data-testid="portal-backup-device-error">
        <ErrorNotice>{error}</ErrorNotice>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <EmptyState
        data-testid="portal-backup-device-empty"
        icon={<HardDrive className="h-10 w-10" strokeWidth={1.5} />}
        title="No backup devices are available"
      >
        <p className="mt-1 text-sm text-muted-foreground">
          Your IT team has not linked any devices to backup data yet.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="mt-10 overflow-x-auto">
      <h2 className="mb-4 font-display text-xl font-semibold text-foreground">
        Device backup readiness
      </h2>
      {total !== undefined && (
        <p
          className="mb-4 text-sm text-muted-foreground"
          data-testid="portal-backup-device-count"
        >
          Showing {devices.length} of {total} devices
        </p>
      )}
      <table
        className="block w-full sm:table sm:min-w-[48rem]"
        data-testid="portal-backup-device-table"
      >
        <thead className="hidden border-b border-border sm:table-header-group">
          <tr>
            <th scope="col" className={cn(TH, 'text-left')}>Device</th>
            <th scope="col" className={cn(TH, 'text-left')}>Last restore point</th>
            <th scope="col" className={cn(TH, 'text-left')}>Last test restore</th>
            <th scope="col" className={cn(TH, 'text-left')}>Open breaches</th>
            <th scope="col" className={cn(TH, 'text-left')}>Readiness</th>
          </tr>
        </thead>
        <tbody className="block divide-y divide-border/70 sm:table-row-group">
          {devices.map((device) => (
            <tr
              key={device.id}
              className={ROW}
              data-testid={`portal-backup-device-${device.id}`}
            >
              <td className={cn(CELL, 'order-1 grow font-semibold text-foreground')}>
                {device.name}
              </td>
              {!device.configured ? (
                <td
                  className={cn(CELL, 'order-2 w-full text-sm text-muted-foreground')}
                  colSpan={4}
                >
                  No backup has run for this device yet
                </td>
              ) : (
                <>
                  <td className={cn(CELL, 'order-2 text-sm text-foreground')}>
                    <span className="sm:hidden">Last restore point </span>
                    {device.lastRestorePointAt
                      ? formatDateTime(device.lastRestorePointAt)
                      : 'No restore point is available'}
                    {device.lastRestorePointDegraded ? ' (degraded)' : ''}
                  </td>
                  <td className={cn(CELL, 'order-3 text-sm text-foreground')}>
                    <span className="sm:hidden">Last test restore </span>
                    {device.lastTestRestore
                      ? `${device.lastTestRestore.status} — ${device.lastTestRestore.completedAt ? formatDateTime(device.lastTestRestore.completedAt) : 'time unavailable'}`
                      : 'No test restore is available'}
                  </td>
                  <td className={cn(CELL, 'order-4 text-sm text-foreground')}>
                    <span className="sm:hidden">Open breaches </span>
                    {device.openBreaches.join(', ') || 'None'}
                  </td>
                  <td className={cn(CELL, 'order-5 text-sm text-foreground')}>
                    <span className="sm:hidden">Readiness </span>
                    {device.readinessScore ?? 'Not available'}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default BackupDeviceTable;
