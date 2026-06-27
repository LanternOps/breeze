import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { softwareCatalog, softwareInventory, softwareVersions } from '../db/schema';

export interface LatestVersionInfo {
  version: typeof softwareVersions.$inferSelect;
  catalogName: string;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (version: string): number[] | null => {
    const trimmed = version.trim();
    if (!trimmed || !/^\d+(\.\d+)*$/.test(trimmed)) {
      return null;
    }
    return trimmed.split('.').map((segment) => Number(segment));
  };

  const parsedA = parse(a);
  const parsedB = parse(b);
  if (!parsedA || !parsedB) {
    return null;
  }

  const length = Math.max(parsedA.length, parsedB.length);
  for (let index = 0; index < length; index += 1) {
    const left = parsedA[index] ?? 0;
    const right = parsedB[index] ?? 0;
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
  }

  return 0;
}

export async function resolveLatestVersionsByCatalogId(
  catalogIds: string[],
): Promise<Map<string, LatestVersionInfo>> {
  const latestByCatalogId = new Map<string, LatestVersionInfo>();
  if (catalogIds.length === 0) {
    return latestByCatalogId;
  }

  const rows = await db
    .select({ version: softwareVersions, catalogName: softwareCatalog.name })
    .from(softwareVersions)
    .innerJoin(softwareCatalog, eq(softwareVersions.catalogId, softwareCatalog.id))
    .where(and(inArray(softwareVersions.catalogId, catalogIds), eq(softwareVersions.isLatest, true)));

  for (const row of rows) {
    latestByCatalogId.set(row.version.catalogId, {
      version: row.version,
      catalogName: row.catalogName,
    });
  }

  return latestByCatalogId;
}

export async function isDeviceSoftwareCurrent(
  deviceId: string,
  catalogId: string,
  latestVersion: string,
): Promise<boolean> {
  const rows = await db
    .select({ version: softwareInventory.version })
    .from(softwareInventory)
    .where(and(eq(softwareInventory.deviceId, deviceId), eq(softwareInventory.catalogId, catalogId)));

  for (const row of rows) {
    if (!row.version) {
      continue;
    }
    const comparison = compareVersions(row.version, latestVersion);
    if (comparison === 0 || comparison === 1) {
      return true;
    }
  }

  return false;
}
