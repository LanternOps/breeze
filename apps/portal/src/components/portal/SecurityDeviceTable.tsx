import type { SecurityDeviceRow } from '@breeze/shared';

const show = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? 'Not available'
    : String(value);

export function SecurityDeviceTable({
  devices,
}: {
  devices: SecurityDeviceRow[];
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
          <th>Definitions age</th>
          <th>Encryption</th>
          <th>Firewall</th>
          <th>Critical patches</th>
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
            <td>{device.definitionsAgeDays == null ? 'Not available' : `${device.definitionsAgeDays} days`}</td>
            <td>{show(device.encryption)}</td>
            <td>{device.firewall == null ? 'Not available' : device.firewall ? 'On' : 'Off'}</td>
            <td>{device.pendingCriticalPatches}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
