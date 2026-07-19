import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema/users';
import { apiKeys } from '../../db/schema/apiKeys';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { getUserPermissions } from '../permissions';
import { buildOrgAccessClosures, siteAccessCheck, type AuthContext } from '../../middleware/auth';
import type { TokenPayload } from '../jwt';

/**
 * Rebuilds the acting `AuthContext` for a stored action intent at RELEASE
 * time (spec docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md
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
 */
export async function buildAuthContextForIntent(intent: ActionIntent): Promise<AuthContext | null> {
  if (intent.requestedByUserId) {
    return buildUserOwnedAuthContext(intent, intent.requestedByUserId);
  }

  if (intent.requestingApiKeyId) {
    return buildApiKeyOwnedAuthContext(intent, intent.requestingApiKeyId);
  }

  // The migration's action_intents_one_actor_chk CHECK guarantees exactly
  // one of requestedByUserId/requestingApiKeyId is set — an intent with
  // neither is a data-integrity violation, not a normal revalidation
  // failure. Fail closed the same as any other actor_invalid case rather
  // than throwing out of a background worker.
  console.error(
    `[actorContext] intent ${intent.id} has neither requestedByUserId nor requestingApiKeyId set`,
  );
  return null;
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

    // The core revalidation: getUserPermissions returns null when the user
    // has NO current membership row on this org (org axis) — i.e. they lost
    // access to intent.orgId since the intent was created/approved. A
    // shrunk permission set must fail release, never silently execute with
    // the stale rights the intent was created under.
    //
    // partnerId is threaded through too (CRITICAL-2b): a partner-scope
    // requester (the primary MSP persona) has no organization_users row at
    // all — their role lives in partner_users — so passing only { orgId }
    // resolves NO role and getUserPermissions returns null for every
    // partner-scope requester, failing release closed even though the
    // requester still legitimately has access. intent.partnerId is the
    // denormalized value createActionIntent now persists from the
    // requester's auth at creation time (see intentService.ts).
    const perms = await getUserPermissions(userId, {
      partnerId: intent.partnerId ?? undefined,
      orgId: intent.orgId,
    });
    if (!perms) {
      return null;
    }

    const { orgCondition, canAccessOrg } = buildOrgAccessClosures([intent.orgId]);
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
      accessibleOrgIds: [intent.orgId],
      orgCondition,
      canAccessOrg,
      allowedSiteIds,
      canAccessSite: siteAccessCheck(allowedSiteIds),
    };
  });
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
