/**
 * Brain Device Context Service
 *
 * Provides read/write operations for AI memory about devices.
 * Enforces org-scoped data isolation.
 */

import { db, hasDbAccessContext } from '../db';
import { brainDeviceContext, devices } from '../db/schema';
import { eq, and, or, gt, isNull, desc, count, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { deviceIdSiteDenied } from './aiToolsSiteScope';
import {
  UNATTENDED_NOTE_ACTIVE_LIMIT_MESSAGE,
  UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE,
  UNATTENDED_NOTE_MAX_EXPIRY_DAYS,
  UNATTENDED_NOTE_UNAVAILABLE_MESSAGE,
} from './deviceNoteBounds';

export type ContextType = 'issue' | 'quirk' | 'followup' | 'preference';

export interface ContextEntry {
  id: string;
  deviceId: string;
  contextType: ContextType;
  summary: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date | null;
  resolvedAt: Date | null;
}

/**
 * Get active context for a device (not resolved, not expired)
 */
export async function getActiveDeviceContext(
  deviceId: string,
  auth: AuthContext
): Promise<ContextEntry[]> {
  const now = new Date();
  const conditions: SQL[] = [
    eq(brainDeviceContext.deviceId, deviceId),
    isNull(brainDeviceContext.resolvedAt),
    // or() returns undefined only when all args are undefined; isNull() always returns defined SQL
    or(isNull(brainDeviceContext.expiresAt), gt(brainDeviceContext.expiresAt, now))!,
  ];

  const orgCond = auth.orgCondition(brainDeviceContext.orgId);
  if (orgCond) conditions.push(orgCond);

  return await db
    .select()
    .from(brainDeviceContext)
    .where(and(...conditions))
    .orderBy(desc(brainDeviceContext.createdAt))
    .limit(100) as ContextEntry[];
}

/**
 * Get all context for a device (including resolved/expired)
 */
export async function getAllDeviceContext(
  deviceId: string,
  auth: AuthContext
): Promise<ContextEntry[]> {
  const conditions: SQL[] = [eq(brainDeviceContext.deviceId, deviceId)];
  const orgCond = auth.orgCondition(brainDeviceContext.orgId);
  if (orgCond) conditions.push(orgCond);

  return await db
    .select()
    .from(brainDeviceContext)
    .where(and(...conditions))
    .orderBy(desc(brainDeviceContext.createdAt))
    .limit(100) as ContextEntry[];
}

/**
 * Create a new context entry
 */
export async function createDeviceContext(
  deviceId: string,
  contextType: ContextType,
  summary: string,
  details: Record<string, unknown> | null,
  auth: AuthContext,
  expiresAt?: Date,
  opts?: { unattended?: boolean }
): Promise<ContextEntry | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);

  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };

  if (opts?.unattended) {
    // A note no person approved (#12140, deviceNoteBounds.ts). Count the
    // device's active notes under a per-device lock held until this
    // transaction commits, so the next writer for the device waits and then
    // sees this row; parallel calls cannot all pass a count taken before any
    // of them wrote. The lock needs the transaction a DB context opens. The
    // two refusals before it are wiring faults (the handler set the expiry,
    // and the tool dispatch always holds a context), so they are logged.
    if (!hasDbAccessContext()) {
      console.error('[brainDeviceContext] unattended note reached the service outside a DB context; not written');
      return { error: UNATTENDED_NOTE_UNAVAILABLE_MESSAGE };
    }
    if (!expiresAt || expiresAt.getTime() > Date.now() + UNATTENDED_NOTE_MAX_EXPIRY_DAYS * 86_400_000 + 60_000) {
      console.error('[brainDeviceContext] unattended note reached the service with no expiry or one past the cap; not written');
      return { error: UNATTENDED_NOTE_UNAVAILABLE_MESSAGE };
    }
    // Keyed per device; a future bounded note path should take the same key.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_device_context:${deviceId}`}, 0))`);
    const active = await countActiveDeviceNotes(device.orgId, deviceId);
    // A count that is not a number fails closed, as a fault, not as a full device.
    if (!Number.isFinite(active)) {
      console.error('[brainDeviceContext] unattended note: active-note count was not a number; not written');
      return { error: UNATTENDED_NOTE_UNAVAILABLE_MESSAGE };
    }
    if (active >= UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE) return { error: UNATTENDED_NOTE_ACTIVE_LIMIT_MESSAGE };
  }

  const [entry] = await db
    .insert(brainDeviceContext)
    .values({
      orgId: device.orgId,
      deviceId,
      contextType,
      summary,
      details,
      expiresAt: expiresAt ?? null,
    })
    .returning();

  return entry as ContextEntry;
}

/**
 * Mark context entry as resolved.
 * Returns whether a row was actually updated.
 */
export async function resolveDeviceContext(
  contextId: string,
  auth: AuthContext
): Promise<{ updated: boolean }> {
  const conditions: SQL[] = [eq(brainDeviceContext.id, contextId)];
  const orgCond = auth.orgCondition(brainDeviceContext.orgId);
  if (orgCond) conditions.push(orgCond);

  // The entry is addressed by CONTEXT id, so org scoping alone lets a
  // device-bound or site-restricted run mutate a sibling device's entry.
  // Resolve the entry's device and check both axes first (#6086). Unrestricted
  // callers take no extra query.
  if (auth.allowedDeviceIds || auth.allowedSiteIds) {
    const [entry] = await db
      .select({ deviceId: brainDeviceContext.deviceId })
      .from(brainDeviceContext)
      .where(and(...conditions))
      .limit(1);
    // Unknown entry → fail closed, same answer as a denied one (no probing).
    if (!entry || await deviceIdSiteDenied(auth, entry.deviceId)) return { updated: false };
  }

  const result = await db
    .update(brainDeviceContext)
    .set({ resolvedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: brainDeviceContext.id });

  return { updated: result.length > 0 };
}

/**
 * A device's active (unresolved, unexpired) notes, under the ambient context
 * (the caller's RLS). Used by the unattended-note bound in createDeviceContext.
 */
async function countActiveDeviceNotes(orgId: string, deviceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(brainDeviceContext)
    .where(and(
      eq(brainDeviceContext.orgId, orgId),
      eq(brainDeviceContext.deviceId, deviceId),
      isNull(brainDeviceContext.resolvedAt),
      or(isNull(brainDeviceContext.expiresAt), gt(brainDeviceContext.expiresAt, new Date()))!,
    ));
  return Number(row?.n ?? Number.NaN);
}
