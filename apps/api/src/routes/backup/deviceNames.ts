import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';

/**
 * Restore/verification/snapshot screens identify rows by device UUID. Attach a
 * human name (display name, then hostname) to already-authorized rows. A lookup
 * failure degrades to `deviceName: null` rather than failing the list (#7213).
 */
export async function attachDeviceNames<T extends { deviceId: string }>(
  orgId: string,
  rows: T[],
): Promise<Array<T & { deviceName: string | null }>> {
  if (rows.length === 0) return [];
  const names = new Map<string, string>();
  try {
    const ids = [...new Set(rows.map((r) => r.deviceId))];
    const found = await db
      .select({ id: devices.id, displayName: devices.displayName, hostname: devices.hostname })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), inArray(devices.id, ids)));
    for (const d of found) {
      const name = d.displayName?.trim() || d.hostname?.trim();
      if (name) names.set(d.id, name);
    }
  } catch (err) {
    console.error('[backup] device name lookup failed', err);
  }
  return rows.map((r) => ({ ...r, deviceName: names.get(r.deviceId) ?? null }));
}

/** Restore-as-VM and instant boot both persist restoreType 'full'; tell them apart. */
export function restoreModeFromTargetConfig(config: unknown): 'instant_boot' | 'vm' | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const c = config as Record<string, unknown>;
  if (c.mode === 'instant_boot') return 'instant_boot';
  if (typeof c.hypervisor === 'string' && typeof c.vmName === 'string') return 'vm';
  return null;
}
