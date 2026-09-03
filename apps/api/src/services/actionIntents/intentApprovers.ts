/**
 * Action intents & durable approval layer — eligible-approver resolution
 * (spec docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
 * §4; CRITICAL-2 fix).
 *
 * Given an org, returns the distinct set of user ids eligible to decide a
 * Tier-3 action intent: a user is eligible iff their role in (or covering)
 * the org grants `approvals:decide`.
 *
 * Mirrors `resolveElevationApprovers` (services/pamApprovers.ts) EXACTLY for
 * the role/membership resolution — role-ids granting the permission (incl.
 * wildcard '*' grants) via role_permissions ⋈ permissions, then
 * organization_users direct members + partner_users of the org's owning
 * partner with org_access 'all' or 'selected' ∋ orgId — but gates on
 * `PERMISSIONS.APPROVALS_DECIDE` instead of `DEVICES_EXECUTE`, and WITHOUT
 * the mobile-device narrowing: an action-intent approver decides from the web
 * app or an MCP client, not necessarily a phone, so `resolveElevationApprovers`'s
 * final `mobile_devices` filter has no equivalent here. One deliberate
 * divergence: both candidate queries here additionally join `users` and
 * require status='active' (`resolveElevationApprovers` does not) — a
 * disabled or still-invited account can hold a granting role but must never
 * be counted as an eligible approver, since that both inflates the
 * four-eyes fan-out and can wrongly suppress the sole-operator fallback.
 *
 * Runs under a system DB access context: this reads role_permissions,
 * permissions, organization_users, partner_users, and organizations — RLS-
 * scoped tables the caller's org-scoped request context (createActionIntent
 * runs inside the REQUESTER's org context, not a privileged one) cannot fully
 * see. Most importantly `partner_users` (Shape 3, partner-axis RLS), which a
 * pure org-scope caller can never read — exactly the population CRITICAL-2
 * exists to surface (partner-scope MSP techs/admins have no
 * `organization_users` row at all).
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { effectiveTargetDeviceId, resolveIntentTargetDevice } from './intentTargetScope';
import {
  aiAgentRuns,
  devices,
  organizations,
  organizationUsers,
  partnerUsers,
  users,
  type ActionIntent,
} from '../../db/schema';
import { aiTools } from '../aiTools';
import { requiredPermissionsForTool } from '../aiGuardrails';
import {
  PERMISSIONS,
  canAccessOrg,
  canAccessSite,
  getUserPermissions,
  hasPermission,
} from '../permissions';
import { resolveUsersWithPermissionForOrg } from '../usersWithPermission';

/**
 * Resolve the distinct user ids eligible to decide an action intent for
 * `orgId`. Empty array when none qualify. Pure-read; opens its own system DB
 * context, so it may be called from any ambient context (or none).
 */
export async function resolveIntentApprovers(orgId: string): Promise<string[]> {
  return resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.APPROVALS_DECIDE);
}

// ============================================================
// Wave 3b — agent-intent eligibility (action-and-target, spec §3.4)
// ============================================================
//
// A SUPERVISED intent proposed by an ai_agent principal has no requester, so
// the "requester decides own intent" path can never apply. Eligibility is
// ACTION-AND-TARGET instead: the humans who could lawfully perform the action
// on the concrete target themselves — NOT `approvals:decide` holders
// (four_eyes keeps `resolveIntentApprovers` above, unchanged). The agent must
// never influence eligibility: `ai_agents.recipients` is notification-only
// and is deliberately never read here.

/**
 * Tools whose COMPLETE target set is expressed by their registered
 * `deviceArgs` (verified by hand against each handler). Anything not listed
 * is treated as having INDIRECT targets — deployments, groups, filters —
 * and only site-UNRESTRICTED humans are eligible for it.
 *
 * Hand-verification record (2026-08-23, remediate_vulnerability added #4452),
 * re-check the handler before adding an entry —
 * `intentApprovers.deviceTargets.contract.test.ts` only proves a listed tool
 * DECLARES deviceArgs, not that the declaration is complete:
 * - execute_command  (aiToolsScripts.ts): acts on the single required
 *   `deviceId`; nothing else in the input reaches another device.
 * - run_script       (aiToolsScripts.ts): iterates the required `deviceIds`
 *   array only (first 10); scriptId selects content, not targets.
 * - manage_services  (aiToolsScripts.ts): single required `deviceId`;
 *   serviceName is a name on that device, not a target.
 * - remediate_vulnerability (aiToolsVulnerability.ts): `deviceId` is
 *   OPTIONAL, unlike the three above — the handler enforces it as a
 *   COMPLETE pin only when the caller supplies it (every finding cited by
 *   `deviceVulnerabilityIds` must belong to that one device, or the whole
 *   call is refused with `finding_device_mismatch`); when omitted, findings
 *   may legitimately span multiple devices ("interactive chat may still
 *   omit it and remediate across devices as before", aiToolSchemas.ts). The
 *   sweep pipeline that scopes this tool's intents always supplies it
 *   (sweepFindings.ts's `proposalToolInput`), so the resolver below only
 *   trusts the tool's own `deviceId` when it is actually PRESENT in args —
 *   never the resolved intent/run device as a lone stand-in — so an
 *   unscoped, unpinned call still falls closed to `indirect` instead of
 *   under-representing the true device set.
 */
export const DEVICE_COMPLETE_TARGET_TOOLS: ReadonlySet<string> = new Set([
  'execute_command',
  'manage_services',
  'remediate_vulnerability',
  'run_script',
]);

export type IntentTargetScope =
  | { kind: 'devices'; siteIds: string[] } // fully resolved via deviceArgs ∪ run.deviceId
  | { kind: 'indirect' }; // fail closed: unrestricted-site approvers only

/**
 * Resolve the concrete target scope of a proposed agent intent. For a
 * DEVICE_COMPLETE_TARGET_TOOLS tool: the distinct site ids of every device
 * named in the tool's `deviceArgs` inputs, unioned with the intent's OWN
 * target device — but only once the args themselves have named at least one
 * device (#4452: a tool with an OPTIONAL device arg, e.g.
 * remediate_vulnerability, must not have its target manufactured solely from
 * `target.deviceId` when the arg is omitted — see the union site below).
 *
 * P2-2 (#4189): that third argument used to be the run row itself. It is now
 * the resolved target — `effectiveTargetDeviceId(resolveIntentTargetDevice(
 * intent, run))` (intentTargetScope.ts) — so a scoped intent's approvers are
 * the humans who can reach the SCOPED device, and a device-less sweep run
 * never drags a `null` in where a real device exists. Callers MUST pass the
 * resolved value; passing `run` directly is the bug this parameter was
 * renamed to make visible.
 *
 * Every other tool — and any call where no device id can be resolved at all —
 * is `{kind:'indirect'}`, which fails closed to site-unrestricted approvers
 * (review blocker 1: deviceArgs explicitly does not cover indirect or
 * list-returning targets, and e.g. manage_deployments accepts
 * targetType all/group/filter with no site check in its handler).
 *
 * Throws on an unknown device id: a proposal citing a nonexistent device must
 * not be fanned out. The device read is pinned to `orgId` (the intent's org),
 * so a cross-tenant device id is indistinguishable from a nonexistent one and
 * hits the same throw — tool args are LLM/runner-produced, and silently
 * accepting a foreign device's site into the scope would both violate the
 * fail-closed fan-out contract and act as a cross-tenant device-UUID
 * existence oracle (review finding 1).
 */
export async function resolveIntentTargetScope(
  toolName: string,
  args: Record<string, unknown>,
  target: { deviceId: string | null },
  orgId: string,
): Promise<IntentTargetScope> {
  if (!DEVICE_COMPLETE_TARGET_TOOLS.has(toolName)) return { kind: 'indirect' };

  const deviceIds = new Set<string>();
  const tool = aiTools.get(toolName);
  for (const argName of tool?.deviceArgs ?? []) {
    if (!(argName in args)) continue;
    const value = args[argName];
    if (typeof value === 'string') {
      if (value) deviceIds.add(value);
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      for (const entry of value) if (entry) deviceIds.add(entry as string);
    }
    // A present-but-malformed value contributes nothing; if that leaves the
    // union empty we fall through to the fail-closed indirect branch below.
  }
  // The resolved intent target (the intent's own scope device, or the run's
  // own device when unscoped) is unioned in ONLY as a widener on top of an
  // already-nonempty args-derived set — never as the sole source of a
  // 'devices' resolution. For execute_command/manage_services/run_script
  // this changes nothing: their device args are REQUIRED, so the loop above
  // always contributes and this union stays a pure (harmless) widen. It
  // matters for remediate_vulnerability's OPTIONAL `deviceId`: when a call
  // omits it, the loop above contributes nothing, and the tool is then free
  // to touch findings on ANY device the caller can reach (see the hand-
  // verification comment on DEVICE_COMPLETE_TARGET_TOOLS above) — so
  // `target.deviceId`, which could be nothing more than an unrelated chat
  // run's own bound device, must not be treated as a complete stand-in
  // target in that case. Falling through to `indirect` below is the correct,
  // fail-closed outcome.
  if (deviceIds.size > 0 && target.deviceId) deviceIds.add(target.deviceId);

  // No resolvable device at all (malformed args + a detached run after a
  // device move, or a tombstoned scope): {kind:'devices', siteIds: []} would
  // vacuously pass every
  // candidate's site check, so fail closed to the indirect rule instead.
  if (deviceIds.size === 0) return { kind: 'indirect' };

  const ids = [...deviceIds];
  // System context: the fan-out runs from creation/decide paths whose ambient
  // RLS context is the AGENT's org scope (or none); device rows are read by
  // explicit equality-keyed ids only. The runOutsideDbContext wrapper is
  // load-bearing — a bare system wrapper inside an ambient request context is
  // a no-op (db/index.ts).
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () =>
      db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        // Org pin is load-bearing (review finding 1): without it the
        // system-scoped read resolves devices from ANY tenant.
        .where(and(inArray(devices.id, ids), eq(devices.orgId, orgId))),
    ),
  );

  const siteByDevice = new Map(rows.map((row) => [row.id, row.siteId]));
  for (const id of ids) {
    if (!siteByDevice.has(id)) {
      throw new Error(`resolveIntentTargetScope: unknown device "${id}" cited by tool "${toolName}"`);
    }
  }
  return { kind: 'devices', siteIds: [...new Set(rows.map((row) => row.siteId))] };
}

/**
 * The per-user action-and-target predicate shared by fan-out (creation) and
 * decide-time revalidation. `partnerId` MUST be supplied when the org has a
 * partner: the permission service only evaluates the partner axis when
 * `context.partnerId` is present (permissions.ts) — omitting it silently
 * discards every partner-only technician.
 */
async function userHasActionAndTargetAuthority(
  userId: string,
  opts: {
    orgId: string;
    partnerId: string | null;
    required: Array<{ resource: string; action: string }>;
    targetScope: IntentTargetScope;
  },
): Promise<boolean> {
  const userPerms = await getUserPermissions(userId, {
    orgId: opts.orgId,
    ...(opts.partnerId ? { partnerId: opts.partnerId } : {}),
  });
  if (!userPerms) return false;
  for (const requirement of opts.required) {
    if (!hasPermission(userPerms, requirement.resource, requirement.action)) return false;
  }
  if (!canAccessOrg(userPerms, opts.orgId)) return false;
  if (opts.targetScope.kind === 'devices') {
    return opts.targetScope.siteIds.every((siteId) => canAccessSite(userPerms, siteId));
  }
  // Indirect targets: only a human with NO site restriction could lawfully
  // perform an org-wide action themselves.
  return userPerms.allowedSiteIds === undefined;
}

/**
 * Resolve the user ids eligible to decide a SUPERVISED agent-originated
 * intent: every active member of (or covering) the org who holds the tool's
 * full RBAC mapping AND can reach the intent's concrete target. Empty array
 * when the tool has no RBAC mapping (deny-all) or nobody qualifies.
 *
 * Per-candidate permission loads are acceptable here: proposal creation is
 * rare and org member counts are MSP-sized — do not pre-optimise.
 */
export async function resolveAgentIntentApprovers(opts: {
  orgId: string;
  toolName: string;
  input: Record<string, unknown>;
  targetScope: IntentTargetScope;
}): Promise<string[]> {
  // No RBAC mapping (unknown tool / unknown action / missing action on a
  // multiplexed tool) ⇒ nobody is eligible. Short-circuits before any
  // membership lookup.
  const required = requiredPermissionsForTool(opts.toolName, opts.input);
  if (required === null) return [];

  // Candidate pool: the same active-member union resolveIntentApprovers
  // builds, WITHOUT the approvals:decide role restriction — RBAC is evaluated
  // per user below. System context for the same RLS reasons as above (and the
  // same runOutsideDbContext caveat); the per-candidate permission loop runs
  // AFTER the context closes so no pg transaction is held across the
  // getUserPermissions cache/redis round-trips.
  const { partnerId, candidateUserIds } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, opts.orgId))
        .limit(1);

      const candidates = new Set<string>();

      const orgMembers = await db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .innerJoin(users, eq(users.id, organizationUsers.userId))
        .where(and(eq(organizationUsers.orgId, opts.orgId), eq(users.status, 'active')));
      for (const member of orgMembers) candidates.add(member.userId);

      if (org?.partnerId) {
        const partnerMembers = await db
          .select({
            userId: partnerUsers.userId,
            orgAccess: partnerUsers.orgAccess,
            orgIds: partnerUsers.orgIds,
          })
          .from(partnerUsers)
          .innerJoin(users, eq(users.id, partnerUsers.userId))
          .where(and(eq(partnerUsers.partnerId, org.partnerId), eq(users.status, 'active')));
        for (const member of partnerMembers) {
          if (member.orgAccess === 'all') {
            candidates.add(member.userId);
          } else if (member.orgAccess === 'selected' && member.orgIds?.includes(opts.orgId)) {
            candidates.add(member.userId);
          }
        }
      }

      return { partnerId: org?.partnerId ?? null, candidateUserIds: candidates };
    }),
  );

  const eligible: string[] = [];
  for (const userId of candidateUserIds) {
    if (
      await userHasActionAndTargetAuthority(userId, {
        orgId: opts.orgId,
        partnerId,
        required,
        targetScope: opts.targetScope,
      })
    ) {
      eligible.push(userId);
    }
  }
  return eligible;
}

/**
 * Live decide-time revalidation for a supervised agent intent (Task 6):
 * recomputes the target scope from the intent's STORED actionName/arguments
 * plus its run (loaded system-scoped via requestingAgentRunId), then applies
 * the same per-user action-and-target predicate as the creation fan-out —
 * exactly like four_eyes re-checks decide authority at decision time.
 * Every failure mode returns false (fail closed), including a cited device
 * that no longer exists.
 *
 * P2-2 (#4189): the target device comes from `resolveIntentTargetDevice` —
 * the intent's explicit scope when it has one, the run's device otherwise.
 * A tombstoned scope, a scoped device that has been deleted, and a scoped
 * device whose CURRENT org is no longer the intent's org are all `false`.
 */
export async function isAgentIntentDecideAuthorized(
  userId: string,
  intent: Pick<
    ActionIntent,
    'id' | 'orgId' | 'actionName' | 'arguments' | 'requestingAgentRunId' | 'scopeKind' | 'scopeDeviceId' | 'scopeTicketId'
  >,
): Promise<boolean> {
  const runId = intent.requestingAgentRunId;
  if (!runId) return false;

  const required = requiredPermissionsForTool(intent.actionName, intent.arguments ?? {});
  if (required === null) return false;

  // P2-2 (#4189): the target is resolved BEFORE the run is even consulted —
  // a tombstoned scope (the device was deleted, or moved to another org)
  // means nobody can decide this intent, exactly like a cited device that no
  // longer exists.
  const target = resolveIntentTargetDevice(intent, null);
  if (target.kind === 'tombstone') return false;

  const { run, partnerId, scopedDevice } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [runRow] = await db
        .select({ orgId: aiAgentRuns.orgId, deviceId: aiAgentRuns.deviceId })
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.id, runId))
        .limit(1);
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, intent.orgId))
        .limit(1);
      // Controller ruling (P2-2 A3): the scoped device's CURRENT org is the
      // backstop for a device org-move that landed through the DB cascade
      // rather than the HTTP moveOrg route (which detaches the scope
      // itself) — a live scope_device_id pointing at another tenant's device
      // must decide exactly like a tombstone.
      let device: { orgId: string } | null = null;
      if (target.kind === 'scope') {
        const [row] = await db
          .select({ orgId: devices.orgId })
          .from(devices)
          .where(eq(devices.id, target.deviceId))
          .limit(1);
        device = row ?? null;
      }
      return { run: runRow ?? null, partnerId: org?.partnerId ?? null, scopedDevice: device };
    }),
  );
  // Belt-and-braces: the composite FK already pins the run to the intent org.
  if (!run || run.orgId !== intent.orgId) return false;
  if (target.kind === 'scope' && (!scopedDevice || scopedDevice.orgId !== intent.orgId)) return false;

  let targetScope: IntentTargetScope;
  try {
    targetScope = await resolveIntentTargetScope(
      intent.actionName,
      intent.arguments ?? {},
      // Re-resolved now that the run row is loaded — `target` above was
      // resolved against a null run purely to catch the tombstone before
      // paying for any read. Same resolver, same answer for the scope case.
      { deviceId: effectiveTargetDeviceId(resolveIntentTargetDevice(intent, run)) },
      intent.orgId,
    );
  } catch {
    // A cited device that has since been deleted (or that never belonged to
    // the intent's org): the target can no longer be verified, so nobody is
    // decide-authorized.
    return false;
  }

  return userHasActionAndTargetAuthority(userId, {
    orgId: intent.orgId,
    partnerId,
    required,
    targetScope,
  });
}
