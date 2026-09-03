import type { SecurityDeviceRow } from '@breeze/shared';

const show = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? 'Not available'
    : String(value);

const showSwitch = (value: boolean | null) =>
  value == null ? 'Not available' : value ? 'On' : 'Off';

function showObservedAt(value: string | null, timezone: string) {
  if (value == null) return 'Not available';
  const observedAt = new Date(value);
  if (Number.isNaN(observedAt.getTime())) return 'Not available';

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(observedAt);
  return `${formatted} (${timezone})`;
}

export function SecurityDeviceTable({
  devices,
  timezone,
}: {
  devices: SecurityDeviceRow[];
  timezone: string;
}) {
  if (devices.length === 0) {
    return <p data-testid="portal-security-devices-empty">No devices are enrolled.</p>;
  }

  return (
    <table data-testid="portal-security-device-table">
      <thead>
        <tr>
          <th>Device</th>
          <th>Protection</th>
          <th>Provider</th>
          <th>Real-time protection</th>
          <th>Definitions age</th>
          <th>Encryption</th>
          <th>Firewall</th>
          <th>Critical patches</th>
          <th>Observed at</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((device) => (
          <tr
            key={device.id}
            data-testid={`portal-security-device-${device.id}`}
          >
            <td>{device.name}</td>
            <td>{device.protection[0].toUpperCase() + device.protection.slice(1)}</td>
            <td>{device.avProducts.join(', ') || 'Not available'}</td>
            <td data-testid={`portal-security-device-${device.id}-real-time-protection`}>
              {showSwitch(device.realTimeProtection)}
            </td>
            <td>{device.definitionsAgeDays == null ? 'Not available' : `${device.definitionsAgeDays} days`}</td>
            <td>{show(device.encryption)}</td>
            <td>{showSwitch(device.firewall)}</td>
            <td>{device.pendingCriticalPatches}</td>
            <td data-testid={`portal-security-device-${device.id}-observed-at`}>
              {showObservedAt(device.observedAt, timezone)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
