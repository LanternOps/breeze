import { HardDrive } from 'lucide-react';
import type { BackupDeviceRow } from '@breeze/shared';
import { cn, formatDateTime } from '@/lib/utils';
import { CELL, EmptyState, ErrorNotice, ROW, StatusMark, TH } from './ui';
import { humanizeStatus, testRestoreMark } from './BackupOverview';

/**
 * The SLA worker's event types, said the way the customer's office manager
 * would say them (services/portal/backupReadModel.ts sends the raw
 * `backup_sla_events.event_type`). An acronym explains nothing to this reader.
 */
const BREACH_LABELS: Record<string, string> = {
  rpo_breach: 'Backup behind schedule',
  missed_backup: 'Backup missed',
  rto_breach: 'Restore slower than promised',
};

function breachLabel(eventType: string): string {
  return BREACH_LABELS[eventType.trim().toLowerCase()] ?? humanizeStatus(eventType);
}

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
            <th scope="col" className={cn(TH, 'text-left')}>Last backup</th>
            <th scope="col" className={cn(TH, 'text-left')}>Last restore test</th>
            <th scope="col" className={cn(TH, 'text-left')}>Needs attention</th>
            <th scope="col" className={cn(TH, 'text-left')}>Recovery readiness</th>
          </tr>
        </thead>
        <tbody className="block divide-y divide-border/70 sm:table-row-group">
          {devices.map((device) => {
            const restoreTest = device.lastTestRestore
              ? testRestoreMark(device.lastTestRestore.status)
              : null;
            return (
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
                      <span className="sm:hidden">Last backup </span>
                      {device.lastRestorePointAt
                        ? formatDateTime(device.lastRestorePointAt)
                        : 'No backup has run yet'}
                      {device.lastRestorePointDegraded ? ' (degraded)' : ''}
                    </td>
                    <td className={cn(CELL, 'order-3 text-sm text-foreground')}>
                      <span className="sm:hidden">Last restore test </span>
                      {device.lastTestRestore && restoreTest ? (
                        <span className="inline-flex flex-wrap items-baseline gap-x-2">
                          {/* The row's one mark: a raw "passed" carried no tone
                              and a "failed" read exactly as calmly. */}
                          <StatusMark tone={restoreTest.tone}>{restoreTest.label}</StatusMark>
                          <span>
                            {device.lastTestRestore.completedAt
                              ? formatDateTime(device.lastTestRestore.completedAt)
                              : 'Time not available'}
                          </span>
                        </span>
                      ) : (
                        'No restore test has run yet'
                      )}
                    </td>
                    <td className={cn(CELL, 'order-4 text-sm text-foreground')}>
                      <span className="sm:hidden">Needs attention </span>
                      {device.openBreaches.map(breachLabel).join(', ') || 'None'}
                    </td>
                    <td className={cn(CELL, 'order-5 text-sm text-foreground')}>
                      <span className="sm:hidden">Recovery readiness </span>
                      {device.readinessScore ?? 'Not available'}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default BackupDeviceTable;
