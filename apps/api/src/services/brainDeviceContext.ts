/**
 * Brain Device Context Service
 *
 * Provides read/write operations for AI memory about devices.
 * Enforces org-scoped data isolation.
 */

import { db } from '../db';
import { brainDeviceContext, devices } from '../db/schema';
import { eq, and, or, gt, isNull, desc, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';

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
  expiresAt?: Date
): Promise<ContextEntry | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);

  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };

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

  const result = await db
    .update(brainDeviceContext)
    .set({ resolvedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: brainDeviceContext.id });

  return { updated: result.length > 0 };
}
