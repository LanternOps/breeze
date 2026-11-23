/**
 * POST /configuration-policies/:id/assignments/apply (#12466, plan W02b G4).
 *
 * The staged Apply: one diff-shaped request that removes, edits and adds
 * assignments of one policy, as one stated change. It runs the same gates as
 * the single POST and DELETE (assignmentGates.ts), all of them before any
 * write, and the first failure answers with its status and names its entry.
 *
 * WRITES. Remove, then update, then add, inside ONE `withDbTransaction`
 * savepoint. A duplicate add (`assignPolicy` returns null), or an update or
 * remove that matches nothing (another editor got there first), throws
 * `AssignmentApplyConflictError`, caught OUTSIDE the savepoint: the savepoint
 * rolls the whole Apply back and the route answers 409. Without the savepoint
 * the earlier writes would commit with the request transaction even on a 409.
 * Audit rows and the remote-access cache flush happen only after the savepoint
 * committed. A row the request does not name is never touched.
 *
 * DRY RUN. The same checks, then the device delta of the proposed set against
 * the stored one (`computeAssignmentDelta`, plan D10), bounded like reach and
 * marked `partial` past the bound. Nothing is written.
 *
 * BOUND. The real Apply expands no device: it writes rows, so it can never act
 * on a truncated expansion. Its work is bounded by the schema's caps (at most
 * 200 entries per list): one stored-row read for every update and remove, one
 * set-based site-axis read (at most three statements), one target validation
 * per add, and one write per entry.
 */
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import type { AuthContext } from '../../middleware/auth';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { withDbTransaction } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import type { UserPermissions } from '../../services/permissions';
import {
  getConfigPolicy,
  assignPolicy,
  unassignPolicy,
  updateAssignment,
  getAssignments,
  listAssignments,
  validateAssignmentTarget,
  authorizeAssignmentTarget,
  authorizeAssignmentTargets,
  assignmentTargetKey,
} from '../../services/configurationPolicy';
import type { ConfigAssignmentLevel } from '../../services/configurationPolicy';
import { computeAssignmentDelta } from '../../services/configPolicyReach';
import type { AssignmentToExpand } from '../../services/configPolicyAssignmentDevices';
import { invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import { applyAssignmentsSchema, idParamSchema } from './schemas';
import { checkAddArming, checkAddLevel, checkPolicyAssignableBy } from './assignmentGates';

export const assignmentApplyRoutes = new Hono();
const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

type ApplyEntry = { op: 'add' | 'update' | 'remove'; index: number };

/** A write in the savepoint found the table changed under it. Never escapes the route. */
class AssignmentApplyConflictError extends Error {
  constructor(readonly entry: ApplyEntry) {
    super('assignment_conflict');
    this.name = 'AssignmentApplyConflictError';
  }
}

const CONFLICT_MESSAGE = 'The assignments changed since they were loaded; nothing was applied. Reload and try again.';

/** `[]` and null both mean "every device", as `assignPolicy` stores them. */
function normalizeFilter(filter: readonly string[] | null | undefined): string[] | null {
  return filter?.length ? [...filter] : null;
}

function sameFilter(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

type FilterPatch = { priority?: number; roleFilter?: string[] | null; osFilter?: string[] | null };
type StoredValues = { priority: number; roleFilter: string[] | null; osFilter: string[] | null };

/** Whether applying `patch` (an omitted field is left as it is) would change `stored`. */
function patchChangesRow(patch: FilterPatch, stored: StoredValues): boolean {
  if (patch.priority !== undefined && patch.priority !== stored.priority) return true;
  if (patch.roleFilter !== undefined && !sameFilter(normalizeFilter(patch.roleFilter), stored.roleFilter ?? null)) return true;
  if (patch.osFilter !== undefined && !sameFilter(normalizeFilter(patch.osFilter), stored.osFilter ?? null)) return true;
  return false;
}

assignmentApplyRoutes.post(
  '/:id/assignments/apply',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', applyAssignmentsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const assignable = checkPolicyAssignableBy(auth, policy);
    if (!assignable.ok) return c.json(assignable.body, assignable.status);

    if (!data.dryRun && data.add.length === 0 && data.update.length === 0 && data.remove.length === 0) {
      return c.json({ error: 'Nothing to apply' }, 400);
    }

    // ---- Every check, before any write -----------------------------------

    // The stored rows every update and remove names, in one read.
    const touchedIds = [...data.update.map((entry) => entry.id), ...data.remove];
    const storedRows = await getAssignments(touchedIds, id);
    const storedById = new Map(storedRows.map((row) => [row.id, row]));

    // Derive each add's target as the single POST does. A partner-level target
    // is the policy's own partner (or the caller's, for a partner-owned policy),
    // derived server-side (#1724): a client-supplied partner id is ignored.
    const addTargets = data.add.map((entry): string | undefined => {
      if (entry.level !== 'partner') return entry.targetId;
      return policy.partnerId ?? auth.partnerId ?? undefined;
    });

    // The site and device ceiling for every target at once (set-based, at most
    // three statements). Evaluated per entry below, in order.
    const ceilingTargets: Array<{ level: ConfigAssignmentLevel; targetId: string }> = [];
    data.add.forEach((entry, index) => {
      const targetId = addTargets[index];
      if (targetId) ceilingTargets.push({ level: entry.level, targetId });
    });
    for (const row of storedRows) ceilingTargets.push({ level: row.level as ConfigAssignmentLevel, targetId: row.targetId });
    const ceiling = await authorizeAssignmentTargets(auth, ceilingTargets);

    const ceilingRefusal = async (level: ConfigAssignmentLevel, targetId: string, entry: ApplyEntry) => {
      if (ceiling.get(assignmentTargetKey(level, targetId)) === true) return null;
      // The per-target check carries the message. It runs only for the one
      // refused entry; if it disagrees with the set-based check, fail closed.
      const single = await authorizeAssignmentTarget(auth, level, targetId);
      const error = single.valid ? 'This assignment target is outside your access' : single.error;
      return c.json({ error, entry }, 403);
    };

    for (const [index, entry] of data.add.entries()) {
      const ref: ApplyEntry = { op: 'add', index };
      const targetId = addTargets[index];
      if (!targetId) {
        if (entry.level === 'partner') return c.json({ error: 'Partner-wide assignments require partner scope', entry: ref }, 403);
        return c.json({ error: 'targetId is required for this assignment level', entry: ref }, 400);
      }
      const validation = await validateAssignmentTarget({ orgId: policy.orgId, partnerId: policy.partnerId }, entry.level, targetId);
      if (!validation.valid) {
        const status = validation.code === 'PARTNER_GROUP_TARGET_UNSUPPORTED' ? validation.status : 403;
        return c.json({ error: validation.error, code: validation.code, entry: ref }, status);
      }
      const refused = await ceilingRefusal(entry.level, targetId, ref);
      if (refused) return refused;
      const levelGate = checkAddLevel(policy, entry.level);
      if (!levelGate.ok) return c.json({ ...levelGate.body, entry: ref }, levelGate.status);
    }
    const checkStored = async (assignmentId: string, ref: ApplyEntry) => {
      const stored = storedById.get(assignmentId);
      if (!stored) return c.json({ error: 'Assignment not found', entry: ref }, 404);
      return ceilingRefusal(stored.level as ConfigAssignmentLevel, stored.targetId, ref);
    };
    for (const [index, entry] of data.update.entries()) {
      const refused = await checkStored(entry.id, { op: 'update', index });
      if (refused) return refused;
    }
    for (const [index, assignmentId] of data.remove.entries()) {
      const refused = await checkStored(assignmentId, { op: 'remove', index });
      if (refused) return refused;
    }

    // The arming gates (HP CMSL, vendor updates), once per Apply: the policy,
    // not an entry, decides them. An added row is how an armed policy reaches
    // devices; so is an edited one, since priority decides where the policy
    // wins and the filters decide which devices it reaches. Removes and
    // updates that change nothing do not run them.
    const editsReach = data.update.some((entry) => patchChangesRow(entry, storedById.get(entry.id)!));
    if (data.add.length > 0 || editsReach) {
      const armingGate = checkAddArming(auth, c.get('permissions') as UserPermissions | undefined, policy);
      if (!armingGate.ok) return c.json(armingGate.body, armingGate.status);
    }

    // ---- Dry run: the device delta, nothing written -----------------------

    if (data.dryRun) {
      const current = await listAssignments(id);
      const removing = new Set(data.remove);
      const updates = new Map(data.update.map((entry) => [entry.id, entry]));
      const kept = current.filter((row) => !removing.has(row.id));

      // Predict the collision the real Apply would hit (its writes remove
      // first, so a removed row's target is free to add again).
      const taken = new Set(kept.map((row) => `${row.level}:${row.targetId}`));
      for (const [index, entry] of data.add.entries()) {
        const key = `${entry.level}:${addTargets[index]}`;
        if (taken.has(key)) {
          return c.json({ error: 'assignment_conflict', message: 'This policy is already assigned to this target at this level', entry: { op: 'add', index } }, 409);
        }
        taken.add(key);
      }

      const toExpand = (row: { level: string; targetId: string; roleFilter: string[] | null; osFilter: string[] | null }): AssignmentToExpand => ({
        level: row.level,
        targetId: row.targetId,
        roleFilter: row.roleFilter ?? null,
        osFilter: row.osFilter ?? null,
      });
      const proposed: AssignmentToExpand[] = kept.map((row) => {
        const patch = updates.get(row.id);
        return toExpand({
          level: row.level,
          targetId: row.targetId,
          roleFilter: patch?.roleFilter !== undefined ? normalizeFilter(patch.roleFilter) : row.roleFilter,
          osFilter: patch?.osFilter !== undefined ? normalizeFilter(patch.osFilter) : row.osFilter,
        });
      });
      data.add.forEach((entry, index) => {
        proposed.push(toExpand({
          level: entry.level,
          targetId: addTargets[index]!,
          roleFilter: normalizeFilter(entry.roleFilter),
          osFilter: normalizeFilter(entry.osFilter),
        }));
      });

      const delta = await computeAssignmentDelta(
        auth,
        { orgId: policy.orgId, partnerId: policy.partnerId },
        current.map(toExpand),
        proposed,
      );
      return c.json({ dryRun: true, delta }, 200);
    }

    // ---- The writes, in one savepoint -------------------------------------

    let outcome: {
      removed: NonNullable<Awaited<ReturnType<typeof unassignPolicy>>>[];
      updated: NonNullable<Awaited<ReturnType<typeof updateAssignment>>>[];
      added: NonNullable<Awaited<ReturnType<typeof assignPolicy>>>[];
    };
    try {
      outcome = await withDbTransaction(async () => {
        const removed: NonNullable<Awaited<ReturnType<typeof unassignPolicy>>>[] = [];
        for (const [index, assignmentId] of data.remove.entries()) {
          const row = await unassignPolicy(assignmentId, id);
          if (!row) throw new AssignmentApplyConflictError({ op: 'remove', index });
          removed.push(row);
        }
        const updated: NonNullable<Awaited<ReturnType<typeof updateAssignment>>>[] = [];
        for (const [index, entry] of data.update.entries()) {
          const { id: assignmentId, ...patch } = entry;
          const row = await updateAssignment(assignmentId, id, patch);
          if (!row) throw new AssignmentApplyConflictError({ op: 'update', index });
          updated.push(row);
        }
        const added: NonNullable<Awaited<ReturnType<typeof assignPolicy>>>[] = [];
        for (const [index, entry] of data.add.entries()) {
          const row = await assignPolicy(
            id,
            entry.level,
            addTargets[index]!,
            entry.priority ?? 0,
            auth.user.id,
            entry.roleFilter,
            entry.osFilter,
          );
          if (!row) throw new AssignmentApplyConflictError({ op: 'add', index });
          added.push(row);
        }
        return { removed, updated, added };
      });
    } catch (error) {
      if (error instanceof AssignmentApplyConflictError) {
        return c.json({ error: 'assignment_conflict', message: CONFLICT_MESSAGE, entry: error.entry }, 409);
      }
      throw error;
    }

    // ---- After the savepoint committed ------------------------------------

    invalidateRemoteAccessCache();
    const auditBase = {
      orgId: policy.orgId,
      resourceType: 'configuration_policy',
      resourceId: id,
      resourceName: policy.name,
    };
    for (const row of outcome.removed) {
      writeRouteAudit(c, {
        ...auditBase,
        action: 'config_policy.unassign',
        details: { assignmentId: row.id, level: row.level, targetId: row.targetId, via: 'apply' },
      });
    }
    for (const row of outcome.updated) {
      // `updateAssignment` returns an unchanged row as it is: no change, no audit row.
      const before = storedById.get(row.id);
      if (before && !patchChangesRow(row, before)) continue;
      writeRouteAudit(c, {
        ...auditBase,
        action: 'config_policy.assignment_update',
        details: {
          assignmentId: row.id,
          level: row.level,
          targetId: row.targetId,
          priority: row.priority,
          roleFilter: row.roleFilter ?? null,
          osFilter: row.osFilter ?? null,
          via: 'apply',
        },
      });
    }
    for (const row of outcome.added) {
      writeRouteAudit(c, {
        ...auditBase,
        action: 'config_policy.assign',
        details: { level: row.level, targetId: row.targetId, priority: row.priority, via: 'apply' },
      });
    }

    return c.json(outcome, 201);
  }
);
