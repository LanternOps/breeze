/**
 * Wisp W04a — the delegation ceiling at RELEASE of a chat-originated action
 * intent (Wisp design §4: "Wisp never exceeds its human").
 *
 * A Tier-3 call in a Wisp chat session passes `enforceWispCeiling` in
 * `createSessionPreToolUse` and becomes an action intent. When its approval
 * lands inside the inline wait budget the chat path re-checks the ceiling
 * before running it (aiAgentSdk.ts). When the approval lands LATER, the durable
 * worker (`jobs/intentReleaseWorker.ts` `releaseApprovedIntent`) executes the
 * intent with no live session — so `revalidateApprovedIntentForRelease`, the
 * revalidation BOTH release paths share, calls this check for every intent
 * carrying a chat-session origin. A grant paused / revoked / expired, a grantor
 * narrowed, or a ceiling that no longer covers the call during the approval
 * wait stops the release.
 *
 * The intent records no grant; it links back to its session through
 * `action_intents.ai_origin_session_id` (stamped by `withChatAiOrigin` at
 * creation). The session's PINNED grant + revision pair is read from that row
 * (`lookupWispGrant`) and the call is checked by `enforceWispCeiling` — the
 * chat gate's own implementation, never a copy — with the intent's tool,
 * arguments and org, against the rebuilt requester auth.
 *
 * Outcomes (never throws):
 *   - not a Wisp session                → `{ ok: true, auth }` (unchanged)
 *   - inside the ceiling                → `{ ok: true, auth }` cut to the ceiling
 *   - grant inactive                    → `wisp_grant_inactive`
 *   - outside the ceiling               → `wisp_ceiling_refused`
 *   - session cannot be gated / any error → `wisp_gate_unavailable` (fail closed)
 * Every refusal is audited as `wisp.ceiling_refused` (as the chat gate does) and
 * is terminal — the worker fails the intent, it does not pause it.
 */
import type { ActionIntent } from '../../db/schema/actionIntents';
import type { AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { wispEnabled } from '../../config/env';
import { captureException } from '../sentry';
import { tenantToolPermissionRequirement } from '../toolSources/guardrails';
import {
  WispSessionUnavailableError,
  enforceWispCeiling,
  lookupWispGrant,
  type WispCeilingRefusal,
  type WispSessionGrant,
} from './chatCeiling';

export type WispReleaseErrorCode = 'wisp_ceiling_refused' | 'wisp_grant_inactive' | 'wisp_gate_unavailable';

export type WispReleaseCheck =
  | { ok: true; auth: AuthContext }
  | { ok: false; errorCode: WispReleaseErrorCode; details: Record<string, unknown> };

type ReleaseIntent = Pick<ActionIntent, 'id' | 'orgId' | 'actionName' | 'arguments' | 'aiOriginSessionId' | 'toolSourceToolId'>;

const GATE_UNAVAILABLE_MESSAGE = "Wisp couldn't verify the grant for this action at release, so it wasn't run.";

function refuse(
  intent: ReleaseIntent,
  auth: AuthContext,
  errorCode: WispReleaseErrorCode,
  refusal: WispCeilingRefusal,
  grantId: string | null,
): WispReleaseCheck {
  const sessionId = intent.aiOriginSessionId;
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: intent.orgId,
      action: 'wisp.ceiling_refused',
      resourceType: 'action_intent',
      resourceId: intent.id,
      actorId: auth.user?.id ?? null,
      actorEmail: auth.user?.email,
      initiatedBy: 'ai',
      result: 'failure',
      errorMessage: refusal.message,
      details: {
        toolName: intent.actionName,
        code: refusal.code,
        detail: refusal.detail,
        grantId,
        aiSessionId: sessionId,
        phase: 'release',
      },
    });
  } catch (err) {
    console.error(`[WispRelease] failed to audit the ceiling refusal for intent ${intent.id}:`, err);
  }
  return {
    ok: false,
    errorCode,
    details: { wispRefusal: refusal.detail, reason: refusal.message, grantId, aiSessionId: sessionId },
  };
}

export async function checkWispCeilingForRelease(intent: ReleaseIntent, auth: AuthContext): Promise<WispReleaseCheck> {
  const sessionId = intent.aiOriginSessionId;
  if (!sessionId) return { ok: true, auth };

  let grant: WispSessionGrant | null = null;
  try {
    try {
      grant = await lookupWispGrant(sessionId);
    } catch (err) {
      // A session row that no longer exists (the intent row deliberately has
      // no FK to it) can no longer prove it was NOT pinned to a grant. While
      // Wisp is off no grant can be honoured anyway, so the release path is
      // unchanged; while it is on, fail closed below like every other
      // unavailable shape.
      if (err instanceof WispSessionUnavailableError && err.reason === 'session_not_found' && !wispEnabled()) {
        return { ok: true, auth };
      }
      throw err;
    }
    if (!grant) return { ok: true, auth };

    // A tenant (BYO MCP) tool is gated on its tier's generic requirement and
    // acts in the intent org, whatever its own arguments say (as at the chat
    // gate). Intents exist only for Tier 3.
    const external = intent.toolSourceToolId !== null && intent.toolSourceToolId !== undefined;
    const result = await enforceWispCeiling({
      grant,
      toolName: intent.actionName,
      input: external ? {} : ((intent.arguments ?? {}) as Record<string, unknown>),
      sessionOrgId: intent.orgId,
      sessionId,
      toolAuth: auth,
      ...(external ? { permissionRequirement: tenantToolPermissionRequirement(3) } : {}),
    });
    if (!result.ok) {
      const errorCode = result.refusal.code === 'wisp_grant_inactive' ? 'wisp_grant_inactive' : 'wisp_ceiling_refused';
      return refuse(intent, auth, errorCode, result.refusal, grant.grantId);
    }
    return { ok: true, auth: result.toolAuth };
  } catch (err) {
    console.error(`[WispRelease] ceiling check failed for intent ${intent.id} (session ${sessionId}); refusing`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return refuse(
      intent,
      auth,
      'wisp_gate_unavailable',
      { code: 'wisp_gate_unavailable', detail: 'unavailable', message: GATE_UNAVAILABLE_MESSAGE },
      grant?.grantId ?? null,
    );
  }
}
