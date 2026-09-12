import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, drPlanGroups } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { isSiteRestrictedPrincipalKind } from './resilienceSiteAuthorization';

export const DR_READ_CANDIDATE_CHUNK_SIZE = 100;
const DR_READ_IN_QUERY_CHUNK_SIZE = 500;

/**
 * Ceiling on how far a restricted list read will scan for visible rows.
 *
 * Filtering happens after the database returns candidates, so a caller who can
 * see nothing in a large org would otherwise walk the whole table one 100-row
 * keyset page at a time (50k hidden executions ≈ 1,500 queries per request).
 * That is a self-inflicted denial of service on a read a restricted tech can
 * issue at will. The scan stops at the cap and returns whatever was visible so
 * far — a short page, never a leaked one.
 */
export const DR_READ_MAX_CANDIDATE_PAGES = 20;
export const DR_READ_MAX_CANDIDATES = DR_READ_CANDIDATE_CHUNK_SIZE * DR_READ_MAX_CANDIDATE_PAGES;

type GroupRef = { planId: string; devices: unknown };
type ExecutionRef = { planId: string; results: unknown };

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return null;
  return value as string[];
}

function groupIds(groups: GroupRef[]): string[] | null {
  const ids: string[] = [];
  for (const group of groups) {
    const parsed = stringArray(group.devices);
    if (!parsed) return null;
    ids.push(...parsed);
  }
  return [...new Set(ids)];
}

function executionIds(results: unknown): string[] | null {
  if (!results || typeof results !== 'object' || Array.isArray(results)) return null;
  const doc = results as Record<string, unknown>;
  const groupResults = doc.groupResults;
  const queued = doc.queuedCommands;
  const failures = doc.failedDispatches;
  const planned = doc.plannedGroups;
  if (!Array.isArray(groupResults) || !Array.isArray(queued) || !Array.isArray(failures) || !Array.isArray(planned)) return null;
  const ids: string[] = [];
  for (const group of groupResults) {
    if (!group || typeof group !== 'object' || !Array.isArray((group as any).devices)) return null;
    for (const item of (group as any).devices) {
      const id = item && typeof item === 'object' ? ((item as any).deviceId ?? (item as any).id) : null;
      if (typeof id !== 'string') return null;
      ids.push(id);
    }
  }
  for (const entry of [...queued, ...failures]) {
    if (!entry || typeof entry !== 'object') return null;
    const id = (entry as any).deviceId;
    if (id !== undefined && typeof id !== 'string') return null;
    if (typeof id === 'string') ids.push(id);
  }
  // `results.authorizedDeviceIds` is declared in drExecutionService.ts as
  // "Historical audit context only. Never authorization authority." That
  // contract holds here: the field can only ADD ids to the must-be-visible
  // set, never admit a row, so reading it tightens the boundary rather than
  // deriving authority from it. It is optional and explicitly nullable, so an
  // absent or null value means "no extra ids" — not a malformed document.
  if (doc.authorizedDeviceIds !== undefined && doc.authorizedDeviceIds !== null) {
    const historical = stringArray(doc.authorizedDeviceIds);
    if (!historical) return null;
    ids.push(...historical);
  }
  return [...new Set(ids)];
}

/**
 * The sites a caller may read DR resources for: `null` = unrestricted, `[]` =
 * nothing, otherwise the allowlist.
 *
 * NOTE the asymmetry with `siteRestriction()` in routes/dr.ts, which maps an
 * unrecognised principal kind to `null` (unrestricted) because every mutation
 * there is already behind `requirePermission`. This read boundary is also
 * reached by shared AI/MCP and autonomous tool execution, where no such
 * middleware runs, so an unrecognised kind is denied outright instead. Keep
 * both behaviours deliberate: converging them is a security change, not a
 * cleanup.
 */
export function drReadSiteCeiling(auth: AuthContext, override?: string[]): string[] | null {
  const kind = auth.principal?.kind;
  if (kind === 'system') return null;
  if (!isSiteRestrictedPrincipalKind(kind)) return [];
  return override ?? auth.allowedSiteIds ?? null;
}

function chunks<T>(values: T[], size = DR_READ_IN_QUERY_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export type DrReadCursor = { createdAt: Date; id: string };

export async function collectReadableDrRows<T extends DrReadCursor>(input: {
  limit: number;
  load: (cursor: DrReadCursor | undefined, chunkSize: number) => Promise<T[]>;
  filter: (rows: T[]) => Promise<T[]>;
}): Promise<T[]> {
  const visible: T[] = [];
  let cursor: DrReadCursor | undefined;
  let pages = 0;
  let scanned = 0;
  while (
    visible.length < input.limit
    && pages < DR_READ_MAX_CANDIDATE_PAGES
    && scanned < DR_READ_MAX_CANDIDATES
  ) {
    const candidates = await input.load(cursor, DR_READ_CANDIDATE_CHUNK_SIZE);
    if (candidates.length === 0) break;
    pages += 1;
    scanned += candidates.length;
    visible.push(...await input.filter(candidates));
    const last = candidates.at(-1)!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (candidates.length < DR_READ_CANDIDATE_CHUNK_SIZE) break;
  }
  return visible.slice(0, input.limit);
}

async function readableKeys(
  auth: AuthContext,
  orgId: string,
  entries: Array<{ key: string; ids: string[] | null }>,
  override?: string[],
): Promise<Set<string>> {
  const sites = drReadSiteCeiling(auth, override);
  if (sites === null) return new Set(entries.map((entry) => entry.key));
  if (sites.length === 0) return new Set();
  const allIds = [...new Set(entries.flatMap((entry) => entry.ids ?? []))];
  const rows: Array<{ id: string; siteId: string | null }> = [];
  for (const idChunk of chunks(allIds)) {
    rows.push(...await db.select({ id: devices.id, siteId: devices.siteId }).from(devices)
      .where(and(eq(devices.orgId, orgId), inArray(devices.id, idChunk))));
  }
  const allowed = new Set(sites);
  const resolved = new Map(rows.map((row) => [row.id, row.siteId]));
  // An id with no surviving device row in this org cannot be a restore target,
  // so — exactly as `authorizeStoredDevices` decides on the write side in
  // routes/dr.ts — it does not gate the read. `dr_plan_groups.devices` is jsonb
  // with no foreign key and is not scrubbed by the device cascade, so a single
  // decommissioned machine would otherwise wedge the whole plan (and all of its
  // execution history) out of view for every restricted technician, forever.
  // A device that DOES still exist and sits outside the ceiling — or carries no
  // site at all — still denies the whole resource.
  const denies = (id: string) => {
    const siteId = resolved.get(id);
    if (siteId === undefined) return false;
    return siteId === null || !allowed.has(siteId);
  };
  return new Set(entries.filter((entry) => entry.ids !== null && !entry.ids.some(denies)).map((entry) => entry.key));
}

export async function filterReadableDrPlans<T extends { id: string }>(
  rows: T[], auth: AuthContext, orgId: string, override?: string[],
): Promise<T[]> {
  const sites = drReadSiteCeiling(auth, override);
  if (sites === null || rows.length === 0) return rows;
  if (sites.length === 0) return [];
  const groups: GroupRef[] = [];
  for (const planIds of chunks(rows.map((row) => row.id))) {
    groups.push(...await db.select({ planId: drPlanGroups.planId, devices: drPlanGroups.devices })
      .from(drPlanGroups).where(and(eq(drPlanGroups.orgId, orgId), inArray(drPlanGroups.planId, planIds))));
  }
  const byPlan = new Map<string, GroupRef[]>();
  for (const group of groups) byPlan.set(group.planId, [...(byPlan.get(group.planId) ?? []), group]);
  const visible = await readableKeys(auth, orgId, rows.map((row) => ({ key: row.id, ids: groupIds(byPlan.get(row.id) ?? []) })), override);
  return rows.filter((row) => visible.has(row.id));
}

export async function drGroupsReadable(groups: GroupRef[], auth: AuthContext, orgId: string, override?: string[]) {
  return (await readableKeys(auth, orgId, [{ key: 'resource', ids: groupIds(groups) }], override)).has('resource');
}

export async function filterReadableDrExecutions<T extends ExecutionRef>(
  rows: T[], auth: AuthContext, orgId: string, override?: string[],
): Promise<T[]> {
  const sites = drReadSiteCeiling(auth, override);
  if (sites === null || rows.length === 0) return rows;
  if (sites.length === 0) return [];
  const planIds = [...new Set(rows.map((r) => r.planId))];
  const groups: GroupRef[] = [];
  for (const planIdChunk of chunks(planIds)) {
    groups.push(...await db.select({ planId: drPlanGroups.planId, devices: drPlanGroups.devices })
      .from(drPlanGroups).where(and(eq(drPlanGroups.orgId, orgId), inArray(drPlanGroups.planId, planIdChunk))));
  }
  const byPlan = new Map<string, GroupRef[]>();
  for (const group of groups) byPlan.set(group.planId, [...(byPlan.get(group.planId) ?? []), group]);
  const entries = rows.map((row) => {
    const current = groupIds(byPlan.get(row.planId) ?? []);
    const historical = executionIds(row.results);
    const union = current && historical ? [...new Set([...current, ...historical])] : null;
    return { key: row as T, ids: union };
  });
  const visible = await readableKeys(auth, orgId, entries.map((entry, index) => ({ key: String(index), ids: entry.ids })), override);
  return entries.filter((_entry, index) => visible.has(String(index))).map((entry) => entry.key);
}
