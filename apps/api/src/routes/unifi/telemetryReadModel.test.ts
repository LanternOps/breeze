import { describe, expect, it } from 'vitest';
import { toUnifiTelemetryDevice } from './telemetryReadModel';

describe('toUnifiTelemetryDevice', () => {
  it('maps absent data to null and never to 0', () => {
    const out = toUnifiTelemetryDevice({});
    expect(out).toMatchObject({
      online: null, controllerState: null, wifiCapable: null, uptimeSeconds: null, cpuPct: null, memPct: null,
      wirelessClientCount: null, uplinkRxRateBps: null, uplinkTxRateBps: null, radioOverview: null, radioStatistics: null,
      deviceInventoryObservedAt: null, wifiDetailObservedAt: null, wifiStatisticsObservedAt: null, wifiClientsObservedAt: null,
      statisticsLastHeartbeatAt: null, statisticsNextHeartbeatAt: null,
    });
  });

  it('keeps measured zeros', () => {
    const out = toUnifiTelemetryDevice({
      cpuPct: 0, memPct: 0, uptimeSeconds: 0, numClients: 0, uplinkRxRateBps: 0, uplinkTxRateBps: 0,
      wifiRadioStatistics: [{ frequencyGHz: 5, txRetriesPct: 0 }],
    });
    expect(out).toMatchObject({ cpuPct: 0, memPct: 0, uptimeSeconds: 0, wirelessClientCount: 0, uplinkRxRateBps: 0, uplinkTxRateBps: 0 });
    expect(out.radioStatistics).toEqual([{ frequencyGHz: 5, txRetriesPct: 0 }]);
  });

  it('derives online from the controller state (case-insensitive), null when unknown', () => {
    expect(toUnifiTelemetryDevice({ controllerState: 'ONLINE' }).online).toBe(true);
    expect(toUnifiTelemetryDevice({ controllerState: 'online' }).online).toBe(true);
    expect(toUnifiTelemetryDevice({ controllerState: 'OFFLINE' }).online).toBe(false);
    expect(toUnifiTelemetryDevice({ controllerState: null }).online).toBeNull();
  });

  it('preserves a positive rate on an offline device', () => {
    const out = toUnifiTelemetryDevice({ controllerState: 'OFFLINE', uplinkRxRateBps: 1724576 });
    expect(out.online).toBe(false);
    expect(out.uplinkRxRateBps).toBe(1724576);
  });

  it('normalizes invalid jsonb to null without throwing', () => {
    for (const bad of ['x', 5, { a: 1 }, true]) {
      const out = toUnifiTelemetryDevice({ wifiRadioOverview: bad, wifiRadioStatistics: bad });
      expect(out.radioOverview).toBeNull();
      expect(out.radioStatistics).toBeNull();
    }
    const out = toUnifiTelemetryDevice({ wifiRadioOverview: [null, 3, { channel: 1 }, { frequencyGHz: 5, channel: 'x', wlanStandard: 7 }] });
    expect(out.radioOverview).toEqual([{ frequencyGHz: 5, channel: null, channelWidthMHz: null, wlanStandard: null }]);
    expect(toUnifiTelemetryDevice({ wifiRadioOverview: [] }).radioOverview).toEqual([]);
  });

  it('serializes timestamps as ISO and tolerates invalid ones', () => {
    const out = toUnifiTelemetryDevice({ wifiStatisticsObservedAt: new Date('2026-10-15T12:00:00Z'), wifiDetailObservedAt: 'garbage' as never });
    expect(out.wifiStatisticsObservedAt).toBe('2026-10-15T12:00:00.000Z');
    expect(out.wifiDetailObservedAt).toBeNull();
  });

  it('preserves every original column (additive change)', () => {
    const out = toUnifiTelemetryDevice({ id: 'd1', raw: { a: 1 }, poePorts: [1], txBytes: 5, rxBytes: 6, isStale: true, lastSeenAt: new Date(0), numClients: 2, wifiRadioOverview: [] } as never) as Record<string, unknown>;
    expect(out).toMatchObject({ id: 'd1', raw: { a: 1 }, poePorts: [1], txBytes: 5, rxBytes: 6, isStale: true, numClients: 2, wifiRadioOverview: [] });
    expect(out.lastSeenAt).toEqual(new Date(0));
  });
});
