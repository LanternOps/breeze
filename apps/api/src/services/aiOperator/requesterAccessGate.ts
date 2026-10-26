/**
 * Re-checks a manual-delegation AI Operator task's requester's LIVE access
 * before a new effect (Recipe Library / AI Operator spec §5.1: "Manual
 * delegation captures the requester's authorized org/site/target ceiling and
 * rechecks current access before each new effect. Loss of that access pauses
 * delegated execution.").
 *
 * Admission (`routes/aiOperatorTasks.ts`) checks the requester's access ONCE,
 * at delegation time, and stamps `requesterUserId` for later re-evaluation —
 * but nothing previously re-read that stamp. This module is that re-read. It
 * is called from `taskCoordinator.ts`'s `advanceExecute`, the step that sits
 * immediately before a device command is dispatched — the natural new-effect
 * boundary for the `service_recovery` recipe today.
 *
 * Mirrors the admission-time check exactly — `auth.canAccessOrg(orgId)` then
 * (for a site-restricted caller) `auth.canAccessSite(device.siteId)` — using
 * the SAME `canAccessOrg`/`canAccessSite` helpers the request-path
 * `AuthContext` is built from, so live re-evaluation cannot drift from what a
 * fresh request would decide. The permission cache is deliberately skipped: this check
 * exists to answer "right now", not "as of up to five minutes ago".
 *
 * SCOPE NOTE: a partner-scope requester's continuing access is approximated
 * from their CURRENT home partner (`users.partnerId`), not from a partnerId
 * denormalized onto the task at admission time — `ai_operator_tasks` carries
 * no such column today, unlike `action_intents.partnerId` (see
 * `actionIntents/actorContext.ts`, the analogous release-time re-derivation
 * this module is modeled on). A partner requester whose partner affiliation
 * itself changed between delegation and this check is not specially handled;
 * flagged as a residual gap rather than silently assumed away.
 */
import { eq, and } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema/users';
import { devices } from '../../db/schema/devices';
import { aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { organizations } from '../../db/schema/orgs';
import { contacts } from '../../db/schema/contacts';
import { tickets } from '../../db/schema/portal';
import { canAccessOrg, canAccessSite, getUserPermissions, type UserPermissions } from '../permissions';
import { canMutateOrgWideGovernance, type SiteCeilingAuth } from '../siteCeilingAccess';
import {
  assertWithinCeiling,
  CeilingViolationError,
  GrantInactiveError,
  resolveGrantCeiling,
  type CeilingCheck,
} from '../wisp/grantAuthority';
import { normalizeSiteAllowlist } from '../siteAllowlist';

export interface RequesterAccessCheck {
  lost: boolean;
  /** Human-readable reason, null when `lost` is false. */
  detail: string | null;
}

const ACCESS_OK: RequesterAccessCheck = { lost: false, detail: null };

/** The grant pin a Wisp-launched task carries (both or none). */
type TaskGrantPin = { grantId?: string | null; grantRevisionId?: string | null };

/**
 * Wisp W02 (Wisp design §4.3): a task launched under a delegation grant is
 * also bounded by the pinned revision's LIVE ceiling — "permissions, not only
 * access". Null when there is no grant or the check passes; a lost check
 * otherwise. Runs inside the caller's system context (resolveGrantCeiling
 * reuses it).
 */
async function grantCeilingLost(
  task: TaskGrantPin & { orgId: string; requesterUserId: string | null },
  check: Omit<CeilingCheck, 'orgId'>,
): Promise<RequesterAccessCheck | null> {
  if (!task.grantId) return null;
  if (!task.grantRevisionId) return { lost: true, detail: 'the delegation grant pin is incomplete' };
  let ceiling;
  try {
    ceiling = await resolveGrantCeiling(task.grantId, task.grantRevisionId);
  } catch (error) {
    if (error instanceof GrantInactiveError) return { lost: true, detail: 'the delegation grant is no longer active' };
    throw error;
  }
  // A grant is one person's borrowed authority: the task's requester (whose
  // live access is re-checked above) must BE that person.
  if (ceiling.grantorUserId !== task.requesterUserId) {
    return { lost: true, detail: 'the task requester is not the delegation grant\'s grantor' };
  }
  try {
    assertWithinCeiling(ceiling, { orgId: task.orgId, ...check });
  } catch (error) {
    if (error instanceof CeilingViolationError) {
      return { lost: true, detail: `the next effect is outside the delegation ceiling (${error.code})` };
    }
    throw error;
  }
  return null;
}

/**
 * `task` is intentionally a minimal pick, not the full row type, so a caller
 * with only the id/requester/org columns in hand (e.g. a reconciler scan that
 * re-reads a narrower projection) can still call this without a wider query.
 *
 * `effect` (Wisp W02) names the next effect's permission (and tool, when
 * known); it is checked against a grant-bearing task's ceiling. It defaults to
 * `devices:execute`: this gate sits immediately before a DEVICE COMMAND
 * dispatch (header above), so that is the effect it guards unless told
 * otherwise. Ignored for a task without a grant.
 */
export async function requesterAccessLost(
  task: { orgId: string; requesterUserId: string | null } & TaskGrantPin,
  deviceId: string,
  effect: { permission: string; toolName?: string } = { permission: 'devices:execute' },
): Promise<RequesterAccessCheck> {
  // A delegation grant is always one person's authority: a grant-bearing task
  // without its requester cannot be re-checked, so it is lost, not open.
  if (task.grantId && !task.requesterUserId) {
    return { lost: true, detail: 'the delegated task has no requester to re-check' };
  }
  // No human requester recorded — an automatic/non-delegated task origin has
  // no requester ceiling to re-check.
  if (!task.requesterUserId) return ACCESS_OK;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async (): Promise<RequesterAccessCheck> => {
      const [user] = await db
        .select({ id: users.id, partnerId: users.partnerId, status: users.status })
        .from(users)
        .where(eq(users.id, task.requesterUserId!))
        .limit(1);
      if (!user || user.status !== 'active') {
        return { lost: true, detail: 'the requester account is no longer active' };
      }

      // Skip the permission cache: this recheck answers "does the requester have
      // access RIGHT NOW", not a cached answer up to CACHE_TTL stale — the
      // whole point is catching a membership/role change that just happened.
      const perms = await getUserPermissions(
        user.id,
        { partnerId: user.partnerId, orgId: task.orgId },
        { bypassCache: true },
      );
      if (!perms || !canAccessOrg(perms, task.orgId)) {
        return { lost: true, detail: `the requester no longer has access to organization ${task.orgId}` };
      }

      const [device] = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.orgId, task.orgId)))
        .limit(1);
      if (!device) {
        return { lost: true, detail: 'the target device is no longer in this organization' };
      }
      if (!canAccessSite(perms, device.siteId)) {
        return { lost: true, detail: "the requester no longer has access to the target device's site" };
      }

      const ceilingLost = await grantCeilingLost(task, {
        siteId: device.siteId ?? null,
        permission: effect.permission,
        ...(effect.toolName ? { toolName: effect.toolName } : {}),
      });
      if (ceilingLost) return ceilingLost;

      return ACCESS_OK;
    }),
  );
}

/**
 * More live targets than this is not a shape any recipe admits today; past it
 * the gate cannot have checked every target, so it fails closed.
 */
const MAX_TARGETS_CHECKED = 200;

/**
 * The requester's site/exact-device ceiling, derived the way
 * `buildTaskActorAuthContext` (actionIntents/actorContext.ts) derives it for a
 * user — the context every child effect is minted under: organization scope,
 * the live `allowedSiteIds`, and no exact-device ceiling (only agent runs
 * carry one). A malformed allowlist normalizes to `[]` (restricted), so an
 * underivable ceiling is never read as unrestricted.
 */
function requesterCeiling(perms: UserPermissions): SiteCeilingAuth {
  const allowed = normalizeSiteAllowlist(perms.allowedSiteIds);
  return {
    scope: 'organization',
    allowedSiteIds: allowed === undefined ? undefined : [...allowed],
  };
}

/**
 * Re-check a manual-delegation task's requester against the task's LIVE
 * targets before a new effect (spec §5.1), for any recipe whose checkpoint is
 * not the device-keyed service-recovery arm (Recipe Library W06 R1a-0, plan
 * Amendment A.4 decision 3). `requesterAccessLost` above is the device-keyed
 * gate and is unchanged; `advanceTask` selects between them by checkpoint arm.
 *
 * Checks, in order — the first failure is the answer:
 *  1. no requester → OK (automatic origins have no ceiling to re-check);
 *  2. the requester account is active;
 *  3. live permissions (cache bypassed) still reach the org (`canAccessOrg`);
 *  4. a partner-scope requester's partner (`users.partner_id`) is the task
 *     org's `organizations.partner_id` — stated explicitly here, not left to
 *     `orgAccess` semantics;
 *  5. the task has at least one live target (`detached_at IS NULL`) and NO
 *     detached one: the sealed plan may still act on a detached target, and
 *     re-checking only the live ones would let it. The target rows, not the
 *     checkpoint, are the source of truth, because org-merge and ticket-move
 *     detaches write there;
 *  6. per target: a device is in the org and on a site the requester can
 *     reach; a contact is in the org AND the requester carries no site or
 *     exact-device ceiling (`canMutateOrgWideGovernance` — a directory
 *     account has no per-site slice, which is why every mutating Google/M365
 *     tool already refuses a site-restricted caller; the contact's own
 *     `site_id` grants nothing); a ticket is in the org, not soft-deleted,
 *     and — when device-bound — its device is in the org on a site the
 *     requester can reach (the request-path ticket scope). An unknown kind
 *     or a null pointer is lost.
 *
 * Deliberately NOT checked: provider grants. Child effects run as the plan's
 * approver, re-proven per mint; the connection's grants are the executor's.
 *
 * TENANCY: system scope, RLS bypassed. Every read carries an explicit
 * `org_id` predicate, and those predicates are the isolation.
 */
export async function requesterAccessLostForTargets(
  task: { id: string; orgId: string; requesterUserId: string | null } & TaskGrantPin,
): Promise<RequesterAccessCheck> {
  if (task.grantId && !task.requesterUserId) {
    return { lost: true, detail: 'the delegated task has no requester to re-check' };
  }
  if (!task.requesterUserId) return ACCESS_OK;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async (): Promise<RequesterAccessCheck> => {
      const [user] = await db
        .select({ id: users.id, partnerId: users.partnerId, status: users.status })
        .from(users)
        .where(eq(users.id, task.requesterUserId!))
        .limit(1);
      if (!user || user.status !== 'active') {
        return { lost: true, detail: 'the requester account is no longer active' };
      }

      const perms = await getUserPermissions(
        user.id,
        { partnerId: user.partnerId, orgId: task.orgId },
        { bypassCache: true },
      );
      if (!perms || !canAccessOrg(perms, task.orgId)) {
        return { lost: true, detail: `the requester no longer has access to organization ${task.orgId}` };
      }

      if (perms.scope === 'partner') {
        const [org] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, task.orgId))
          .limit(1);
        if (!org || !user.partnerId || org.partnerId !== user.partnerId) {
          return { lost: true, detail: "the task's organization is not under the requester's partner" };
        }
      }

      const targets = await db
        .select({
          id: aiOperatorTaskTargets.id,
          targetKind: aiOperatorTaskTargets.targetKind,
          deviceId: aiOperatorTaskTargets.deviceId,
          contactId: aiOperatorTaskTargets.contactId,
          ticketId: aiOperatorTaskTargets.ticketId,
          detachedAt: aiOperatorTaskTargets.detachedAt,
        })
        .from(aiOperatorTaskTargets)
        .where(and(
          eq(aiOperatorTaskTargets.orgId, task.orgId),
          eq(aiOperatorTaskTargets.taskId, task.id),
        ))
        .limit(MAX_TARGETS_CHECKED + 1);
      if (targets.length > MAX_TARGETS_CHECKED) {
        return { lost: true, detail: `the task has more than ${MAX_TARGETS_CHECKED} targets to re-check` };
      }
      const detached = targets.find((t) => t.detachedAt !== null && t.detachedAt !== undefined);
      if (detached) {
        return { lost: true, detail: `task target ${detached.id} (${detached.targetKind}) was detached` };
      }
      if (targets.length === 0) {
        return { lost: true, detail: 'the task has no live target' };
      }

      // Wisp W02: the site each target sits on (null = org-level), re-checked
      // against a grant-bearing task's ceiling once every target resolved.
      const targetSites = new Set<string | null>();
      for (const target of targets) {
        if (target.targetKind === 'device' && target.deviceId) {
          const [device] = await db
            .select({ id: devices.id, siteId: devices.siteId })
            .from(devices)
            .where(and(eq(devices.id, target.deviceId), eq(devices.orgId, task.orgId)))
            .limit(1);
          if (!device) {
            return { lost: true, detail: 'a target device is no longer in this organization' };
          }
          if (!canAccessSite(perms, device.siteId)) {
            return { lost: true, detail: "the requester no longer has access to a target device's site" };
          }
          targetSites.add(device.siteId ?? null);
          continue;
        }
        if (target.targetKind === 'contact' && target.contactId) {
          const [contact] = await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.id, target.contactId), eq(contacts.orgId, task.orgId)))
            .limit(1);
          if (!contact) {
            return { lost: true, detail: 'a target contact is no longer in this organization' };
          }
          if (!canMutateOrgWideGovernance(requesterCeiling(perms))) {
            return {
              lost: true,
              detail: 'the requester is site-restricted, and a contact\'s directory accounts are organization-wide',
            };
          }
          targetSites.add(null);
          continue;
        }
        if (target.targetKind === 'ticket' && target.ticketId) {
          // Parity with the request-path ticket scope (routes/tickets/siteScope.ts):
          // a soft-deleted ticket is hidden, and a device-bound ticket is only
          // visible to a site-restricted caller when its device is on one of
          // their sites. A deviceless ticket is org-level and stays visible.
          const [ticket] = await db
            .select({ id: tickets.id, deviceId: tickets.deviceId, deletedAt: tickets.deletedAt })
            .from(tickets)
            .where(and(eq(tickets.id, target.ticketId), eq(tickets.orgId, task.orgId)))
            .limit(1);
          if (!ticket || ticket.deletedAt) {
            return { lost: true, detail: 'a target ticket is no longer in this organization' };
          }
          if (ticket.deviceId) {
            const [device] = await db
              .select({ id: devices.id, siteId: devices.siteId })
              .from(devices)
              .where(and(eq(devices.id, ticket.deviceId), eq(devices.orgId, task.orgId)))
              .limit(1);
            if (!device) {
              return { lost: true, detail: "a target ticket's device is no longer in this organization" };
            }
            if (!canAccessSite(perms, device.siteId)) {
              return { lost: true, detail: "the requester no longer has access to a target ticket's device site" };
            }
            targetSites.add(device.siteId ?? null);
          } else {
            targetSites.add(null);
          }
          continue;
        }
        return { lost: true, detail: `task target ${target.id} (${target.targetKind}) does not resolve` };
      }

      // Org + site terms per target. No permission term here: these recipes'
      // child effects are minted under the plan approver and re-proven per
      // mint; W07's coordinator passes the effect permission when it adds
      // grant-bearing recipes of this shape.
      for (const siteId of targetSites) {
        const ceilingLost = await grantCeilingLost(task, { siteId });
        if (ceilingLost) return ceilingLost;
      }

      return ACCESS_OK;
    }),
  );
}
