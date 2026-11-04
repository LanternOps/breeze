import { isUnifiDeviceOnline } from '../../services/unifi/unifiSyncService';

export type UnifiRadioOverview = {
  frequencyGHz: number;
  channel: number | null;
  channelWidthMHz: number | null;
  wlanStandard: string | null;
};
export type UnifiRadioStatistics = { frequencyGHz: number; txRetriesPct: number | null };

type TelemetryRow = {
  controllerState?: string | null;
  wifiCapable?: boolean | null;
  uptimeSeconds?: number | null;
  cpuPct?: number | null;
  memPct?: number | null;
  numClients?: number | null;
  uplinkRxRateBps?: number | null;
  uplinkTxRateBps?: number | null;
  wifiRadioOverview?: unknown;
  wifiRadioStatistics?: unknown;
  deviceInventoryObservedAt?: Date | string | null;
  wifiDetailObservedAt?: Date | string | null;
  wifiStatisticsObservedAt?: Date | string | null;
  wifiClientsObservedAt?: Date | string | null;
  statisticsLastHeartbeatAt?: Date | string | null;
  statisticsNextHeartbeatAt?: Date | string | null;
};

export type UnifiTelemetryDeviceReadModel<T extends TelemetryRow> = T & {
  online: boolean | null;
  controllerState: string | null;
  wifiCapable: boolean | null;
  uptimeSeconds: number | null;
  cpuPct: number | null;
  memPct: number | null;
  wirelessClientCount: number | null;
  uplinkRxRateBps: number | null;
  uplinkTxRateBps: number | null;
  radioOverview: UnifiRadioOverview[] | null;
  radioStatistics: UnifiRadioStatistics[] | null;
  deviceInventoryObservedAt: string | null;
  wifiDetailObservedAt: string | null;
  wifiStatisticsObservedAt: string | null;
  wifiClientsObservedAt: string | null;
  statisticsLastHeartbeatAt: string | null;
  statisticsNextHeartbeatAt: string | null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Non-array jsonb -> null; entries without a numeric frequencyGHz are dropped. Never throws. */
function normalizeRadios<R>(value: unknown, pick: (o: Record<string, unknown>, frequencyGHz: number) => R): R[] | null {
  if (!Array.isArray(value)) return null;
  const out: R[] = [];
  for (const entry of value) {
    if (!isObj(entry)) continue;
    const f = num(entry.frequencyGHz);
    if (f === null) continue;
    out.push(pick(entry, f));
  }
  return out;
}

export function toUnifiTelemetryDevice<T extends TelemetryRow>(row: T): UnifiTelemetryDeviceReadModel<T> {
  const state = row.controllerState ?? null;
  return {
    ...row,
    online: state === null ? null : isUnifiDeviceOnline(state),
    controllerState: state,
    wifiCapable: row.wifiCapable ?? null,
    uptimeSeconds: num(row.uptimeSeconds),
    cpuPct: num(row.cpuPct),
    memPct: num(row.memPct),
    wirelessClientCount: num(row.numClients),
    uplinkRxRateBps: num(row.uplinkRxRateBps),
    uplinkTxRateBps: num(row.uplinkTxRateBps),
    radioOverview: normalizeRadios(row.wifiRadioOverview, (o, frequencyGHz) => ({
      frequencyGHz,
      channel: num(o.channel),
      channelWidthMHz: num(o.channelWidthMHz),
      wlanStandard: str(o.wlanStandard),
    })),
    radioStatistics: normalizeRadios(row.wifiRadioStatistics, (o, frequencyGHz) => ({
      frequencyGHz,
      txRetriesPct: num(o.txRetriesPct),
    })),
    deviceInventoryObservedAt: iso(row.deviceInventoryObservedAt),
    wifiDetailObservedAt: iso(row.wifiDetailObservedAt),
    wifiStatisticsObservedAt: iso(row.wifiStatisticsObservedAt),
    wifiClientsObservedAt: iso(row.wifiClientsObservedAt),
    statisticsLastHeartbeatAt: iso(row.statisticsLastHeartbeatAt),
    statisticsNextHeartbeatAt: iso(row.statisticsNextHeartbeatAt),
  };
}
