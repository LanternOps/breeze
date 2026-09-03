import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema/users';
import { apiKeys } from '../../db/schema/apiKeys';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { devices } from '../../db/schema/devices';
import { tickets } from '../../db/schema/portal';
import type { ActionIntent } from '../../db/schema/actionIntents';
import {
  AgentRunOwnershipError,
  buildAgentAuthContext,
} from '../aiAgents/agentAuthContext';
import { IntentScopeLostError, resolveIntentTargetDevice, resolveIntentTargetTicket } from './intentTargetScope';
import { getUserPermissions, canAccessOrg as permsCanAccessOrg } from '../permissions';
import { buildOrgAccessClosures, siteAccessCheck, type AuthContext } from '../../middleware/auth';
import type { TokenPayload } from '../jwt';

/**
 * Tool/action pairs that are TENANT-SHAPE MUTATIONS whose approved intent
 * names a target org distinct from the intent's own (source) org (#4650).
 * The tool's own handler (e.g. `aiToolsTicketing.ts`'s `move_org`) gates on
 * `auth.canAccessOrg(targetOrgId)`, but every release-time `AuthContext`
 * below is otherwise pinned to `accessibleOrgIds: [intent.orgId]` — so
 * without this allowlist that gate is unreachable for EVERY approved
 * cross-org move, not just unauthorized ones.
 *
 * Keyed `toolName -> action -> argument key holding the target org id`.
 * ONLY a tool/action pair listed here is eligible for the widening below;
 * every other tool/action keeps the single-org `accessibleOrgIds` it always
 * had. Adding an entry here is a deliberate widening of release-time trust —
 * pair it with the same three integration-test properties this fix
 * introduced: an approved release of the new tool/action succeeds
 * cross-org, no OTHER tool/action gets the widening, and an approver/agent
 * without access to the recorded target org is still refused.
 */
const TENANT_MUTATION_TARGET_ORG_ARG: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  manage_tickets: { move_org: 'targetOrgId' },
};

/**
 * Resolves the persisted target-org id for a tenant-shape-mutation intent by
 * reading ONLY the intent's immutable `arguments` snapshot — captured verbatim
 * from the tool-call input at intent CREATION time and blocked from later
 * edits by `action_intents_immutable_trg`. Never re-derives the target from a
 * live lookup of the ticket/device's CURRENT org: that value can legitimately
 * change between approval and release (a second, unrelated moveOrg), and
 * trusting it would let release-time access follow a target the four-eyes
 * approval never saw — the exact TOCTOU the immutable snapshot exists to
 * close.
 *
 * Returns null for any intent whose tool/action is not in the allowlist
 * above, or whose recorded target-org argument is missing or not a string.
 */
function resolveTenantMutationTargetOrgId(intent: ActionIntent): string | null {
  // Reads the plain `action` key, same default `aiGuardrails.resolveActionForTool`
  // (TOOL_ACTION_INPUT_KEYS) falls back to — NOT imported from that module on
  // purpose: `services/aiGuardrails.ts` pulls in the full tool-registry import
  // graph (down to `db/schema`), and this module (like
  // `actionIntents/durableRelease.ts`) stays a light leaf so its narrowly-
  // mocked unit test suite doesn't have to mock that graph too. Every entry
  // in the allowlist above is presently a base-key tool (`manage_tickets`
  // does not appear in `TOOL_ACTION_INPUT_KEYS`) — add a matching override
  // here if a future entry ever needs one.
  const actionValue = intent.arguments.action;
  if (typeof actionValue !== 'string') return null;
  const argKey = TENANT_MUTATION_TARGET_ORG_ARG[intent.actionName]?.[actionValue];
  if (!argKey) return null;
  const raw = intent.arguments[argKey];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Rebuilds the acting `AuthContext` for a stored action intent at RELEASE
 * time (spec docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
 * §5) — the release worker's trust boundary: a reconstructed identity is
 * about to execute a real, privileged Tier-3 action, so this must fail
 * CLOSED on any doubt. Returns `null` on ANY validation failure; the caller
 * (`jobs/intentReleaseWorker.ts`) maps a `null` result to intent
 * `failed: actor_invalid` and never falls back to a looser context.
 *
 * Reuses `buildOrgAccessClosures` + `siteAccessCheck` (middleware/auth.ts) —
 * the SAME closure factories `authMiddleware` uses to build the request-path
 * AuthContext — so org/site access semantics can never drift between "live
 * request" and "durable release" execution.
 *
 * ONE typed exception escapes instead of collapsing to `null`:
 * `IntentScopeLostError` (P2-2, #4189), when an agent intent's device SCOPE
 * is gone. It is distinguished from `null`/`actor_invalid` on purpose —
 * `revalidateApprovedIntentForRelease` maps it to the terminal
 * `agent_scope_lost` errorCode the controller ruling names, which tells an
 * operator "the target device went away", not "the actor is broken".
 */
export async function buildAuthContextForIntent(intent: ActionIntent): Promise<AuthContext | null> {
  if (intent.requestedByUserId) {
    return buildUserOwnedAuthContext(intent, intent.requestedByUserId);
  }

  if (intent.requestingApiKeyId) {
    return buildApiKeyOwnedAuthContext(intent, intent.requestingApiKeyId);
  }

  // The migration's action_intents_one_actor_chk CHECK guarantees exactly
  // one of requestedByUserId/requestingApiKeyId/requestingAgentRunId is set.
  // An agent-originated intent reconstructs the RUN's agent identity (wave
  // 3b): structural, never a user token — checkToolPermission keeps denying
  // the resulting principal, and release authority is checkAgentReleaseAuthority.
  if (intent.requestingAgentRunId) {
    return buildAgentOwnedAuthContext(intent, intent.requestingAgentRunId);
  }
  console.error(
    `[actorContext] intent ${intent.id} has no actor column set (requestedByUserId/requestingApiKeyId/requestingAgentRunId all NULL) — data-integrity violation`,
  );
  return null;
}

/**
 * Maps the intent's recorded origin principal onto an AuthContext principal.
 *
 * 'unknown' rows predate the discriminator and their true origin is not
 * recoverable. They map to the `unknown` kind — NOT to `system`. Conflating
 * the two would mean a future gate trusting internal system callers would also
 * trust every historical record, turning a fail-closed marker into an
 * escalation. `unknown` is trusted by nothing.
 */
export function originPrincipalFor(intent: ActionIntent): AuthContext['principal'] {
  switch (intent.originPrincipalKind) {
    case 'user_session':
      return { kind: 'user_session' };
    case 'client_user':
      return { kind: 'client_user' };
    case 'api_key':
      return { kind: 'api_key', apiKeyId: intent.originPrincipalId ?? undefined };
    case 'oauth_grant':
      return { kind: 'oauth_grant', grantId: intent.originPrincipalId ?? undefined };
    case 'agent':
      return { kind: 'agent' };
    case 'helper':
      return { kind: 'helper' };
    case 'system':
      return { kind: 'system', reason: 'intent-origin-system' };
    case 'ai_agent':
      // agentId is originPrincipalId; runId is the FK column. Both are
      // REQUIRED on the principal type — an agent intent without them cannot
      // exist (action_intents_agent_origin_chk), so falling to 'unknown' here
      // would only hide corruption.
      return intent.requestingAgentRunId && intent.originPrincipalId
        ? {
            kind: 'ai_agent',
            agentId: intent.originPrincipalId,
            runId: intent.requestingAgentRunId,
          }
        : { kind: 'unknown' };
    default: {
      // Compile-time exhaustiveness: when the origin-kind union widens again,
      // this assignment errors instead of silently downgrading the new kind
      // to `unknown` — exactly the drift the doc comment above warns about.
      const _exhaustive: 'unknown' = intent.originPrincipalKind;
      void _exhaustive;
      return { kind: 'unknown' };
    }
  }
}

async function buildUserOwnedAuthContext(
  intent: ActionIntent,
  userId: string,
): Promise<AuthContext | null> {
  return withSystemDbAccessContext(async (): Promise<AuthContext | null> => {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // Not found, invited (never completed setup), or disabled — the account
    // no longer stands behind the action it requested/approved.
    if (!user || user.status !== 'active') {
      return null;
    }

    // The core revalidation: resolve the actor's CURRENT permission set for
    // this org and fail closed if they can no longer reach intent.orgId.
    //
    // partnerId is threaded through (CRITICAL-2b): a partner-scope requester
    // (the primary MSP persona) has no organization_users row at all — their
    // role lives in partner_users — so passing only { orgId } resolves NO role
    // and getUserPermissions returns null for every partner-scope requester,
    // failing release closed even though the requester still legitimately has
    // access. intent.partnerId is the denormalized value createActionIntent
    // persists from the requester's auth at creation time (see
    // intentService.ts).
    const perms = await getUserPermissions(userId, {
      partnerId: intent.partnerId ?? undefined,
      orgId: intent.orgId,
    });
    if (!perms) {
      return null;
    }

    // getUserPermissions returning non-null is NOT sufficient: for a
    // partner-scope requester it resolves the PARTNER axis (partner_users),
    // which carries org_access='selected' + an allowedOrgIds list but does
    // NOT itself verify intent.orgId is still in that list. A partner tech
    // whose selected-org list was narrowed to drop intent.orgId (while their
    // partner membership + tool RBAC stay intact) would otherwise be handed a
    // synthesized accessibleOrgIds:[intent.orgId] below and execute against an
    // org they can no longer reach. canAccessOrg re-applies the exact
    // all/none/selected org-access gate, so a narrowed actor fails release
    // closed. (Org-axis actors trivially pass — canAccessOrg checks
    // perms.orgId === intent.orgId, which resolveOrgAxis only returns on a
    // live membership row.)
    if (!permsCanAccessOrg(perms, intent.orgId)) {
      return null;
    }

    // #4650: for an allowlisted tenant-shape-mutation tool/action (e.g.
    // manage_tickets:move_org), widen accessibleOrgIds to also cover the
    // TARGET org recorded on the intent at creation time — but ONLY when
    // this same requester's already-resolved `perms` can reach it too.
    // Reusing `permsCanAccessOrg` (not a new check) means the bound is
    // exactly the same all/selected/none partner org-access gate applied to
    // intent.orgId two lines up: an org-axis requester (whose `perms.orgId`
    // is fixed to their one org) never widens, and a partner-axis requester
    // widens only within their own org-access grant. A requester who cannot
    // reach the target keeps the single-org accessibleOrgIds, so the tool's
    // existing `auth.canAccessOrg(targetOrgId)` gate 403s exactly as before
    // — now for the RIGHT reason (this approver really lacks target-org
    // access) instead of unconditionally.
    const targetOrgId = resolveTenantMutationTargetOrgId(intent);
    const accessibleOrgIds =
      targetOrgId && targetOrgId !== intent.orgId && permsCanAccessOrg(perms, targetOrgId)
        ? [intent.orgId, targetOrgId]
        : [intent.orgId];

    const { orgCondition, canAccessOrg } = buildOrgAccessClosures(accessibleOrgIds);
    const allowedSiteIds = perms.allowedSiteIds;

    // Synthesized, not re-verified downstream: executeTool's device/org
    // gates key off the closures + accessibleOrgIds below, not off `token`
    // contents (see the module doc). `roleId` is still populated from the
    // freshly-resolved perms (not null) so that IF any future code path
    // re-checks `auth.token.roleId` — aiGuardrails.checkToolPermission /
    // checkPermissionRequirements treat `roleId === null` as a fail-OPEN
    // helper-session bypass — a reconstructed release-worker context can
    // never accidentally inherit that bypass.
    const token: TokenPayload = {
      sub: userId,
      email: user.email,
      roleId: perms.roleId,
      orgId: intent.orgId,
      partnerId: intent.partnerId ?? null,
      scope: 'organization',
      type: 'access',
      mfa: true,
    };

    return {
      // Read the RECORDED origin, never a derivation. The actor columns
      // cannot stand in for it (`requested_by_user_id` is written for every
      // intent, holding the key's CREATOR for API-key callers; and
      // `requesting_api_key_id` is never written at all), and `source` is a
      // lossy proxy with only two values. Reconstructing `user_session` from
      // `requestedByUserId` would launder an autonomous caller into an
      // interactive one at release time.
      //
      // 'unknown' (pre-discriminator rows) is preserved as-is rather than
      // being softened to user_session — a human-required gate must fail on
      // it. It is NOT a valid AuthContext principal, so it maps to the
      // closest fail-closed kind and is refused by any interactive gate.
      principal: originPrincipalFor(intent),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPlatformAdmin: user.isPlatformAdmin,
      },
      token,
      // action_intents.partner_id is a denormalized, ops-only field (Shape 1
      // / org axis — see db/schema/actionIntents.ts's header comment), not
      // an authorization axis, and may be null. It is carried onto the
      // AuthContext for parity with a live org-scope token but never gates
      // anything here — org access is entirely via accessibleOrgIds /
      // orgCondition below.
      partnerId: intent.partnerId ?? null,
      orgId: intent.orgId,
      scope: 'organization',
      accessibleOrgIds,
      orgCondition,
      canAccessOrg,
      allowedSiteIds,
      canAccessSite: siteAccessCheck(allowedSiteIds),
    };
  });
}

/**
 * Agent-owned intents (`requesting_agent_run_id` set, `source: 'ai_agent'`,
 * wave 3b). Reconstructs the RUN's agent AuthContext — the same shape PR 3c's
 * runner will hold live — via `buildAgentAuthContext`, whose
 * `assertRunOwnership` re-proves the agent→run→org lineage at release time.
 * Any doubt (missing run/agent/org, run pointing at another org or agent than
 * the intent records, ownership mismatch) maps to `null` ⇒ `actor_invalid`,
 * the same fail-closed shape as the other branches.
 *
 * The context carries `token: null` and an attribution-only synthetic user;
 * `checkToolPermission`/`checkPermissionRequirements` continue to deny the
 * `ai_agent` principal outright — release authority for agent intents is the
 * separate structural check in `agentReleaseAuthority.ts`.
 */
async function buildAgentOwnedAuthContext(
  intent: ActionIntent,
  runId: string,
): Promise<AuthContext | null> {
  // runOutsideDbContext is load-bearing: the release worker runs with no
  // ambient request context (where a bare system wrapper is fine), but the
  // inline chat release path calls this INSIDE a request context, where
  // withSystemDbAccessContext alone is a passthrough to the ambient org
  // scope (db/index.ts ~440) and these cross-axis reads would be denied.
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async (): Promise<AuthContext | null> => {
      const [run] = await db
        .select({
          id: aiAgentRuns.id,
          agentId: aiAgentRuns.agentId,
          orgId: aiAgentRuns.orgId,
          deviceId: aiAgentRuns.deviceId,
        })
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.id, runId))
        .limit(1);
      if (!run) {
        console.error(
          `[actorContext] intent ${intent.id} references agent run ${runId}, which does not exist — failing closed`,
        );
        return null;
      }
      // The composite FK (requesting_agent_run_id, org_id) →
      // ai_agent_runs(id, org_id) guarantees the org match, and
      // action_intents_agent_origin_chk pins originPrincipalId. Assert both
      // anyway so a future schema change fails loud instead of executing an
      // intent under the wrong run's identity.
      if (run.orgId !== intent.orgId || run.agentId !== intent.originPrincipalId) {
        console.error(
          `[actorContext] intent ${intent.id} run ${runId} lineage mismatch `
          + `(run.orgId=${run.orgId} intent.orgId=${intent.orgId} `
          + `run.agentId=${run.agentId} originPrincipalId=${intent.originPrincipalId}) — failing closed`,
        );
        return null;
      }
      const [agent] = await db
        .select({
          id: aiAgents.id,
          orgId: aiAgents.orgId,
          partnerId: aiAgents.partnerId,
          name: aiAgents.name,
          kind: aiAgents.kind,
        })
        .from(aiAgents)
        .where(eq(aiAgents.id, run.agentId))
        .limit(1);
      if (!agent) {
        return null;
      }
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, run.orgId))
        .limit(1);
      if (!org) {
        return null;
      }
      // P2-2 (#4189): the intent's TARGET device, not the run's. A sweep run
      // is device-less and pins its intents one device at a time via
      // scope_kind/scope_device_id; a tombstoned scope (device deleted, or
      // detached by a moveOrg) can never be released, so fail closed here
      // rather than silently falling back to the run's own (null) device,
      // which would rebuild an UNSCOPED, org-wide agent context.
      const target = resolveIntentTargetDevice(intent, run);
      if (target.kind === 'tombstone') {
        throw new IntentScopeLostError(
          `agent_scope_lost: intent ${intent.id} is device-scoped but its scope_device_id was tombstoned`,
        );
      }
      // The device's CURRENT site, not the site at proposal time — spec §3.2
      // pins a device-bound run to its device's site, and release must
      // reflect where the device lives NOW.
      let deviceSiteId: string | null = null;
      if (target.kind === 'scope') {
        // Controller ruling (P2-2 A3): for a SCOPED target the device must
        // still exist AND still belong to the intent's org — a device
        // org-move that landed through the DB-side cascade rather than the
        // HTTP moveOrg route leaves scope_device_id set, and this is the
        // backstop. Treated exactly like a tombstone.
        const [device] = await db
          .select({ orgId: devices.orgId, siteId: devices.siteId })
          .from(devices)
          .where(eq(devices.id, target.deviceId))
          .limit(1);
        if (!device || device.orgId !== intent.orgId) {
          throw new IntentScopeLostError(
            `agent_scope_lost: intent ${intent.id}'s scoped device ${target.deviceId} is missing or no longer in org ${intent.orgId}`,
          );
        }
        deviceSiteId = device.siteId ?? null;
      } else if (target.deviceId) {
        const [device] = await db
          .select({ siteId: devices.siteId })
          .from(devices)
          .where(eq(devices.id, target.deviceId))
          .limit(1);
        deviceSiteId = device?.siteId ?? null;
      }

      // P2-4 (Task A3, #4189/#4191): the TICKET-scope mirror of the device
      // check above. `resolveIntentTargetTicket` never falls back to
      // anything (there is no run-level "own ticket" to fall back to — see
      // its doc comment in intentTargetScope.ts), so 'none' here just means
      // this intent has no ticket target at all, and the branch is a no-op.
      const ticketTarget = resolveIntentTargetTicket(intent);
      if (ticketTarget.kind === 'tombstone') {
        throw new IntentScopeLostError(
          `agent_scope_lost: intent ${intent.id} is ticket-scoped but its scope_ticket_id was tombstoned`,
        );
      }
      if (ticketTarget.kind === 'scope') {
        const [ticket] = await db
          .select({ id: tickets.id, orgId: tickets.orgId, status: tickets.status, deletedAt: tickets.deletedAt })
          .from(tickets)
          .where(eq(tickets.id, ticketTarget.ticketId))
          .limit(1);
        // Missing, soft-deleted, moved to another org, or closed — all
        // treated exactly like a lost device scope. `resolved` is
        // deliberately EXCLUDED from this list: resolution-note drafts
        // (`manage_tickets:draft`, kind `draftResolutionNote`) are the
        // motivating case for proposing against a ticket that has already
        // moved to `resolved`, and every other ticket-triage tool call is
        // equally valid against a resolved (not yet closed) ticket.
        if (
          !ticket
          || ticket.deletedAt !== null
          || ticket.orgId !== intent.orgId
          || ticket.status === 'closed'
        ) {
          throw new IntentScopeLostError(
            `agent_scope_lost: intent ${intent.id}'s scoped ticket ${ticketTarget.ticketId} is missing, deleted, closed, or no longer in org ${intent.orgId}`,
          );
        }
      }

      // #4650: same allowlisted widening as the user-owned path above, bounded
      // to the ACTING AGENT's own scope (never the human approver's) — this
      // AuthContext executes AS the agent. An org-scoped agent (agent.orgId
      // !== null) is never eligible: its home IS a single org, so it can
      // never legitimately reach a different one. A partner-scoped agent
      // (agent.orgId === null) may widen only when the recorded target org's
      // CURRENT partner ownership matches the agent's own partnerId. A live
      // lookup here is correct, not the TOCTOU the target-org id itself must
      // avoid — an org's partner assignment changing between approval and
      // release is exactly the kind of access change release-time
      // revalidation exists to catch (mirrors permsCanAccessOrg's re-check
      // above, and the FK-guaranteed run/org/agent lineage asserts earlier in
      // this function).
      const targetOrgId = resolveTenantMutationTargetOrgId(intent);
      let releaseAccessibleOrgIds: string[] = [intent.orgId];
      if (targetOrgId && targetOrgId !== intent.orgId && agent.orgId === null && agent.partnerId) {
        const [targetOrg] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, targetOrgId))
          .limit(1);
        if (targetOrg?.partnerId === agent.partnerId) {
          releaseAccessibleOrgIds = [intent.orgId, targetOrgId];
        }
      }

      try {
        const agentContext = buildAgentAuthContext(
          {
            id: agent.id,
            orgId: agent.orgId,
            partnerId: agent.partnerId,
            name: agent.name,
            kind: agent.kind,
          },
          // The run row's own deviceId is deliberately NOT used here: the
          // rebuilt context is pinned to the intent's target device (and its
          // site), which for a scoped intent is not the run's.
          { id: run.id, orgId: run.orgId, deviceId: target.deviceId, deviceSiteId },
          { id: run.orgId, partnerId: org.partnerId },
        );
        if (releaseAccessibleOrgIds.length === 1) {
          return agentContext;
        }
        const { orgCondition, canAccessOrg } = buildOrgAccessClosures(releaseAccessibleOrgIds);
        return { ...agentContext, accessibleOrgIds: releaseAccessibleOrgIds, orgCondition, canAccessOrg };
      } catch (error) {
        if (error instanceof AgentRunOwnershipError) {
          console.error(
            `[actorContext] intent ${intent.id} run ${runId}: ${error.message} — failing closed`,
          );
          return null;
        }
        throw error;
      }
    }),
  );
}

/**
 * API-key-owned intents (`requesting_api_key_id` set, `source: 'mcp_api'`).
 * DEFENSIVE branch only. In the current Plan 1 delivery,
 * `createActionIntent` (services/actionIntents/intentService.ts) always
 * attributes an intent to `auth.user.id` — every caller reaching it today
 * (the chat SDK) authenticates as a user — so `requesting_api_key_id` is
 * never actually set on a stored intent yet. The `mcp_api` MCP `tools/call`
 * → intent wiring that WOULD populate this field ships in Plan 2 (the MCP
 * cutover, spec §6.2), which also has to decide how an api-key-owned
 * intent's scopes/site restrictions get carried onto the released
 * AuthContext — mirroring middleware/apiKeyAuth.ts's apiKeyAuthMiddleware /
 * the `buildAuthFromApiKey` reconstruction in routes/mcpServer.ts. Rather
 * than fork a partial, untested copy of that (non-exported, ~90-line)
 * logic now, this checks the key is still live and then fails closed with a
 * clear signal — Plan 2 replaces this branch with the full rebuild.
 */
async function buildApiKeyOwnedAuthContext(
  intent: ActionIntent,
  apiKeyId: string,
): Promise<AuthContext | null> {
  return withSystemDbAccessContext(async (): Promise<AuthContext | null> => {
    const [key] = await db
      .select({ id: apiKeys.id, status: apiKeys.status })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);

    if (!key || key.status !== 'active') {
      return null;
    }

    console.error(
      `[actorContext] intent ${intent.id} is api-key-owned (key ${apiKeyId}) — full context `
      + 'rebuild is not implemented until Plan 2 (MCP cutover); failing closed to actor_invalid',
    );
    return null;
  });
}
