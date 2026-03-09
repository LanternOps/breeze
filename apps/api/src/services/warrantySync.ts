import { db } from '../db';
import { deviceWarranty, deviceHardware, devices } from '../db/schema';
import { eq, and, lt, isNull, or, sql, asc } from 'drizzle-orm';
import { getProviderForManufacturer, normalizeManufacturer } from './warrantyProviders';
import type { WarrantyLookupResult } from './warrantyProviders';
import { evaluateWarrantyAlerts } from './warrantyAlertEvaluator';

type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'unknown';

function computeWarrantyStatus(endDate: string | null, warnDays = 90): WarrantyStatus {
  if (!endDate) return 'unknown';
  const now = new Date();
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return 'unknown';

  const diffMs = end.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays <= 0) return 'expired';
  if (diffDays <= warnDays) return 'expiring';
  return 'active';
}

const SYNC_CADENCE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function syncWarrantyForDevice(deviceId: string): Promise<void> {
  // Load hardware info for this device
  const [hw] = await db
    .select({
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
    })
    .from(deviceHardware)
    .where(eq(deviceHardware.deviceId, deviceId))
    .limit(1);

  if (!hw?.serialNumber || !hw?.manufacturer) {
    console.log(`[WarrantySync] No serial/manufacturer for device ${deviceId}, skipping`);
    return;
  }

  // Get device org
  const [device] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return;

  const provider = getProviderForManufacturer(hw.manufacturer);
  if (!provider) {
    // No provider available — upsert as unknown
    await upsertWarranty(deviceId, device.orgId, hw.manufacturer, hw.serialNumber, {
      found: false,
      entitlements: [],
      warrantyStartDate: null,
      warrantyEndDate: null,
      error: `No configured provider for manufacturer: ${hw.manufacturer}`,
    });
    return;
  }

  try {
    const results = await provider.lookup([hw.serialNumber]);
    const result = results.get(hw.serialNumber) ?? {
      found: false,
      entitlements: [],
      warrantyStartDate: null,
      warrantyEndDate: null,
    };

    await upsertWarranty(deviceId, device.orgId, hw.manufacturer, hw.serialNumber, result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WarrantySync] Error syncing device ${deviceId}:`, errorMsg);
    await upsertWarranty(deviceId, device.orgId, hw.manufacturer, hw.serialNumber, {
      found: false,
      entitlements: [],
      warrantyStartDate: null,
      warrantyEndDate: null,
      error: errorMsg,
    });
  }

  // Evaluate warranty alerts after sync
  try {
    await evaluateWarrantyAlerts(deviceId);
  } catch (err) {
    console.error(`[WarrantySync] Alert evaluation error for device ${deviceId}:`, err instanceof Error ? err.message : err);
  }
}

async function upsertWarranty(
  deviceId: string,
  orgId: string,
  manufacturer: string,
  serialNumber: string,
  result: WarrantyLookupResult
): Promise<void> {
  const status = result.found
    ? computeWarrantyStatus(result.warrantyEndDate)
    : 'unknown';

  const now = new Date();
  const nextSyncAt = new Date(now.getTime() + SYNC_CADENCE_MS);

  await db
    .insert(deviceWarranty)
    .values({
      deviceId,
      orgId,
      manufacturer: normalizeManufacturer(manufacturer),
      serialNumber,
      status,
      warrantyStartDate: result.warrantyStartDate,
      warrantyEndDate: result.warrantyEndDate,
      entitlements: result.entitlements,
      lastSyncAt: now,
      lastSyncError: result.error ?? null,
      nextSyncAt,
    })
    .onConflictDoUpdate({
      target: deviceWarranty.deviceId,
      set: {
        orgId,
        manufacturer: normalizeManufacturer(manufacturer),
        serialNumber,
        status,
        warrantyStartDate: result.warrantyStartDate,
        warrantyEndDate: result.warrantyEndDate,
        entitlements: result.entitlements,
        lastSyncAt: now,
        lastSyncError: result.error ?? null,
        nextSyncAt,
        updatedAt: now,
      },
    });
}

export async function syncWarrantyBatch(deviceIds: string[]): Promise<void> {
  for (const deviceId of deviceIds) {
    try {
      await syncWarrantyForDevice(deviceId);
    } catch (err) {
      console.error(`[WarrantySync] Batch sync error for device ${deviceId}:`, err instanceof Error ? err.message : err);
    }
  }
}

export async function getDevicesNeedingWarrantySync(limit = 50): Promise<string[]> {
  const now = new Date();

  const rows = await db
    .select({ deviceId: devices.id })
    .from(devices)
    .leftJoin(deviceWarranty, eq(devices.id, deviceWarranty.deviceId))
    .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
    .where(
      and(
        // Has hardware with serial number
        sql`${deviceHardware.serialNumber} IS NOT NULL`,
        sql`${deviceHardware.manufacturer} IS NOT NULL`,
        // Either no warranty row or next sync is due
        or(
          isNull(deviceWarranty.id),
          lt(deviceWarranty.nextSyncAt, now)
        )
      )
    )
    .orderBy(asc(deviceWarranty.nextSyncAt))
    .limit(limit);

  return rows.map((r) => r.deviceId);
}
