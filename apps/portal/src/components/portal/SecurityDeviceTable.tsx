import type { ReactNode } from 'react';
import type { SecurityDeviceRow } from '@breeze/shared';
import { ChevronDown, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ROW, CELL, TH, StatusMark, EmptyState, type MarkTone } from './ui';

/**
 * The security ledger, read by an office manager rather than a technician.
 * Four columns carry the answer to "is this machine looked after" — the rest
 * of the evidence stays one tap away per row, so the phone card and the desk
 * table hold the same four facts.
 */

const showSwitch = (value: boolean | null) =>
  value == null ? 'Not known' : value ? 'On' : 'Off';

const ENCRYPTION_LABELS: Record<string, string> = {
  encrypted: 'Encrypted',
  unencrypted: 'Not encrypted',
  not_encrypted: 'Not encrypted',
  partial: 'Partly encrypted',
  unknown: 'Not known',
};

function encryptionLabel(value: string | null): string {
  if (!value) return 'Not known';
  const key = value.toLowerCase();
  return (
    ENCRYPTION_LABELS[key] ??
    key.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase())
  );
}

function definitionsLabel(days: number | null): string {
  if (days == null) return 'Not known';
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  return `${days} days old`;
}

function protectionMark(state: SecurityDeviceRow['protection']): {
  tone: MarkTone;
  label: string;
} {
  switch (state) {
    case 'protected':
      return { tone: 'success', label: 'Protected' };
    case 'unprotected':
      return { tone: 'destructive', label: 'Not protected' };
    default:
      return { tone: 'neutral', label: 'Not known' };
  }
}

/** One reading of when we last heard from the machine. The formatted string
 *  already names the zone ("6:00 AM MDT"); repeating it read as a stutter. */
function showObservedAt(value: string | null, timezone: string): string {
  if (value == null) return 'Not known';
  const observedAt = new Date(value);
  if (Number.isNaN(observedAt.getTime())) return 'Not known';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(observedAt);
}

function DeviceFact({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-xs text-foreground" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

export function SecurityDeviceTable({
  devices,
  timezone,
  total,
}: {
  devices: SecurityDeviceRow[];
  timezone: string;
  /** Fleet size behind the first page, so the foot can say what is missing. */
  total?: number;
}) {
  const fleetTotal = total ?? devices.length;
  const protectedCount = devices.filter((d) => d.protection === 'protected').length;
  const footLine =
    protectedCount === devices.length
      ? devices.length === 1
        ? 'Your device is protected'
        : `All ${devices.length} devices protected`
      : `${protectedCount} of ${devices.length} devices protected`;
  const capLine = `Showing the first ${devices.length} of ${fleetTotal} devices`;

  return (
    <section className="mt-10">
      <h2 className="font-display text-lg font-semibold text-foreground">Your devices</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        How each machine is looked after right now.
      </p>

      {devices.length === 0 ? (
        <EmptyState
          className="mt-4"
          data-testid="portal-security-devices-empty"
          icon={<Monitor className="h-10 w-10" strokeWidth={1.5} />}
          title="No devices yet"
        >
          <p className="mt-1 text-sm text-muted-foreground">
            Your IT team hasn't linked any devices to your account yet.
          </p>
        </EmptyState>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table
            className="block w-full sm:table sm:min-w-[44rem]"
            data-testid="portal-security-device-table"
          >
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Device
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Protection
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Encryption
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Last checked
                </th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {devices.map((device) => {
                const mark = protectionMark(device.protection);
                return (
                  <tr
                    key={device.id}
                    className={ROW}
                    data-testid={`portal-security-device-${device.id}`}
                  >
                    {/* Name and protection share the phone card's first line;
                        a long hostname wraps rather than pushing the row wide. */}
                    <td className={cn(CELL, 'order-1 min-w-0 grow')}>
                      <span
                        className="block break-words font-semibold text-foreground"
                        data-testid={`portal-security-device-${device.id}-name`}
                      >
                        {device.name}
                      </span>
                      <details
                        className="group mt-1.5"
                        data-testid={`portal-security-device-${device.id}-more`}
                      >
                        {/* inline-flex drops the UA disclosure triangle (which
                            is not our icon system); the chevron is the drawn
                            affordance and flips when the row is open. */}
                        <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-primary-on-tint underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
                          <ChevronDown
                            aria-hidden="true"
                            className="h-3.5 w-3.5 group-open:rotate-180"
                            strokeWidth={2}
                          />
                          More about this device
                        </summary>
                        <dl className="mt-2 space-y-1.5">
                          <DeviceFact label="Protection software">
                            {device.avProducts.join(', ') || 'Not known'}
                          </DeviceFact>
                          <DeviceFact
                            label="Always-on scanning"
                            testId={`portal-security-device-${device.id}-real-time-protection`}
                          >
                            {showSwitch(device.realTimeProtection)}
                          </DeviceFact>
                          <DeviceFact label="Virus definitions">
                            {definitionsLabel(device.definitionsAgeDays)}
                          </DeviceFact>
                          <DeviceFact label="Firewall">
                            {showSwitch(device.firewall)}
                          </DeviceFact>
                          <DeviceFact label="Important updates waiting">
                            {device.pendingCriticalPatches}
                          </DeviceFact>
                        </dl>
                      </details>
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <StatusMark
                        tone={mark.tone}
                        data-testid={`portal-security-device-${device.id}-protection`}
                      >
                        {mark.label}
                      </StatusMark>
                    </td>
                    <td className={cn(CELL, 'order-3 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Encryption </span>
                      {encryptionLabel(device.encryption)}
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Last checked </span>
                      <span
                        className="text-figures"
                        data-testid={`portal-security-device-${device.id}-observed-at`}
                      >
                        {showObservedAt(device.observedAt, timezone)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-border px-4 pt-3.5">
            <p
              className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
              data-testid="security-ledger-foot"
            >
              {footLine}
            </p>
            {fleetTotal > devices.length && (
              <p
                className="mt-1 text-xs text-muted-foreground"
                data-testid="portal-security-devices-cap"
              >
                {capLine}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default SecurityDeviceTable;
