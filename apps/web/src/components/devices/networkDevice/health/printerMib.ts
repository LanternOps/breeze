// Pure RFC 3805 / HOST-RESOURCES-MIB decoding for the printer Health card.
// Kept out of the component so every table below is unit-testable against a
// real device's `collection` payload without rendering anything.
//
// The OIDs and names match the shipped built-in "Generic Printer (RFC 3805)"
// template seed (apps/api/migrations/2026-05-22-snmp-multi-vendor-templates.sql).

import type { Collection, CollectionOid, CollectionOidInstance, CollectionOidState } from '../types';

export const PRINTER_OIDS = {
  deviceStatus: '1.3.6.1.2.1.25.3.2.1.5',
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1',
  detectedErrorState: '1.3.6.1.2.1.25.3.5.1.2',
  lifeCount: '1.3.6.1.2.1.43.10.2.1.4',
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5',
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6',
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',
  colorantValue: '1.3.6.1.2.1.43.12.1.1.4',
} as const;

// hrPrinterStatus (1.3.6.1.2.1.25.3.5.1.1), RFC 2790.
export const HR_PRINTER_STATUS: Record<number, string> = {
  1: 'other', 2: 'unknown', 3: 'idle', 4: 'printing', 5: 'warmup',
};

// hrDeviceStatus (1.3.6.1.2.1.25.3.2.1.5), RFC 2790.
export const HR_DEVICE_STATUS: Record<number, string> = {
  1: 'unknown', 2: 'running', 3: 'warning', 4: 'testing', 5: 'down',
};

// hrPrinterDetectedErrorState (1.3.6.1.2.1.25.3.5.1.2) is an OCTET STRING of
// BITS: bit 0 is the MOST significant bit of the first byte.
export const PRINTER_ERROR_BITS = [
  'lowPaper', 'noPaper', 'lowToner', 'noToner', 'doorOpen', 'jammed', 'offline', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputNearFull', 'outputFull',
  'inputTrayEmpty', 'overduePreventMaint',
] as const;

function oidRows(collection: Collection | null, baseOid: string): CollectionOidInstance[] {
  if (!collection) return [];
  const entry: CollectionOid | undefined = collection.oids.find((o) => o.baseOid === baseOid);
  return entry?.instances ?? [];
}

function byInstance(rows: CollectionOidInstance[]): Map<string, string | null> {
  return new Map(rows.map((row) => [row.instance, row.value]));
}

function toInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

export type ReadingFreshness = { state: CollectionOidState; observedAt: string | null };

function readingFreshness(collection: Collection | null, baseOid: string): ReadingFreshness | null {
  const entry = collection?.oids.find((oid) => oid.baseOid === baseOid);
  return entry ? { state: entry.state, observedAt: entry.observedAt } : null;
}

export type SupplyReading = ReadingFreshness & {
  instance: string;
  description: string | null;
  colorant: string | null;
  level: number | null;
  maxCapacity: number | null;
  percent: number | null;
  unknown: boolean;
};

/**
 * One reading per supply, joined across the four supply OIDs BY INSTANCE
 * INDEX. Position-based joining breaks the moment a walk returns supplies out
 * of order or skips an index, which real printers do.
 */
export function groupSupplies(collection: Collection | null): SupplyReading[] {
  const levels = oidRows(collection, PRINTER_OIDS.suppliesLevel);
  if (levels.length === 0) return [];

  const descriptions = byInstance(oidRows(collection, PRINTER_OIDS.suppliesDescription));
  const capacities = byInstance(oidRows(collection, PRINTER_OIDS.suppliesMaxCapacity));
  const colorants = byInstance(oidRows(collection, PRINTER_OIDS.colorantValue));

  return levels.map((row) => {
    const level = toInt(row.value);
    const maxCapacity = toInt(capacities.get(row.instance) ?? null);
    // RFC 3805 encodes "other"/"unknown"/"some remaining" as -1/-2/-3 on the
    // level and -1/-2 on the capacity. All of them mean "there is no number to
    // draw" — a negative meter or a bar past 100% is worse than saying unknown.
    const unknown = level === null || level < 0 || maxCapacity === null || maxCapacity <= 0;
    // A percentage depends on both the level and capacity; a stale input
    // makes the combined reading stale even if the other walk is current.
    const sources = [PRINTER_OIDS.suppliesLevel, PRINTER_OIDS.suppliesMaxCapacity,
      PRINTER_OIDS.suppliesDescription, PRINTER_OIDS.colorantValue]
      .map((oid) => collection?.oids.find((entry) => entry.baseOid === oid && entry.instances.some((instance) => instance.instance === row.instance)))
      .filter((entry): entry is CollectionOid => Boolean(entry));
    const staleSources = sources.filter((entry) => entry.state === 'stale');
    const source = (staleSources.length ? staleSources : sources)
      .reduce((oldest, entry) => !oldest || (entry.observedAt && (!oldest.observedAt || entry.observedAt < oldest.observedAt)) ? entry : oldest, undefined as CollectionOid | undefined);
    return {
      state: source?.state ?? 'unknown',
      observedAt: source?.observedAt ?? null,
      instance: row.instance,
      description: descriptions.get(row.instance) ?? null,
      colorant: colorants.get(row.instance) ?? null,
      level,
      maxCapacity,
      percent: unknown ? null : Math.max(0, Math.min(100, Math.round((level! / maxCapacity!) * 100))),
      unknown,
    };
  });
}

export function lowestSupply(collection: Collection | null): SupplyReading | null {
  const known = groupSupplies(collection).filter((s) => s.percent !== null);
  if (known.length === 0) return null;
  return known.reduce((lowest, s) => (s.percent! < lowest.percent! ? s : lowest));
}

export function readPageCount(collection: Collection | null): { instanceOid: string; value: number } | null {
  const rows = oidRows(collection, PRINTER_OIDS.lifeCount);
  for (const row of rows) {
    const value = toInt(row.value);
    if (value !== null && value >= 0) return { instanceOid: row.oid, value };
  }
  return null;
}

/** Decodes the BITS octet string; tolerates hex ("0x0C", "0c 00") and a decimal byte. */
export function decodeErrorState(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  let bytes: number[] | null = null;
  const hex = trimmed.replace(/^0x/i, '').replace(/\s+/g, '');
  if (/^[0-9a-f]+$/i.test(hex) && (/^0x/i.test(trimmed) || /\s/.test(trimmed) || /[a-f]/i.test(hex))) {
    const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
    bytes = [];
    for (let i = 0; i < padded.length; i += 2) bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  } else if (/^\d+$/.test(trimmed)) {
    // A plain decimal is a single byte from a legacy agent's integer parse.
    const n = Number.parseInt(trimmed, 10);
    bytes = n <= 0xff ? [n] : [(n >> 8) & 0xff, n & 0xff];
  }
  if (bytes === null) return [];

  const set: string[] = [];
  PRINTER_ERROR_BITS.forEach((name, bit) => {
    const byte = bytes![bit >> 3];
    if (byte !== undefined && (byte & (0x80 >> (bit & 7))) !== 0) set.push(name);
  });
  return set;
}

export function readStatusWords(collection: Collection | null): {
  printerStatus: string | null;
  deviceStatus: string | null;
  errors: string[];
  freshness: {
    printerStatus: ReadingFreshness | null;
    deviceStatus: ReadingFreshness | null;
    errors: ReadingFreshness | null;
  };
} {
  const printerRow = oidRows(collection, PRINTER_OIDS.printerStatus)[0];
  const deviceRow = oidRows(collection, PRINTER_OIDS.deviceStatus)[0];
  const errorRow = oidRows(collection, PRINTER_OIDS.detectedErrorState)[0];
  const printerValue = toInt(printerRow?.value);
  const deviceValue = toInt(deviceRow?.value);
  return {
    printerStatus: printerValue === null ? null : (HR_PRINTER_STATUS[printerValue] ?? null),
    deviceStatus: deviceValue === null ? null : (HR_DEVICE_STATUS[deviceValue] ?? null),
    errors: decodeErrorState(errorRow?.value ?? null),
    freshness: {
      printerStatus: readingFreshness(collection, PRINTER_OIDS.printerStatus),
      deviceStatus: readingFreshness(collection, PRINTER_OIDS.deviceStatus),
      errors: readingFreshness(collection, PRINTER_OIDS.detectedErrorState),
    },
  };
}

/** `points` are already reset-aware deltas (`/metrics?delta=1`, bucket=1d), oldest first. */
export function summariseDeltas(points: Array<[string, number]>): {
  yesterday: number | null;
  lastWeek: number | null;
} {
  if (points.length === 0) return { yesterday: null, lastWeek: null };
  const yesterday = points[points.length - 1][1];
  // Claiming a week from fewer than seven buckets would under-report it as a
  // fact rather than a partial window, so it stays null.
  const lastWeek = points.length >= 7
    ? points.slice(-7).reduce((sum, [, value]) => sum + value, 0)
    : null;
  return { yesterday, lastWeek };
}
