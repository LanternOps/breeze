import type { ApplyAssignmentsInput } from '@breeze/shared';
import type { ConfigPolicyTargetLevel } from '../appliesToSummary';

// The staged applies-to draft (#12467, plan W02c P1). The panel edits this
// list in memory; nothing reaches the API until Apply, which sends only the
// rows that changed. A row the caller never touched is never in the request,
// so an Apply cannot overwrite a row another editor added after the panel
// loaded (Review Focus 4).

/** An assignment row as `GET /configuration-policies/:id/assignments` returns it. */
export interface StoredAssignment {
  id: string;
  level: ConfigPolicyTargetLevel;
  targetId: string;
  priority: number;
  roleFilter: string[] | null;
  osFilter: string[] | null;
}

export interface RowEdits {
  priority?: number;
  roleFilter?: string[] | null;
  osFilter?: string[] | null;
}

export type DraftRow =
  | {
      kind: 'existing';
      key: string;
      assignment: StoredAssignment;
      edits?: RowEdits;
      removed?: boolean;
      /** Removed by the All organizations switch, so Specific targets restores it. */
      removedByScope?: boolean;
    }
  | {
      kind: 'added';
      key: string;
      level: ConfigPolicyTargetLevel;
      /** '' for a partner row: the server derives that target (#1724). */
      targetId: string;
      name: string | null;
      priority: number;
      roleFilter: string[] | null;
      osFilter: string[] | null;
    };

export type DraftAction =
  | { type: 'reset'; assignments: StoredAssignment[] }
  | { type: 'add'; target: { level: ConfigPolicyTargetLevel; targetId: string; name: string | null } }
  | { type: 'remove'; key: string }
  | { type: 'restore'; key: string }
  | { type: 'edit'; key: string; patch: RowEdits }
  | { type: 'setAllOrganizations'; on: boolean };

/** `[]` and null both mean "every device", as the API stores them. */
export function normalizeFilter(filter: readonly string[] | null | undefined): string[] | null {
  return filter && filter.length > 0 ? [...filter].sort() : null;
}

function sameFilter(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const left = normalizeFilter(a);
  const right = normalizeFilter(b);
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

export function draftFromAssignments(assignments: readonly StoredAssignment[]): DraftRow[] {
  return assignments.map((assignment) => ({ kind: 'existing', key: assignment.id, assignment }));
}

/** The row's values with its staged edits applied. */
export function effectiveRow(row: DraftRow): {
  level: ConfigPolicyTargetLevel;
  targetId: string;
  priority: number;
  roleFilter: string[] | null;
  osFilter: string[] | null;
} {
  if (row.kind === 'added') {
    return { level: row.level, targetId: row.targetId, priority: row.priority, roleFilter: row.roleFilter, osFilter: row.osFilter };
  }
  const { assignment, edits } = row;
  return {
    level: assignment.level,
    targetId: assignment.targetId,
    priority: edits?.priority ?? assignment.priority,
    roleFilter: edits && 'roleFilter' in edits ? (edits.roleFilter ?? null) : assignment.roleFilter,
    osFilter: edits && 'osFilter' in edits ? (edits.osFilter ?? null) : assignment.osFilter,
  };
}

/** The edits that differ from the stored row; an edit back to the stored value drops out. */
function pruneEdits(assignment: StoredAssignment, edits: RowEdits): RowEdits | undefined {
  const next: RowEdits = {};
  if (edits.priority !== undefined && edits.priority !== assignment.priority) next.priority = edits.priority;
  if ('roleFilter' in edits && !sameFilter(edits.roleFilter, assignment.roleFilter)) next.roleFilter = normalizeFilter(edits.roleFilter);
  if ('osFilter' in edits && !sameFilter(edits.osFilter, assignment.osFilter)) next.osFilter = normalizeFilter(edits.osFilter);
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Whether a row is in the draft and not staged for removal. */
export function rowIsLive(row: DraftRow): boolean {
  return row.kind === 'added' || !row.removed;
}

const targetKey = (level: string, targetId: string) => `${level}:${targetId}`;

let addedSeq = 0;
const nextAddedKey = () => `added-${++addedSeq}`;

function addPartnerRow(rows: DraftRow[]): DraftRow[] {
  if (rows.some((row) => rowIsLive(row) && effectiveRow(row).level === 'partner')) return rows;
  const removedStored = rows.find((row) => row.kind === 'existing' && row.removed && row.assignment.level === 'partner');
  if (removedStored) {
    return rows.map((row) => (row === removedStored ? { ...row, removed: false, removedByScope: false } : row));
  }
  return [
    ...rows,
    { kind: 'added', key: nextAddedKey(), level: 'partner', targetId: '', name: null, priority: 0, roleFilter: null, osFilter: null },
  ];
}

export function appliesToDraftReducer(rows: DraftRow[], action: DraftAction): DraftRow[] {
  switch (action.type) {
    case 'reset':
      return draftFromAssignments(action.assignments);

    case 'add': {
      const { level, targetId, name } = action.target;
      const key = targetKey(level, targetId);
      const same = rows.find((row) => targetKey(effectiveRow(row).level, effectiveRow(row).targetId) === key);
      if (same) {
        // Re-adding a target staged for removal restores the stored row (and
        // keeps its id) instead of sending a remove and an add for one target.
        if (same.kind === 'existing' && same.removed) {
          return rows.map((row) => (row === same ? { ...row, removed: false, removedByScope: false } : row));
        }
        return rows;
      }
      return [...rows, { kind: 'added', key: nextAddedKey(), level, targetId, name, priority: 0, roleFilter: null, osFilter: null }];
    }

    case 'remove':
      return rows.flatMap((row): DraftRow[] => {
        if (row.key !== action.key) return [row];
        if (row.kind === 'added') return [];
        return [{ ...row, removed: true, removedByScope: false }];
      });

    case 'restore':
      return rows.map((row) =>
        row.key === action.key && row.kind === 'existing' ? { ...row, removed: false, removedByScope: false } : row,
      );

    case 'edit':
      return rows.map((row) => {
        if (row.key !== action.key) return row;
        if (row.kind === 'added') {
          return {
            ...row,
            ...(action.patch.priority !== undefined ? { priority: action.patch.priority } : {}),
            ...('roleFilter' in action.patch ? { roleFilter: normalizeFilter(action.patch.roleFilter) } : {}),
            ...('osFilter' in action.patch ? { osFilter: normalizeFilter(action.patch.osFilter) } : {}),
          };
        }
        const edits = pruneEdits(row.assignment, { ...row.edits, ...action.patch });
        const { edits: _dropped, ...rest } = row;
        return edits ? { ...rest, edits } : rest;
      });

    case 'setAllOrganizations': {
      if (action.on) {
        // All organizations is one partner row. It replaces the organization
        // rows, as the old organization checklist did; site, group and device
        // rows are left as they are.
        const withoutOrgs = rows.flatMap((row): DraftRow[] => {
          if (row.kind === 'added') return row.level === 'organization' ? [] : [row];
          if (row.assignment.level === 'organization' && !row.removed) return [{ ...row, removed: true, removedByScope: true }];
          return [row];
        });
        return addPartnerRow(withoutOrgs);
      }
      return rows.flatMap((row): DraftRow[] => {
        if (row.kind === 'added') return row.level === 'partner' ? [] : [row];
        if (row.assignment.level === 'partner') return [{ ...row, removed: true, removedByScope: false }];
        if (row.removedByScope) return [{ ...row, removed: false, removedByScope: false }];
        return [row];
      });
    }
  }
}

export type ApplyPayload = Required<Pick<ApplyAssignmentsInput, 'add' | 'update' | 'remove'>>;

/** Which draft row each request entry came from, by list and index, for naming a refused entry. */
export interface ApplyPayloadKeys {
  add: string[];
  update: string[];
  remove: string[];
}

/** The request for the draft: only changed rows; an unchanged stored row never appears. */
export function draftToApplyPayload(rows: readonly DraftRow[]): { payload: ApplyPayload; keys: ApplyPayloadKeys } {
  const payload: ApplyPayload = { add: [], update: [], remove: [] };
  const keys: ApplyPayloadKeys = { add: [], update: [], remove: [] };
  for (const row of rows) {
    if (row.kind === 'existing' && row.removed) {
      payload.remove.push(row.assignment.id);
      keys.remove.push(row.key);
    }
  }
  for (const row of rows) {
    if (row.kind !== 'existing' || row.removed || !row.edits) continue;
    payload.update.push({ id: row.assignment.id, ...row.edits } as ApplyPayload['update'][number]);
    keys.update.push(row.key);
  }
  for (const row of rows) {
    if (row.kind !== 'added') continue;
    const roleFilter = normalizeFilter(row.roleFilter);
    const osFilter = normalizeFilter(row.osFilter);
    payload.add.push({
      level: row.level,
      // The partner target is derived server-side; any client value is ignored.
      ...(row.level === 'partner' ? {} : { targetId: row.targetId }),
      priority: row.priority,
      // The add schema's filters are optional, not nullable: omit "every device".
      ...(roleFilter ? { roleFilter } : {}),
      ...(osFilter ? { osFilter } : {}),
    } as ApplyPayload['add'][number]);
    keys.add.push(row.key);
  }
  return { payload, keys };
}

export function draftIsDirty(rows: readonly DraftRow[]): boolean {
  return rows.some((row) => row.kind === 'added' || row.removed || !!row.edits);
}

/** The draft row a request entry names, or undefined when the ref is out of range. */
export function rowKeyForEntry(keys: ApplyPayloadKeys, entry: { op: 'add' | 'update' | 'remove'; index: number }): string | undefined {
  return keys[entry.op][entry.index];
}
