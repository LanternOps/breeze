import type { Collection, CollectionOid, CollectionOidInstance } from '../types';

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

export type SupplyReading = {
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
    return {
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

