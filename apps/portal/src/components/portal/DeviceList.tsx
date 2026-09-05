import type { ReactNode } from 'react';
import { ChevronDown, Download, Monitor } from 'lucide-react';
import { publicApiPath, type Device } from '@/lib/api';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';
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

// Local labels for the customer's office manager, kept private rather than
// widening `@/lib/utils`, which the rest of the app shares.
const OS_LABELS: Record<string, string> = {
  windows: 'Windows',
  macos: 'Mac',
  darwin: 'Mac',
  linux: 'Linux',
};

function osLabel(osType: string | null): string {
  if (!osType) return 'Unknown';
  return OS_LABELS[osType.toLowerCase()] ?? osType;
}

/**
 * The phone card's column label. Inline and muted, "Last online" ran straight
 * into "5 minutes ago" as one undifferentiated grey sentence; the Label style
 * on its own line makes each card read label / value the way the dashboard
 * ledger does (apps/portal/DESIGN.md, Typography). Desktop keeps the real <th>
 * and never shows these.
 */
const PHONE_LABEL =
  'mb-0.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:hidden';

const PROTECTION_LABELS: Record<Device['protection'], string> = {
  protected: 'Protected',
  unprotected: 'Not protected',
  unknown: 'Not known',
};

/**
 * The API hands the portal a formatted stamp in the org's timezone
 * ("Sep 3, 2026, 5:12 PM UTC" — services/portal/deviceReadModel.ts), but the
 * register speaks in words: "5 minutes ago", "Yesterday", "Last Tuesday". The
 * exact stamp stays one hover (and one accessible name) away rather than being
 * thrown out. A stamp this browser cannot parse renders verbatim — never blank.
 */
function whenLabel(
  value: string | null,
  missing: string,
): { text: string; title?: string } {
  if (!value) return { text: missing };
  // Safari and Firefox reject the comma between the date and the time that
  // Intl puts there; dropping it costs nothing and parses everywhere.
  const relative = formatRelativeTime(value.replace(/,\s(?=\d{1,2}:)/, ' '));
  return relative ? { text: relative, title: value } : { text: value };
}

/** Warranty ends in the future, so relative time is meaningless for it — a
 *  calendar date, read on its own calendar day (no timezone shift). */
function warrantyLabel(value: string | null): string {
  if (!value) return 'Not available';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : formatDate(date);
}

function encryptionLabel(value: string | null): string {
  if (!value) return 'Not available';
  const v = value.toLowerCase();
  // 'encrypted' is a substring of 'unencrypted', so the negative is tested
  // first — the other order once reported every unencrypted disk as safe (#1831).
  if (v.includes('partial')) return 'Partly encrypted';
  if (v.includes('unencrypted') || v.includes('not_encrypted')) return 'Not encrypted';
  if (v.includes('encrypted')) return 'Encrypted';
  if (v === 'unknown') return 'Not known';
  return value;
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

/** One line of the disclosure. Deliberately the same shape the security ledger
 *  keeps for its own "More about this device" panel — two device tables in one
 *  portal must read as one hand. */
function DeviceFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-xs text-foreground">{children}</dd>
    </div>
  );
}

/** The four facts a customer wants only once they're asking about one machine. */
function moreFacts(device: Device): { label: string; text: string; title?: string }[] {
  return [
    { label: 'Last patch', ...whenLabel(device.lastPatchAt, 'Not available') },
    { label: 'Encryption', text: encryptionLabel(device.encryption) },
    { label: 'Last backup', ...whenLabel(device.lastBackupAt, 'Not available') },
    { label: 'Warranty ends', text: warrantyLabel(device.warrantyEndsAt) },
  ];
}

export function DeviceList({ devices, error }: DeviceListProps) {
  if (error) {
    // The transport error is ours to read, not the customer's: they can act on
    // "ask your IT team", never on a connection string.
    return (
      <ErrorNotice>
        We couldn&apos;t load your devices just now. Your IT team can help.
      </ErrorNotice>
    );
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
              way) — not a card grid holding a second belief about this data.
              Five columns and no min-width: nine technician columns forced a
              horizontal scroll that hid the last of them inside the content
              column, with no affordance saying so. The rest of each machine's
              file lives one disclosure down. */}
          <table className="block w-full sm:table" data-testid="portal-device-table">
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
                  Protection
                </th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {devices.map((device) => {
                const mark = statusMark(device.status);
                const lastOnline = whenLabel(device.lastSeenAt, 'Not known');
                const trailing =
                  'basis-full text-xs text-foreground sm:text-sm sm:text-muted-foreground';
                return (
                  <tr
                    key={device.id}
                    className={ROW}
                    data-testid={`portal-device-${device.id}`}
                  >
                    {/* order-* reorders the phone card: name and status share
                        the first line, then one fact per line so every card in
                        the ledger reflows identically. The friendly name only —
                        the raw hostname is a technician's handle and stays the
                        fallback, not a subtitle. */}
                    <td className={cn(CELL, 'order-1 min-w-0 grow')}>
                      <span className="block break-words font-semibold text-foreground">
                        {device.displayName || device.hostname}
                      </span>
                      {/* The technician's half of the file — patch, encryption,
                          backup, warranty — waits here instead of pushing the
                          ledger past the content column into a hidden scroll. */}
                      <details
                        className="group mt-1.5"
                        data-testid={`portal-device-${device.id}-more`}
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
                          {moreFacts(device).map((fact) => (
                            <DeviceFact key={fact.label} label={fact.label}>
                              <span title={fact.title}>{fact.text}</span>
                            </DeviceFact>
                          ))}
                        </dl>
                      </details>
                    </td>
                    <td className={cn(CELL, 'order-3', trailing)}>
                      <span className={PHONE_LABEL}>Type</span>
                      {osLabel(device.osType)}
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <StatusMark tone={mark.tone}>{mark.label}</StatusMark>
                    </td>
                    <td
                      className={cn(CELL, 'order-4', trailing)}
                      data-testid={`portal-device-${device.id}-last-online`}
                      title={lastOnline.title}
                    >
                      <span className={PHONE_LABEL}>Last online</span>
                      {lastOnline.text}
                    </td>
                    <td className={cn(CELL, 'order-5', trailing)}>
                      <span className={PHONE_LABEL}>Protection</span>
                      {PROTECTION_LABELS[device.protection]}
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
