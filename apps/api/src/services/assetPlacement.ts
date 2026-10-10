/**
 * Structured physical placement (room / rack / rack unit / height U) for one
 * network asset. Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
 * §5.1 (data model, linked-asset authority) and §8.1 (API contract).
 *
 * One physical box has ONE authoritative placement. An unlinked discovered
 * asset may own its placement; once `discovered_assets.linked_device_id` is set,
 * the managed device is the only authoritative subject. Every writer of that
 * link calls {@link reconcilePlacementOnLink} so the two never diverge.
 *
 * All functions use the ambient `db` (request / system transaction), so a link
 * write and its placement reconciliation commit or roll back together.
 */

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { assetPhysicalPlacements, devices, discoveredAssets } from '../db/schema';

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Structural executor shared by the ambient `db` proxy and a real Drizzle
 * transaction, so a link writer that already holds a transaction (the BMC link)
 * can reconcile placement on that same executor.
 */
export type PlacementExecutor = Pick<DbTx, 'select' | 'update' | 'delete'>;

export type PlacementSubjectKind = 'device' | 'discovered';

export interface PlacementFields {
  room: string | null;
  rack: string | null;
  rackUnit: number | null;
  heightU: number | null;
}

export interface PlacementSubject {
  kind: PlacementSubjectKind;
  id: string;
  orgId: string;
  /** Live site of the subject; never stored on the placement row. */
  siteId: string;
}

const textField = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    })
    .refine((value) => value === null || value.length <= max, { message: `Must be at most ${max} characters` });

const unitField = z
  .number()
  .int()
  .min(1)
  .max(100)
  .nullish()
  .transform((value) => value ?? null);

/** PUT body. Absent / blank fields become NULL; an all-NULL body removes the row. */
export const placementBodySchema = z
  .object({
    room: textField(255),
    rack: textField(128),
    rackUnit: unitField,
    heightU: unitField,
  })
  .strict();

export function isEmptyPlacement(fields: PlacementFields): boolean {
  return fields.room === null && fields.rack === null && fields.rackUnit === null && fields.heightU === null;
}

export function placementsEqual(a: PlacementFields, b: PlacementFields): boolean {
  return a.room === b.room && a.rack === b.rack && a.rackUnit === b.rackUnit && a.heightU === b.heightU;
}

type PlacementRow = typeof assetPhysicalPlacements.$inferSelect;

function toFields(row: Pick<PlacementRow, 'room' | 'rack' | 'rackUnit' | 'heightU'>): PlacementFields {
  return { room: row.room, rack: row.rack, rackUnit: row.rackUnit, heightU: row.heightU };
}

function subjectColumn(kind: PlacementSubjectKind) {
  return kind === 'device' ? assetPhysicalPlacements.deviceId : assetPhysicalPlacements.discoveredAssetId;
}

export async function readPlacement(kind: PlacementSubjectKind, id: string): Promise<PlacementFields | null> {
  const [row] = await db
    .select()
    .from(assetPhysicalPlacements)
    .where(eq(subjectColumn(kind), id))
    .limit(1);
  return row ? toFields(row) : null;
}

export async function deletePlacement(subject: Pick<PlacementSubject, 'kind' | 'id'>): Promise<boolean> {
  const rows = await db
    .delete(assetPhysicalPlacements)
    .where(eq(subjectColumn(subject.kind), subject.id))
    .returning({ id: assetPhysicalPlacements.id });
  return rows.length > 0;
}

/** Upsert, or delete when every field is NULL (an empty placement is never stored). */
export async function savePlacement(
  subject: PlacementSubject,
  fields: PlacementFields,
): Promise<PlacementFields | null> {
  if (isEmptyPlacement(fields)) {
    await deletePlacement(subject);
    return null;
  }
  const column = subjectColumn(subject.kind);
  const now = new Date();
  const [row] = await db
    .insert(assetPhysicalPlacements)
    .values({
      orgId: subject.orgId,
      deviceId: subject.kind === 'device' ? subject.id : null,
      discoveredAssetId: subject.kind === 'discovered' ? subject.id : null,
      ...fields,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: column,
      targetWhere: sql`${column} is not null`,
      set: { ...fields, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error('Failed to save asset placement');
  return toFields(row);
}

/**
 * Resolve which subject owns the placement for `subject`. A discovered asset
 * linked to a managed device of the same org defers to that device.
 */
export async function resolvePlacementAuthority(
  subject: PlacementSubject,
): Promise<{ authority: PlacementSubject; linked: boolean }> {
  if (subject.kind === 'device') return { authority: subject, linked: false };

  const [row] = await db
    .select({
      linkedDeviceId: discoveredAssets.linkedDeviceId,
      deviceOrgId: devices.orgId,
      deviceSiteId: devices.siteId,
    })
    .from(discoveredAssets)
    .leftJoin(devices, eq(devices.id, discoveredAssets.linkedDeviceId))
    .where(and(eq(discoveredAssets.id, subject.id), eq(discoveredAssets.orgId, subject.orgId)))
    .limit(1);

  if (!row?.linkedDeviceId || row.deviceOrgId !== subject.orgId || !row.deviceSiteId) {
    return { authority: subject, linked: false };
  }
  return {
    authority: { kind: 'device', id: row.linkedDeviceId, orgId: row.deviceOrgId, siteId: row.deviceSiteId },
    linked: true,
  };
}

export type LinkMode = 'manual' | 'automatic';
export type LinkReconcileOutcome = 'noop' | 'moved' | 'deduplicated' | 'device_wins' | 'conflict';

export interface PlacementLinkConflict {
  device: PlacementFields;
  discovered: PlacementFields;
}

/** Thrown to abort the ambient transaction if a conflict appears after the link write. */
export class PlacementLinkConflictError extends Error {
  constructor(public readonly conflict: PlacementLinkConflict) {
    super('placement_link_conflict');
    this.name = 'PlacementLinkConflictError';
  }
}

async function loadPair(ex: PlacementExecutor, discoveredAssetId: string, deviceId: string) {
  const [discovered] = await ex
    .select()
    .from(assetPhysicalPlacements)
    .where(eq(assetPhysicalPlacements.discoveredAssetId, discoveredAssetId))
    .limit(1)
    .for('update');
  const [device] = await ex
    .select()
    .from(assetPhysicalPlacements)
    .where(eq(assetPhysicalPlacements.deviceId, deviceId))
    .limit(1)
    .for('update');
  return { discovered, device };
}

/**
 * Read-only pre-check for a MANUAL link: both subjects hold a placement and the
 * values differ. The operator must resolve it first (spec §5.1), so the link
 * route rejects with 409 before writing anything.
 */
export async function findLinkPlacementConflict(
  discoveredAssetId: string,
  deviceId: string,
  executor: PlacementExecutor = db,
): Promise<PlacementLinkConflict | null> {
  const { discovered, device } = await loadPair(executor, discoveredAssetId, deviceId);
  if (!discovered || !device) return null;
  const a = toFields(discovered);
  const b = toFields(device);
  return placementsEqual(a, b) ? null : { device: b, discovered: a };
}

/**
 * Apply the placement-authority rule right after `linked_device_id` is set
 * (same transaction as the link write):
 *   - only the discovered asset has a placement -> it moves to the device
 *   - only the device has one                    -> nothing to do
 *   - both, identical                            -> the duplicate discovered row is dropped
 *   - both, different, automatic link            -> the device wins, the discovered row is dropped
 *   - both, different, manual link               -> 'conflict' (nothing written; the route
 *                                                   pre-checks, so this is a race backstop)
 * Unlink paths never call this: placement is never cloned back (spec §5.1).
 */
export async function reconcilePlacementOnLink(args: {
  discoveredAssetId: string;
  deviceId: string;
  mode: LinkMode;
  /** Defaults to the ambient `db`; pass the caller's transaction when it has one. */
  executor?: PlacementExecutor;
}): Promise<LinkReconcileOutcome> {
  const ex: PlacementExecutor = args.executor ?? db;
  const { discovered, device } = await loadPair(ex, args.discoveredAssetId, args.deviceId);
  if (!discovered) return 'noop';

  if (!device) {
    await ex
      .update(assetPhysicalPlacements)
      .set({ deviceId: args.deviceId, discoveredAssetId: null, updatedAt: new Date() })
      .where(eq(assetPhysicalPlacements.id, discovered.id));
    return 'moved';
  }

  if (placementsEqual(toFields(discovered), toFields(device))) {
    await ex.delete(assetPhysicalPlacements).where(eq(assetPhysicalPlacements.id, discovered.id));
    return 'deduplicated';
  }

  if (args.mode === 'manual') return 'conflict';

  await ex.delete(assetPhysicalPlacements).where(eq(assetPhysicalPlacements.id, discovered.id));
  return 'device_wins';
}

/** Convenience for link writers that cannot return a conflict response. */
export async function reconcilePlacementOnLinkOrThrow(args: {
  discoveredAssetId: string;
  deviceId: string;
  mode: LinkMode;
  executor?: PlacementExecutor;
}): Promise<Exclude<LinkReconcileOutcome, 'conflict'>> {
  const outcome = await reconcilePlacementOnLink(args);
  if (outcome === 'conflict') {
    const conflict = await findLinkPlacementConflict(args.discoveredAssetId, args.deviceId, args.executor);
    throw new PlacementLinkConflictError(conflict ?? {
      device: { room: null, rack: null, rackUnit: null, heightU: null },
      discovered: { room: null, rack: null, rackUnit: null, heightU: null },
    });
  }
  return outcome;
}
