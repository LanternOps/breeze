import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroups } from '../db/schema';

// #9179: dynamic groups can now exclude other groups (groupId notEquals /
// notIn). A dynamic group that references itself, or two dynamic groups that
// reference each other, would have membership that depends on its own previous
// evaluation and can oscillate, so such filters are refused on save.

type FilterNode = { conditions?: unknown[]; field?: string; operator?: string; value?: unknown };

/** Every group id a filter references through `groupId` (any operator). */
export function collectGroupRefs(filter: unknown, out: Set<string> = new Set()): Set<string> {
  const node = filter as FilterNode | null;
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node.conditions)) {
    for (const c of node.conditions) collectGroupRefs(c, out);
  } else if (node.field === 'groupId') {
    const vals = Array.isArray(node.value) ? node.value : [node.value];
    for (const v of vals) if (typeof v === 'string') out.add(v);
  }
  return out;
}

/**
 * Depth-first search for a path from `selfId` back to itself. `directRefs` are
 * the groups the edited filter references; `graph` maps each other dynamic
 * group to the groups its stored filter references. Returns the cycle path
 * (starting and ending at selfId) or null.
 */
export function findGroupFilterCycle(
  selfId: string,
  directRefs: ReadonlySet<string>,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
  const visited = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (id === selfId) return [...path, id];
    if (visited.has(id)) return null;
    visited.add(id);
    for (const next of graph.get(id) ?? []) {
      const hit = walk(next, [...path, id]);
      if (hit) return hit;
    }
    return null;
  };
  for (const ref of directRefs) {
    const hit = walk(ref, [selfId]);
    if (hit) return hit;
  }
  return null;
}

/** Returns the cycle path if saving `filter` on `groupId` would create one. */
export async function findCycleForSave(
  orgId: string,
  groupId: string,
  filter: unknown,
): Promise<string[] | null> {
  const refs = collectGroupRefs(filter);
  if (refs.size === 0) return null;
  if (refs.has(groupId)) return [groupId, groupId];
  const rows = await db
    .select({ id: deviceGroups.id, filterConditions: deviceGroups.filterConditions })
    .from(deviceGroups)
    .where(and(eq(deviceGroups.orgId, orgId), eq(deviceGroups.type, 'dynamic'), isNotNull(deviceGroups.filterConditions)));
  const graph = new Map<string, Set<string>>();
  for (const r of rows) graph.set(r.id, collectGroupRefs(r.filterConditions));
  return findGroupFilterCycle(groupId, refs, graph);
}
