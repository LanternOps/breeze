import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { unifiDeviceTelemetry } from '../db/schema/unifi';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * UniFi Wi-Fi current state (#7690 W4, spec 14.4). Pins the export bucket of every Wi-Fi column on
 * `unifi_device_telemetry` and its Drizzle parity, so a re-bucketed or renamed column reds in
 * Test API instead of only under Integration Tests. Scalars are `included`; jsonb containers are
 * `excludedOpen` (never included, even when their contents look harmless).
 */
describe('unifi_device_telemetry Wi-Fi columns', () => {
  const INCLUDED = {
    controllerState: 'controller_state',
    wifiCapable: 'wifi_capable',
    deviceInventoryObservedAt: 'device_inventory_observed_at',
    uplinkRxRateBps: 'uplink_rx_rate_bps',
    uplinkTxRateBps: 'uplink_tx_rate_bps',
    wifiDetailObservedAt: 'wifi_detail_observed_at',
    wifiStatisticsObservedAt: 'wifi_statistics_observed_at',
    wifiClientsObservedAt: 'wifi_clients_observed_at',
    statisticsLastHeartbeatAt: 'statistics_last_heartbeat_at',
    statisticsNextHeartbeatAt: 'statistics_next_heartbeat_at',
  } as const;
  const EXCLUDED_OPEN = { wifiRadioOverview: 'wifi_radio_overview', wifiRadioStatistics: 'wifi_radio_statistics' } as const;
  const drizzle = getTableColumns(unifiDeviceTelemetry) as Record<string, { name: string }>;
  const policy = () => getTenantExportPolicyRegistry()['unifi_device_telemetry']!.columns;

  for (const [property, column] of Object.entries(INCLUDED)) {
    it(`${column} is mapped and included`, () => {
      expect(policy()[column]?.decision).toBe('include');
      expect(drizzle[property]?.name).toBe(column);
    });
  }

  for (const [property, column] of Object.entries(EXCLUDED_OPEN)) {
    it(`${column} (jsonb) is mapped and excluded`, () => {
      expect(policy()[column]?.decision).toBe('exclude');
      expect(drizzle[property]?.name).toBe(column);
    });
  }
});
