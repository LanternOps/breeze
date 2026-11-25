/**
 * #12418 W02, Decision 10 — may a device group named by `fleetFilter.groupId`
 * select script targets, and if so, which devices are in it?
 *
 * Not when a field a device reports about itself decides who is in it. Judged
 * on the group's stored `filterFieldsUsed` and, for a dynamic group, its
 * `filterConditions` and every group those rules name. One walk answers both
 * questions: the rows that are judged are the rows that are compiled, so the
 * predicate selects exactly what was judged.
 *
 * Who is in a group, at every nesting level (as
 * `groupMembership.resolveEffectiveGroupMembers` defines it):
 *  - dynamic: its rules, within its site, or a pinned device. No rules: the
 *    pinned devices only.
 *  - static: the devices added to it by hand. A static group that holds any
 *    other member is refused, not filtered: leaving members out would disagree
 *    with the member list people see and, where another group's rules exclude
 *    this group, would widen the selection.
 *
 * Refused as well: rules that cannot be read or compiled, an empty rule list
 * or operand (the engine reads some of those as "every device"), a named group
 * that is not found, a chain of references that returns to itself, and one
 * past the bound. Shared by save (verdict) and resolve (verdict + predicate).
 */
import { and, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { filterConditionSchema } from '@breeze/shared/validators';
import type { db } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices, groupMembershipLog } from '../../db/schema';
import { partitionGroupsByExecutionFieldProvenance } from '../executionTargetGating';
import { buildConditionSQL, getFieldDefinition, validateFilter, type FilterCondition } from '../filterEngine';

export interface GatedGroup {
  id: string;
  type: 'static' | 'dynamic';
  siteId: string | null;
  filterFieldsUsed: string[] | null;
  filterConditions: unknown;
  /** A static group holding a member that was not added to it by hand. */
  hasRuleMembers: boolean;
}

/** The named group and every group its rules reach, at most; also the most times they are compiled in. */
export const MAX_GATED_GROUPS = 50;

export type FleetFilterGroupVerdict =
  | { verdict: 'ok'; members: SQL }
  | { verdict: 'missing' | 'refused' };

/** Rules the gate cannot read or the engine cannot compile. */
class UnreadableRules extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUELESS_OPERATORS: ReadonlySet<string> = new Set(['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty']);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

type RuleNode =
  | { kind: 'group'; operator: 'AND' | 'OR'; nodes: RuleNode[] }
  | { kind: 'condition'; condition: FilterCondition }
  | { kind: 'reference'; negated: boolean; groupIds: string[] };

/**
 * Stored rules as nodes. A node is told apart as `buildGroupSQL` does, by its
 * operator, and must fit exactly that shape; a condition must be one the group
 * routes would accept.
 */
function readGroup(node: unknown): Extract<RuleNode, { kind: 'group' }> {
  if (!isRecord(node) || (node.operator !== 'AND' && node.operator !== 'OR') || !Array.isArray(node.conditions)
    || node.conditions.length === 0 || Object.hasOwn(node, 'field')) throw new UnreadableRules();
  return {
    kind: 'group',
    operator: node.operator,
    nodes: (node.conditions as unknown[]).map((child) =>
      (isRecord(child) && (child.operator === 'AND' || child.operator === 'OR') ? readGroup(child) : readCondition(child))),
  };
}

function readCondition(node: unknown): RuleNode {
  if (!isRecord(node) || typeof node.field !== 'string' || Object.hasOwn(node, 'conditions') || !getFieldDefinition(node.field)) throw new UnreadableRules();
  if (!filterConditionSchema.safeParse(node).success) throw new UnreadableRules();
  const condition = node as unknown as FilterCondition;
  if (Array.isArray(condition.value) ? condition.value.length === 0
    : (condition.value === undefined || condition.value === null) && !VALUELESS_OPERATORS.has(condition.operator)) throw new UnreadableRules();
  if (!validateFilter(condition).valid) throw new UnreadableRules();
  if (condition.field !== 'groupId') return { kind: 'condition', condition };
  // `in`/`notIn` need a list, as the engine does.
  const list = condition.operator === 'in' || condition.operator === 'notIn';
  if (list !== Array.isArray(condition.value)) throw new UnreadableRules();
  const ids: unknown[] = Array.isArray(condition.value) ? condition.value : [condition.value];
  if (!ids.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))) throw new UnreadableRules();
  return {
    kind: 'reference',
    negated: condition.operator === 'notEquals' || condition.operator === 'notIn',
    groupIds: [...new Set(ids.map((id) => id.toLowerCase()))],
  };
}

function fieldsOf(node: RuleNode): string[] {
  if (node.kind === 'group') return node.nodes.flatMap(fieldsOf);
  return [node.kind === 'condition' ? node.condition.field : 'groupId'];
}

function referencesOf(node: RuleNode): string[] {
  if (node.kind === 'group') return node.nodes.flatMap(referencesOf);
  return node.kind === 'reference' ? node.groupIds : [];
}

interface JudgedGroup { group: GatedGroup; rules: RuleNode | null }

/** The compiled members of `groupId` over the judged rows. Every part is parenthesised and correlates on `devices`. */
function compileMembers(orgId: string, groupId: string, judged: ReadonlyMap<string, JudgedGroup>): SQL {
  let compiled = 0;

  const rowExists = (id: string, kind: SQL): SQL =>
    sql`EXISTS (SELECT 1 FROM ${deviceGroupMemberships} WHERE ${deviceGroupMemberships.deviceId} = ${devices.id} AND ${deviceGroupMemberships.groupId} = ${id} AND ${deviceGroupMemberships.orgId} = ${orgId} AND ${kind})`;

  const group = (id: string): SQL => {
    const entry = judged.get(id);
    compiled += 1;
    // References that return to their own group never end, so they pass the bound too.
    if (!entry || compiled > MAX_GATED_GROUPS) throw new UnreadableRules();
    if (entry.group.type === 'static') return rowExists(id, eq(deviceGroupMemberships.addedBy, 'manual'));
    const pinned = rowExists(id, eq(deviceGroupMemberships.isPinned, true));
    if (!entry.rules) return pinned;
    const rules = render(entry.rules);
    const within = entry.group.siteId ? sql`(${eq(devices.siteId, entry.group.siteId)} AND ${rules})` : rules;
    return sql`(${within} OR ${pinned})`;
  };

  const render = (node: RuleNode): SQL => {
    if (node.kind === 'group') return sql`(${sql.join(node.nodes.map(render), node.operator === 'AND' ? sql` AND ` : sql` OR `)})`;
    if (node.kind === 'condition') return sql`(${buildConditionSQL(node.condition)})`;
    const any = sql`(${sql.join(node.groupIds.map(group), sql` OR `)})`;
    // Not a member, whether the rules say no or (over a missing value) nothing.
    return node.negated ? sql`(${any} IS NOT TRUE)` : any;
  };

  return group(groupId);
}

/**
 * `load` returns the groups the checked org holds among `ids`. `missing`: the
 * named group itself is not one of them.
 */
export async function judgeFleetFilterGroup(
  orgId: string,
  namedGroupId: string,
  load: (ids: string[]) => Promise<GatedGroup[]>,
): Promise<FleetFilterGroupVerdict> {
  const groupId = namedGroupId.toLowerCase();
  const judged = new Map<string, JudgedGroup>();
  const seen = new Set<string>([groupId]);
  let frontier = [groupId];
  try {
    while (frontier.length > 0) {
      const rows = await load(frontier);
      if (rows.length !== frontier.length) return { verdict: seen.size === 1 ? 'missing' : 'refused' };
      const next: string[] = [];
      for (const group of rows) {
        if (group.type === 'static' && group.hasRuleMembers) return { verdict: 'refused' };
        // A static group's leftover rules decide nothing.
        const rules = group.type === 'dynamic' && group.filterConditions !== null && group.filterConditions !== undefined
          ? readGroup(group.filterConditions)
          : null;
        const fields = [...(group.filterFieldsUsed ?? []), ...(rules ? fieldsOf(rules) : [])];
        if (partitionGroupsByExecutionFieldProvenance([{ id: group.id, filterFieldsUsed: fields }]).refusedGroups.length > 0) return { verdict: 'refused' };
        judged.set(group.id.toLowerCase(), { group, rules });
        for (const id of rules ? referencesOf(rules) : []) {
          if (seen.has(id)) continue;
          seen.add(id);
          next.push(id);
        }
      }
      if (seen.size > MAX_GATED_GROUPS) return { verdict: 'refused' };
      frontier = next;
    }
  } catch (error) {
    if (error instanceof UnreadableRules) return { verdict: 'refused' };
    throw error;
  }
  try {
    return { verdict: 'ok', members: compileMembers(orgId, groupId, judged) };
  } catch {
    // Compiling reads no database: whatever the engine throws here is a rule it cannot render.
    return { verdict: 'refused' };
  }
}

/** The groups `orgId` holds among `ids`, as the gate judges them. Runs on the caller's context. */
export async function loadGatedGroups(executor: Pick<typeof db, 'select' | 'selectDistinct'>, orgId: string, ids: string[]): Promise<GatedGroup[]> {
  const rows = await executor
    .select({
      id: deviceGroups.id,
      type: deviceGroups.type,
      siteId: deviceGroups.siteId,
      filterFieldsUsed: deviceGroups.filterFieldsUsed,
      filterConditions: deviceGroups.filterConditions,
    })
    .from(deviceGroups)
    .where(and(inArray(deviceGroups.id, ids), eq(deviceGroups.orgId, orgId)));
  const staticIds = rows.filter((r) => r.type === 'static').map((r) => r.id);
  if (staticIds.length === 0) return rows.map((r) => ({ ...r, hasRuleMembers: false }));
  const inStaticGroup = and(inArray(deviceGroupMemberships.groupId, staticIds), eq(deviceGroupMemberships.orgId, orgId));
  const ruleAdded = await executor
    .selectDistinct({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(and(inStaticGroup, ne(deviceGroupMemberships.addedBy, 'manual')));
  // Pinning marks a row `manual` and a withdrawn pin leaves it so, hence the
  // log. A join, so the log (no index on its group) is read once.
  const withdrawnPin = await executor
    .selectDistinct({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .innerJoin(groupMembershipLog, and(
      eq(groupMembershipLog.groupId, deviceGroupMemberships.groupId),
      eq(groupMembershipLog.deviceId, deviceGroupMemberships.deviceId),
      gte(groupMembershipLog.createdAt, deviceGroupMemberships.addedAt),
    ))
    .where(and(
      inStaticGroup,
      eq(deviceGroupMemberships.isPinned, false),
      inArray(groupMembershipLog.groupId, staticIds),
      eq(groupMembershipLog.orgId, orgId),
      eq(groupMembershipLog.reason, 'pinned'),
    ));
  const withRuleMembers = new Set([...ruleAdded, ...withdrawnPin].map((r) => r.groupId));
  return rows.map((r) => ({ ...r, hasRuleMembers: withRuleMembers.has(r.id) }));
}
