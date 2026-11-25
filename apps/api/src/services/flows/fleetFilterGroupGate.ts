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
 *
 * The whole check has one time budget (`GroupCheckBudget`), however many
 * groups and reads it takes. A check that outruns it has no verdict.
 */
import { and, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { filterConditionSchema } from '@breeze/shared/validators';
import type { db } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices, groupMembershipLog } from '../../db/schema';
import { partitionGroupsByExecutionFieldProvenance } from '../executionTargetGating';
import {
  buildConditionSQL,
  FILTER_QUERY_TIMEOUT_MS,
  FilterQueryTimeoutError,
  getFieldDefinition,
  validateFilter,
  type FilterCondition,
} from '../filterEngine';

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

/** Resolve: the groups one step's filter reaches, within the filter engine's own bound for a statement. */
export const GROUP_CHECK_STEP_BUDGET_MS = FILTER_QUERY_TIMEOUT_MS;
/**
 * Save: every group a whole document names, together. Room for a few reads
 * near the statement bound, and below the 2 s at which a held connection is
 * reported (`DB_CONTEXT_HELD_WARN_MS`).
 */
export const GROUP_CHECK_DOCUMENT_BUDGET_MS = 3 * FILTER_QUERY_TIMEOUT_MS;

/**
 * Less than this left is nothing left. A statement_timeout of 0 is none at all,
 * and the statement that restores the timeout runs under the last limit set.
 */
export const GROUP_CHECK_MIN_STATEMENT_MS = 25;

/**
 * The time one whole check may take, from its first use of the database.
 * `bound` goes before each statement; the statement may then run for what is
 * left, never longer than the engine's bound for any one statement. With
 * nothing left it throws before the statement is sent.
 */
export class GroupCheckBudget {
  private readonly deadline: number;

  constructor(totalMs: number, private readonly now: () => number = () => performance.now()) {
    this.deadline = now() + totalMs;
  }

  /** Whole milliseconds left, at least `GROUP_CHECK_MIN_STATEMENT_MS`. */
  remainingMs(): number {
    const left = Math.floor(this.deadline - this.now());
    if (!(left >= GROUP_CHECK_MIN_STATEMENT_MS)) throw new FilterQueryTimeoutError();
    return left;
  }

  async bound(executor: Pick<typeof db, 'execute'>): Promise<void> {
    const ms = Math.min(this.remainingMs(), FILTER_QUERY_TIMEOUT_MS);
    await executor.execute(sql`select set_config('statement_timeout', ${`${ms}ms`}, true)`);
  }
}

/** How a check reads groups: `load` sends each of its statements through `budget`. */
export interface GroupReads {
  load: (ids: string[]) => Promise<GatedGroup[]>;
  budget: GroupCheckBudget;
}

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
function compileMembers(orgId: string, groupId: string, judged: ReadonlyMap<string, JudgedGroup>, budget: GroupCheckBudget): SQL {
  let compiled = 0;

  const rowExists = (id: string, kind: SQL): SQL =>
    sql`EXISTS (SELECT 1 FROM ${deviceGroupMemberships} WHERE ${deviceGroupMemberships.deviceId} = ${devices.id} AND ${deviceGroupMemberships.groupId} = ${id} AND ${deviceGroupMemberships.orgId} = ${orgId} AND ${kind})`;

  const group = (id: string): SQL => {
    budget.remainingMs();
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

type GroupWalk =
  | { groupId: string; seen: Set<string>; frontier: string[] }
  | { groupId: string; verdict: 'missing' | 'refused' };

/** The group and its rules, or null when it may not select script targets whatever else the walk finds. */
function judgeRow(group: GatedGroup): JudgedGroup | null {
  if (group.type === 'static' && group.hasRuleMembers) return null;
  let rules: RuleNode | null;
  try {
    // A static group's leftover rules decide nothing.
    rules = group.type === 'dynamic' && group.filterConditions !== null && group.filterConditions !== undefined
      ? readGroup(group.filterConditions)
      : null;
  } catch (error) {
    if (error instanceof UnreadableRules) return null;
    throw error;
  }
  const fields = [...(group.filterFieldsUsed ?? []), ...(rules ? fieldsOf(rules) : [])];
  if (partitionGroupsByExecutionFieldProvenance([{ id: group.id, filterFieldsUsed: fields }]).refusedGroups.length > 0) return null;
  return { group, rules };
}

/** One level of one walk over the rows read so far. */
function stepWalk(walk: Extract<GroupWalk, { frontier: string[] }>, rows: ReadonlyMap<string, JudgedGroup | null>): GroupWalk {
  if (walk.frontier.some((id) => !rows.has(id))) return { groupId: walk.groupId, verdict: walk.seen.size === 1 ? 'missing' : 'refused' };
  const next: string[] = [];
  for (const id of walk.frontier) {
    const entry = rows.get(id);
    if (!entry) return { groupId: walk.groupId, verdict: 'refused' };
    for (const ref of entry.rules ? referencesOf(entry.rules) : []) {
      if (walk.seen.has(ref)) continue;
      walk.seen.add(ref);
      next.push(ref);
    }
  }
  if (walk.seen.size > MAX_GATED_GROUPS) return { groupId: walk.groupId, verdict: 'refused' };
  return { ...walk, frontier: next };
}

/**
 * Judges the named groups of ONE org together, each group read once whatever
 * names it: the walks advance level by level, so `load` runs at most once per
 * level (`MAX_GATED_GROUPS`). `load` returns the groups the checked org holds
 * among `ids`; `missing`: the named group itself is not one of them.
 *
 * Throws `FilterQueryTimeoutError` when the budget is used up. There is then
 * no verdict for any of the groups: a caller refuses them all.
 */
export async function judgeFleetFilterGroups(
  orgId: string,
  namedGroupIds: Iterable<string>,
  { load, budget }: GroupReads,
): Promise<Map<string, FleetFilterGroupVerdict>> {
  const named = [...new Set([...namedGroupIds].map((id) => id.toLowerCase()))];
  const rows = new Map<string, JudgedGroup | null>();
  let walks: GroupWalk[] = named.map((id) => ({ groupId: id, seen: new Set([id]), frontier: [id] }));
  for (;;) {
    const unread = [...new Set(walks.flatMap((w) => ('frontier' in w ? w.frontier : [])))].filter((id) => !rows.has(id));
    if (unread.length > 0) {
      for (const row of await load(unread)) {
        budget.remainingMs();
        rows.set(row.id.toLowerCase(), judgeRow(row));
      }
    }
    if (!walks.some((w) => 'frontier' in w && w.frontier.length > 0)) break;
    walks = walks.map((w) => ('frontier' in w ? stepWalk(w, rows) : w));
  }
  const judged = new Map([...rows].filter((e): e is [string, JudgedGroup] => e[1] !== null));
  const verdicts = new Map<string, FleetFilterGroupVerdict>();
  for (const walk of walks) {
    verdicts.set(walk.groupId, 'verdict' in walk ? { verdict: walk.verdict } : compileVerdict(orgId, walk.groupId, judged, budget));
  }
  return verdicts;
}

function compileVerdict(orgId: string, groupId: string, judged: ReadonlyMap<string, JudgedGroup>, budget: GroupCheckBudget): FleetFilterGroupVerdict {
  try {
    return { verdict: 'ok', members: compileMembers(orgId, groupId, judged, budget) };
  } catch (error) {
    if (error instanceof FilterQueryTimeoutError) throw error;
    // Compiling reads no database: whatever the engine throws here is a rule it cannot render.
    return { verdict: 'refused' };
  }
}

/** `judgeFleetFilterGroups` for one group. */
export async function judgeFleetFilterGroup(orgId: string, groupId: string, reads: GroupReads): Promise<FleetFilterGroupVerdict> {
  return (await judgeFleetFilterGroups(orgId, [groupId], reads)).get(groupId.toLowerCase()) ?? { verdict: 'refused' };
}

/**
 * The groups `orgId` holds among `ids`, as the gate judges them. Runs in the
 * caller's context, on a transaction of `withFilterStatementTimeout` (which
 * turns a cancelled statement into `FilterQueryTimeoutError` and restores the
 * timeout).
 */
export async function loadGatedGroups(
  executor: Pick<typeof db, 'select' | 'selectDistinct' | 'execute'>,
  orgId: string,
  ids: string[],
  budget: GroupCheckBudget,
): Promise<GatedGroup[]> {
  await budget.bound(executor);
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
  await budget.bound(executor);
  const ruleAdded = await executor
    .selectDistinct({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(and(inStaticGroup, ne(deviceGroupMemberships.addedBy, 'manual')));
  // The log tells an add by hand from a member kept for another reason. A join,
  // so the log (no index on its group) is read once.
  await budget.bound(executor);
  const notByHand = await executor
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
  const withRuleMembers = new Set([...ruleAdded, ...notByHand].map((r) => r.groupId));
  return rows.map((r) => ({ ...r, hasRuleMembers: withRuleMembers.has(r.id) }));
}
