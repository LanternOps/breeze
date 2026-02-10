const IF_IN_OCTETS_OID = '1.3.6.1.2.1.2.2.1.10';
const IF_OUT_OCTETS_OID = '1.3.6.1.2.1.2.2.1.16';
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

type Direction = 'in' | 'out';

type DirectionStats = {
  min?: bigint;
  max?: bigint;
  latest?: bigint;
  latestAt?: number;
};

type InterfaceStats = {
  deviceId: string;
  deviceName: string;
  interfaceKey: string;
  in: DirectionStats;
  out: DirectionStats;
};

export type SnmpInterfaceMetricRow = {
  deviceId: string;
  deviceName: string;
  oid: string | null;
  name: string | null;
  value: string | number | bigint | null;
  timestamp: Date | string | null;
};

export type SnmpTopInterface = {
  deviceId: string;
  name: string;
  inOctets: number;
  outOctets: number;
  totalOctets: number;
};

function isInMetric(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('ifinoctets')
    || normalized === IF_IN_OCTETS_OID
    || normalized.startsWith(`${IF_IN_OCTETS_OID}.`)
  );
}

function isOutMetric(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('ifoutoctets')
    || normalized === IF_OUT_OCTETS_OID
    || normalized.startsWith(`${IF_OUT_OCTETS_OID}.`)
  );
}

function resolveDirection(row: SnmpInterfaceMetricRow): Direction | null {
  const candidates = [row.oid, row.name];
  for (const raw of candidates) {
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;
    if (isInMetric(value)) return 'in';
    if (isOutMetric(value)) return 'out';
  }
  return null;
}

function extractInterfaceKey(row: SnmpInterfaceMetricRow): string {
  const candidates = [row.oid, row.name];

  for (const raw of candidates) {
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;
    const normalized = value.toLowerCase();

    if (normalized.startsWith(`${IF_IN_OCTETS_OID}.`)) {
      return value.slice(IF_IN_OCTETS_OID.length + 1);
    }
    if (normalized.startsWith(`${IF_OUT_OCTETS_OID}.`)) {
      return value.slice(IF_OUT_OCTETS_OID.length + 1);
    }

    const namedMatch = value.match(/(?:ifInOctets|ifOutOctets)[.\s:_-]*([0-9]+(?:\.[0-9]+)*)/i);
    if (namedMatch?.[1]) {
      return namedMatch[1];
    }
  }

  return 'default';
}

function parseOctetValue(raw: SnmpInterfaceMetricRow['value']): bigint | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'bigint') return raw >= 0n ? raw : null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return BigInt(Math.trunc(raw));
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^-?\d+$/.test(trimmed)) {
    const value = BigInt(trimmed);
    return value >= 0n ? value : null;
  }

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return BigInt(Math.trunc(asNumber));
  }

  return null;
}

function resolveTimestampMs(raw: SnmpInterfaceMetricRow['timestamp']): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function updateDirectionStats(stats: DirectionStats, value: bigint, timestampMs: number): void {
  if (stats.min === undefined || value < stats.min) stats.min = value;
  if (stats.max === undefined || value > stats.max) stats.max = value;
  if (stats.latestAt === undefined || timestampMs > stats.latestAt) {
    stats.latest = value;
    stats.latestAt = timestampMs;
  }
}

function resolveUsage(stats: DirectionStats): bigint {
  if (stats.latest === undefined) return 0n;
  if (stats.min !== undefined && stats.max !== undefined && stats.max > stats.min) {
    return stats.max - stats.min;
  }
  return stats.latest > 0n ? stats.latest : 0n;
}

function toSafeNumber(value: bigint): number {
  if (value <= 0n) return 0;
  if (value > MAX_SAFE_BIGINT) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function toInterfaceDisplayName(stats: InterfaceStats): string {
  if (stats.interfaceKey === 'default') return stats.deviceName;
  return `${stats.deviceName} / ifIndex ${stats.interfaceKey}`;
}

export function buildTopInterfaces(
  rows: SnmpInterfaceMetricRow[],
  limit = 5
): SnmpTopInterface[] {
  if (rows.length === 0 || limit <= 0) return [];

  const grouped = new Map<string, InterfaceStats>();

  for (const row of rows) {
    const direction = resolveDirection(row);
    if (!direction) continue;

    const octets = parseOctetValue(row.value);
    if (octets === null) continue;

    const interfaceKey = extractInterfaceKey(row);
    const mapKey = `${row.deviceId}:${interfaceKey}`;
    const entry = grouped.get(mapKey) ?? {
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      interfaceKey,
      in: {},
      out: {}
    };

    const timestampMs = resolveTimestampMs(row.timestamp);
    if (direction === 'in') {
      updateDirectionStats(entry.in, octets, timestampMs);
    } else {
      updateDirectionStats(entry.out, octets, timestampMs);
    }

    grouped.set(mapKey, entry);
  }

  const top = Array.from(grouped.values())
    .map((entry) => {
      const inOctets = resolveUsage(entry.in);
      const outOctets = resolveUsage(entry.out);
      return {
        deviceId: entry.deviceId,
        name: toInterfaceDisplayName(entry),
        inOctets: toSafeNumber(inOctets),
        outOctets: toSafeNumber(outOctets),
        totalOctets: toSafeNumber(inOctets + outOctets)
      };
    })
    .filter((entry) => entry.totalOctets > 0)
    .sort((a, b) => {
      if (b.totalOctets !== a.totalOctets) return b.totalOctets - a.totalOctets;
      return a.name.localeCompare(b.name);
    });

  return top.slice(0, limit);
}
