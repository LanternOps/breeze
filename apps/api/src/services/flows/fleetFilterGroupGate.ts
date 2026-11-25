/**
 * #12418 W02, Decision 10 — may a device group named by `fleetFilter.groupId`
 * select script targets? Not when a field a device reports about itself
 * decides who is in it.
 *
 * Judged on what computes membership: the group's stored `filterFieldsUsed`
 * and, for a dynamic group, its live `filterConditions` and every group those
 * rules name. Rules
 * that cannot be read, a named group that is not found, and a chain past the
 * bound are refused. Shared by save and resolve; pure apart from `load`.
 */
import { partitionGroupsByExecutionFieldProvenance } from '../executionTargetGating';
import { getFieldDefinition } from '../filterEngine';

export interface GatedGroup {
  id: string;
  type: 'static' | 'dynamic';
  filterFieldsUsed: string[] | null;
  filterConditions: unknown;
}

/** The named group and every group its rules reach, at most. */
export const MAX_GATED_GROUPS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LiveRules { fields: string[]; groupIds: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Fields and group references of stored rules; null when any part cannot be
 * read. A node is told apart as `buildGroupSQL` does, by its operator, and
 * must fit exactly that shape; a field the engine does not define is unread.
 */
function readGroup(node: unknown): LiveRules | null {
  if (!isRecord(node) || (node.operator !== 'AND' && node.operator !== 'OR') || !Array.isArray(node.conditions) || Object.hasOwn(node, 'field')) return null;
  const out: LiveRules = { fields: [], groupIds: [] };
  for (const child of node.conditions as unknown[]) {
    const nested = isRecord(child) && (child.operator === 'AND' || child.operator === 'OR');
    const inner = nested ? readGroup(child) : readCondition(child);
    if (!inner) return null;
    out.fields.push(...inner.fields);
    out.groupIds.push(...inner.groupIds);
  }
  return out;
}

function readCondition(node: unknown): LiveRules | null {
  if (!isRecord(node) || typeof node.field !== 'string' || Object.hasOwn(node, 'conditions') || !getFieldDefinition(node.field)) return null;
  if (node.field !== 'groupId') return { fields: [node.field], groupIds: [] };
  const ids = Array.isArray(node.value) ? node.value : [node.value];
  if (!ids.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))) return null;
  return { fields: [node.field], groupIds: ids.map((id) => id.toLowerCase()) };
}

/**
 * `load` returns the groups the checked org holds among `ids`. `missing`: the
 * named group itself is not one of them.
 */
export async function classifyFleetFilterGroup(
  groupId: string,
  load: (ids: string[]) => Promise<GatedGroup[]>,
): Promise<'ok' | 'missing' | 'refused'> {
  const seen = new Set<string>([groupId.toLowerCase()]);
  let frontier = [...seen];
  while (frontier.length > 0) {
    const rows = await load(frontier);
    if (rows.length !== frontier.length) return seen.size === 1 ? 'missing' : 'refused';
    const next: string[] = [];
    for (const g of rows) {
      let live: LiveRules | null = { fields: [], groupIds: [] };
      if (g.type === 'dynamic' && g.filterConditions !== null && g.filterConditions !== undefined) live = readGroup(g.filterConditions);
      if (!live) return 'refused';
      const { refusedGroups } = partitionGroupsByExecutionFieldProvenance([{ id: g.id, filterFieldsUsed: [...(g.filterFieldsUsed ?? []), ...live.fields] }]);
      if (refusedGroups.length > 0) return 'refused';
      for (const id of live.groupIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
    }
    if (seen.size > MAX_GATED_GROUPS) return 'refused';
    frontier = next;
  }
  return 'ok';
}
