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

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, runAfterDbContextCommit } from '../db';
import { assetPhysicalPlacements, devices, discoveredAssets } from '../db/schema';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { createAuditLogAsync } from './auditService';
import { ANONYMOUS_ACTOR_ID } from './auditEvents';

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

/**
 * A concurrent writer (a PUT racing a manual/auto link that moves a placement
 * onto the same device) lost a unique-index race. Nothing was written; the
 * caller should answer 409 so the client can re-read and retry.
 */
export class PlacementConcurrentUpdateError extends Error {
  constructor() {
    super('placement_concurrent_update');
    this.name = 'PlacementConcurrentUpdateError';
  }
}

const PLACEMENT_UNIQUE_INDEXES = [
  'asset_physical_placements_device_uniq',
  'asset_physical_placements_discovered_asset_uniq',
];

function isPlacementUniqueViolation(err: unknown): boolean {
  return PLACEMENT_UNIQUE_INDEXES.some((name) => isPgUniqueViolation(err, name));
}

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

/** Org-scoped in SQL; RLS is defense in depth, not the only fence. */
export async function readPlacement(
  kind: PlacementSubjectKind,
  id: string,
  orgId: string,
): Promise<PlacementFields | null> {
  const [row] = await db
    .select()
    .from(assetPhysicalPlacements)
    .where(and(eq(subjectColumn(kind), id), eq(assetPhysicalPlacements.orgId, orgId)))
    .limit(1);
  return row ? toFields(row) : null;
}

/** Map key for the batch helpers: one entry per (kind, id) pair. */
export function placementKey(kind: PlacementSubjectKind, id: string): string {
  return `${kind}:${id}`;
}

/** Batch {@link readPlacement}, org-scoped in SQL: absent subjects have no entry. */
export async function readPlacements(
  refs: ReadonlyArray<Pick<PlacementSubject, 'kind' | 'id'>>,
  orgId: string,
): Promise<Map<string, PlacementFields>> {
  const result = new Map<string, PlacementFields>();
  const deviceIds = [...new Set(refs.filter((r) => r.kind === 'device').map((r) => r.id))];
  const discoveredIds = [...new Set(refs.filter((r) => r.kind === 'discovered').map((r) => r.id))];
  const filters = [
    deviceIds.length > 0 ? inArray(assetPhysicalPlacements.deviceId, deviceIds) : undefined,
    discoveredIds.length > 0 ? inArray(assetPhysicalPlacements.discoveredAssetId, discoveredIds) : undefined,
  ].filter((f) => f !== undefined);
  if (filters.length === 0) return result;

  const rows = await db
    .select()
    .from(assetPhysicalPlacements)
    .where(and(eq(assetPhysicalPlacements.orgId, orgId), or(...filters)));
  for (const row of rows) {
    if (row.deviceId) result.set(placementKey('device', row.deviceId), toFields(row));
    else if (row.discoveredAssetId) result.set(placementKey('discovered', row.discoveredAssetId), toFields(row));
  }
  return result;
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
  // Savepoint: a lost unique-index race (23505) must not poison the ambient
  // request transaction, so the caller can still answer a clean 409. No row
  // lock on `devices` (it would contend with heartbeats); the unique index is
  // the arbiter and the loser retries.
  let row: PlacementRow | undefined;
  try {
    [row] = await db.transaction((tx) =>
      tx
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
        .returning(),
    );
  } catch (err) {
    if (isPlacementUniqueViolation(err)) throw new PlacementConcurrentUpdateError();
    throw err;
  }
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
  const resolved = await resolvePlacementAuthorities([subject]);
  return resolved.get(placementKey(subject.kind, subject.id)) ?? { authority: subject, linked: false };
}

/**
 * Batch {@link resolvePlacementAuthority}: the single implementation of the
 * authority rule. Every input subject has an entry, keyed by
 * {@link placementKey}.
 */
export async function resolvePlacementAuthorities(
  subjects: readonly PlacementSubject[],
): Promise<Map<string, { authority: PlacementSubject; linked: boolean }>> {
  const result = new Map<string, { authority: PlacementSubject; linked: boolean }>();
  const discovered: PlacementSubject[] = [];
  for (const subject of subjects) {
    if (subject.kind === 'device') result.set(placementKey('device', subject.id), { authority: subject, linked: false });
    else discovered.push(subject);
  }
  if (discovered.length === 0) return result;

  const rows = await db
    .select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      linkedDeviceId: discoveredAssets.linkedDeviceId,
      deviceOrgId: devices.orgId,
      deviceSiteId: devices.siteId,
    })
    .from(discoveredAssets)
    .leftJoin(devices, eq(devices.id, discoveredAssets.linkedDeviceId))
    .where(and(
      inArray(discoveredAssets.id, [...new Set(discovered.map((s) => s.id))]),
      inArray(discoveredAssets.orgId, [...new Set(discovered.map((s) => s.orgId))]),
    ));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  for (const subject of discovered) {
    const row = rowById.get(subject.id);
    const key = placementKey('discovered', subject.id);
    if (!row || row.orgId !== subject.orgId || !row.linkedDeviceId || row.deviceOrgId !== subject.orgId || !row.deviceSiteId) {
      result.set(key, { authority: subject, linked: false });
    } else {
      result.set(key, {
        authority: { kind: 'device', id: row.linkedDeviceId, orgId: row.deviceOrgId, siteId: row.deviceSiteId },
        linked: true,
      });
    }
  }
  return result;
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
    try {
      await ex
        .update(assetPhysicalPlacements)
        .set({ deviceId: args.deviceId, discoveredAssetId: null, updatedAt: new Date() })
        .where(eq(assetPhysicalPlacements.id, discovered.id));
    } catch (err) {
      // A device placement committed between loadPair and this write. The 23505
      // aborts the executor's transaction: callers must let it unwind (roll back
      // the savepoint) and not keep using it.
      if (isPlacementUniqueViolation(err)) throw new PlacementConcurrentUpdateError();
      throw err;
    }
    return 'moved';
  }

  if (placementsEqual(toFields(discovered), toFields(device))) {
    await ex.delete(assetPhysicalPlacements).where(eq(assetPhysicalPlacements.id, discovered.id));
    return 'deduplicated';
  }

  if (args.mode === 'manual') return 'conflict';

  await ex.delete(assetPhysicalPlacements).where(eq(assetPhysicalPlacements.id, discovered.id));
  // The discovered asset's differing values are discarded; leave a trail.
  // Deferred until the outermost transaction COMMITS, so a rolled-back link
  // never leaves an audit row claiming a discard that did not happen. The
  // write itself is fire-and-forget on its own connection (never throws).
  const auditEntry = {
    orgId: discovered.orgId,
    actorType: 'system' as const,
    actorId: ANONYMOUS_ACTOR_ID,
    action: 'asset.placement.device_wins',
    resourceType: 'discovered_asset',
    resourceId: args.discoveredAssetId,
    details: {
      deviceId: args.deviceId,
      mode: args.mode,
      discarded: toFields(discovered),
      kept: toFields(device),
    },
    result: 'success' as const,
  };
  runAfterDbContextCommit('assetPlacement.deviceWinsAudit', () => createAuditLogAsync(auditEntry));
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
