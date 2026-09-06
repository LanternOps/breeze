import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { assertInTransaction, db, withSystemDbAccessContext } from '../db';
import { devices, offlineTransitionEffects as effects, type OfflineEffect } from '../db/schema';
import type { OfflineEffectPayload, OfflineObservation } from './offlineEffectsTypes';

export const OFFLINE_EFFECT_LEASE_SECONDS = 60;
export function offlineEffectId(transitionId: string, kind: string, ruleId = ''): string {
  const h = createHash('sha256').update([transitionId, kind, ruleId].join('\0')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function insertOfflineEffect(source: {
  transitionId: string; orgId: string; deviceId: string;
}, payload: OfflineEffectPayload, ruleId?: string, cooldownUntil?: Date): Promise<string> {
  assertInTransaction('insertOfflineEffect');
  const id = offlineEffectId(source.transitionId, payload.type, ruleId);
  await db.insert(effects).values({
    id, transitionId: source.transitionId, orgId: source.orgId, deviceId: source.deviceId,
    kind: payload.type, payload, ruleId: ruleId ?? null,
    cooldownUntil: cooldownUntil ?? null,
  }).onConflictDoNothing();
  return id;
}

export async function persistOfflineTransition(
  device: typeof devices.$inferSelect, transitionId: string, observedLastSeenAt: string,
): Promise<string[]> {
  const observation: OfflineObservation = {
    deviceId: device.id, orgId: device.orgId, siteId: device.siteId,
    hostname: device.hostname, displayName: device.displayName,
    osType: device.osType, osVersion: device.osVersion, observedLastSeenAt,
  };
  const source = { transitionId, orgId: device.orgId, deviceId: device.id };
  const ids = [await insertOfflineEffect(source, { type: 'offline-event', observation })];
  if (!device.isEphemeral) ids.push(await insertOfflineEffect(source, { type: 'alert-plan', observation }));
  return ids;
}

export function liveLease(effect: OfflineEffect) {
  return and(eq(effects.id, effect.id), eq(effects.leaseToken, effect.leaseToken!),
    gt(effects.leaseUntil, sql`clock_timestamp()`), isNull(effects.completedAt));
}

export async function claimOfflineEffect(id: string): Promise<OfflineEffect | undefined> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.update(effects).set({
      leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
      attempts: sql`${effects.attempts} + 1`, lastError: null,
    }).where(and(eq(effects.id, id), isNull(effects.completedAt),
      sql`${effects.availableAt} <= clock_timestamp()`,
      sql`(${effects.leaseUntil} IS NULL OR ${effects.leaseUntil} <= clock_timestamp())`,
    )).returning();
    return row;
  }, 'offlineEffects.claim');
}

export async function withOfflineEffectLease<T>(effect: OfflineEffect, fn: () => Promise<T>): Promise<T | undefined> {
  return withSystemDbAccessContext(async () => {
    const [owned] = await db.select({ id: effects.id }).from(effects).where(liveLease(effect)).for('update');
    if (!owned) return undefined;
    return fn();
  }, 'offlineEffects.admit');
}

export async function finishOfflineEffect(effect: OfflineEffect): Promise<void> {
  assertInTransaction('finishOfflineEffect');
  const updated = await db.update(effects).set({ completedAt: sql`clock_timestamp()`, leaseToken: null, leaseUntil: null })
    .where(liveLease(effect)).returning({ id: effects.id });
  if (!updated.length) throw new Error('Offline effect lease expired before commit');
}

export async function retryOfflineEffect(effect: OfflineEffect): Promise<void> {
  const delay = Math.min(60, 2 ** Math.min(effect.attempts - 1, 6));
  await withSystemDbAccessContext(async () => {
    await db.update(effects).set({ leaseToken: null, leaseUntil: null, lastError: 'effect_delivery_failed',
      availableAt: sql`clock_timestamp() + ${delay} * interval '1 second'`,
    }).where(liveLease(effect));
  }, 'offlineEffects.retry');
}

export async function findDueOfflineEffects(limit = 500): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: effects.id }).from(effects).where(and(isNull(effects.completedAt),
      sql`${effects.availableAt} <= clock_timestamp()`,
      sql`(${effects.leaseUntil} IS NULL OR ${effects.leaseUntil} <= clock_timestamp())`,
    )).orderBy(effects.availableAt, effects.id).limit(Math.max(1, Math.min(500, limit)));
    return rows.map((r) => r.id);
  }, 'offlineEffects.due');
}

export async function pruneOfflineEffects(): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.execute(sql`DELETE FROM offline_transition_effects WHERE id IN (
      SELECT id FROM offline_transition_effects WHERE completed_at < now() - interval '14 days'
      AND (cooldown_until IS NULL OR cooldown_until < now()) ORDER BY completed_at LIMIT 500
    ) RETURNING id`);
    return rows.length;
  }, 'offlineEffects.prune');
}

/** Must be called in an effect transaction before planning/admission. */
export async function lockCurrentOfflineObservation(observation: OfflineObservation) {
  const [device] = await db.select().from(devices).where(and(
    eq(devices.id, observation.deviceId), eq(devices.orgId, observation.orgId),
    eq(devices.status, 'offline'), eq(devices.lastSeenAt, new Date(observation.observedLastSeenAt)),
    eq(devices.isEphemeral, false),
  )).for('update');
  return device;
}
