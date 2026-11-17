/**
 * Brain Device Context Service
 *
 * Provides read/write operations for AI memory about devices.
 * Enforces org-scoped data isolation.
 */

import { db, hasDbAccessContext } from '../db';
import { brainDeviceContext, devices } from '../db/schema';
import { eq, and, or, gt, isNull, desc, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { deviceIdSiteDenied } from './aiToolsSiteScope';
import {
  NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE,
  NOTE_WRITE_AUTO_MAX_EXPIRY_DAYS,
  NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY,
  NOTE_WRITE_NEEDS_APPROVAL_MESSAGE,
} from './aiNoteWrites';

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
  opts?: { cardFree?: boolean }
): Promise<ContextEntry | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);

  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };

  if (opts?.cardFree) {
    // A note the chat gate let through without a card (aiNoteWrites.ts). The
    // gate's device counts ran before this call wrote, so calls running in
    // parallel could all have passed them. Count again here, under a
    // per-device lock held until this transaction commits: the next writer
    // for the device waits, then sees this row. Past a bound nothing is
    // written and the model is told to call again, which shows the card.
    // The lock needs the transaction a DB context opens; without one, refuse.
    if (!hasDbAccessContext()) return { error: NOTE_WRITE_NEEDS_APPROVAL_MESSAGE };
    if (!expiresAt || expiresAt.getTime() > Date.now() + NOTE_WRITE_AUTO_MAX_EXPIRY_DAYS * 86_400_000 + 60_000) {
      return { error: NOTE_WRITE_NEEDS_APPROVAL_MESSAGE };
    }
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_device_context:${deviceId}`}, 0))`);
    const counts = await countDeviceNotes(deviceId);
    if (!cardFreeNoteFits(counts)) return { error: NOTE_WRITE_NEEDS_APPROVAL_MESSAGE };
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

/** A device's active (unresolved, unexpired) notes and notes written in the last 24 h. */
export interface DeviceNoteCounts {
  active: number;
  recent: number;
}

/**
 * Count a device's notes for the card-free bounds, under the ambient context
 * (the caller's RLS). One statement, two filtered counts.
 */
export async function countDeviceNotes(deviceId: string): Promise<DeviceNoteCounts> {
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [row] = await db
    .select({
      active: sql<number>`count(*) filter (where ${brainDeviceContext.resolvedAt} is null and (${brainDeviceContext.expiresAt} is null or ${brainDeviceContext.expiresAt} > ${now}::timestamp))`,
      recent: sql<number>`count(*) filter (where ${brainDeviceContext.createdAt} >= ${since}::timestamp)`,
    })
    .from(brainDeviceContext)
    .where(eq(brainDeviceContext.deviceId, deviceId));
  return { active: Number(row?.active ?? Number.NaN), recent: Number(row?.recent ?? Number.NaN) };
}

/** Whether one more card-free note fits under both device bounds. A count that is not a number does not fit. */
export function cardFreeNoteFits(counts: DeviceNoteCounts): boolean {
  return counts.active < NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE
    && counts.recent < NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY;
}

/**
 * The chat gate's read for a card-free note: the org/site/device access check
 * FIRST (the same `verifyDeviceAccess` the tool dispatch runs), and the device
 * counts only for a device the caller can reach. `null` means unreachable: no
 * count ran, so whether a card appears says nothing about the device's notes.
 * Runs under the ambient context (the caller's RLS).
 */
export async function readCardFreeNoteBudget(deviceId: string, auth: AuthContext): Promise<DeviceNoteCounts | null> {
  // Imported at call time: aiTools reaches this module through aiToolsDevice.
  const { verifyDeviceAccess } = await import('./aiTools');
  const access = await verifyDeviceAccess(deviceId, auth);
  if ('error' in access) return null;
  return countDeviceNotes(deviceId);
}
