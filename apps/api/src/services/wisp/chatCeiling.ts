/**
 * Wisp W04 Task 4 — the delegation ceiling on a CHAT tool call (w00 A2, A14,
 * A27; Wisp design §4).
 *
 * A Wisp chat session (`ai_sessions.wisp_grant_id` set) runs under the
 * grantor's own `user_session` principal, so the ordinary chat gate (tiers,
 * RBAC, rate limits, approvals) would let it do anything its human can. The
 * grant is narrower. `createSessionPreToolUse` (aiAgentSdk.ts) therefore runs
 * `enforceWispCeiling` on EVERY tool call of such a session — Tier 1 included —
 * after the session allowlist and BEFORE `checkGuardrails`, and the tool then
 * executes under the per-call `toolAuth` returned here, never under the
 * session's wider one.
 *
 * Three axes, all from the live ceiling (`resolveGrantCeiling`, re-read per
 * call — a pause / revoke / expiry or a narrowed grantor applies to the very
 * next call):
 *
 *   1. the TARGET org (the call's explicit `orgId`, else the session org) must
 *      pass the tool / org / site terms and, bound to that org, every human
 *      permission the call needs (`assertWithinCeiling` with the org, so the
 *      grantor's per-org membership term — `GrantCeiling.orgTerms` — applies);
 *   2. the call's REACH (`toolAuth.accessibleOrgIds`) is cut to the orgs where
 *      those same checks pass, so a call that names no org cannot reach an org
 *      whose term is narrower (a device in another org, a list across orgs);
 *   3. partner breadth (`partnerOrgAccess: 'all'`) survives only for a
 *      partner-wide ceiling that reaches every one of its orgs.
 *
 * Site terms are enforced fail-closed: a chat tool call carries no verified
 * site, and partner-scope tools do not honour `allowedSiteIds` uniformly, so an
 * org whose ceiling (or membership term) is site-restricted is refused as a
 * target and dropped from reach (`assertWithinCeiling` refuses an unknown site
 * against a site-restricted term). Widening that needs a server-resolved site
 * per call (follow-up).
 */
import { and, eq } from 'drizzle-orm';
import type { AiPageContext } from '@breeze/shared';
import { isResolveFailure, resolveEntityRef, type ResolvedEntity } from './entityRefs';
import { db } from '../../db';
import { aiSessions } from '../../db/schema/ai';
import { wispThreadSessions, wispThreads } from '../../db/schema/wispThreads';
import { buildOrgAccessClosures, siteAccessCheck, type AuthContext } from '../../middleware/auth';
import { resolveToolPermissionRequirements } from '../aiGuardrails';
import { captureException } from '../sentry';
import { wispGrantRevisions } from '../../db/schema/wisp';
import {
  CeilingViolationError,
  GrantInactiveError,
  assertWithinCeiling,
  ceilingAdmitsTool,
  ceilingToolTermOf,
  inSystemContext,
  isNeverDelegableToolAction,
  resolveGrantCeiling,
  wispCeilingSnapshotSchema,
  type CeilingViolationCode,
  type GrantCeiling,
} from './grantAuthority';
import { seedContextForSession } from './threads';

/** The grant a live chat session runs under (immutable for the session's life). */
export type WispSessionGrant = { grantId: string; revisionId: string; threadId: string };

/**
 * Why a Wisp call was refused. `code` and `detail` travel together: an
 * inactive grant is always `inactive`, a ceiling term names which one, and a
 * gate that could not run at all (DB down, corrupt pin, module failure) is
 * `unavailable`. `enforceWispCeiling` itself only returns the first two
 * (`WispCeilingCheckRefusal`); the gate-unavailable shape is produced by its
 * callers when it throws (aiAgentSdk.ts, releaseCeiling.ts).
 */
export type WispCeilingRefusal =
  | { code: 'wisp_grant_inactive'; detail: 'inactive'; message: string }
  | { code: 'wisp_outside_ceiling'; detail: Exclude<CeilingViolationCode, 'inactive'>; message: string }
  | { code: 'wisp_gate_unavailable'; detail: 'unavailable'; message: string };

/** What `enforceWispCeiling` itself can refuse with (it throws rather than report `unavailable`). */
export type WispCeilingCheckRefusal = Exclude<WispCeilingRefusal, { code: 'wisp_gate_unavailable' }>;

/** User-visible copy: the refusal is streamed to the chat as the tool's result. */
export const WISP_REFUSAL_MESSAGES: Record<CeilingViolationCode, string> = {
  org: "Wisp can't act on that organization under your current grant.",
  site: "Wisp can't act on that site under your current grant.",
  permission: "Your current Wisp grant doesn't allow this action.",
  tool: "Wisp can't use this tool under your current grant.",
  inactive: 'Your Wisp grant is no longer active (it was paused, revoked, or has expired). Turn Wisp back on, then refresh this conversation to continue.',
};

/**
 * #11432: the refusal for a call that put the grant's PARTNER id in `orgId`.
 * The ceiling refuses it as an org outside the grant either way; this says why
 * and what to pass instead, where "Wisp can't act on that organization" led the
 * model to conclude the tool could not write at all.
 */
export const WISP_PARTNER_ID_AS_ORG_MESSAGE =
  "That id is your partner, not one of its organizations, so it can't be an orgId. "
  + 'Pass a customer organization\'s orgId, or ownerScope: "partner" for a partner-owned object where the tool supports it.';

/**
 * #11433: the refusal for an action the agent deny floor keeps from every grant
 * while the tool's other actions stay delegable (`isNeverDelegableToolAction`,
 * e.g. Fleet Design apply / rollback). It says the TOOL is still usable, where
 * "Wisp can't use this tool" would read as the whole tool being off. A missing
 * or unrecognised action on such a tool gets it too (the floor fails closed);
 * the handler's own schema would refuse that call anyway.
 */
export const WISP_ACTION_NOT_DELEGABLE_MESSAGE =
  "Wisp can't take this action under any grant: a person does it in the Breeze console. "
  + "This tool's other actions are still available to Wisp.";

function refusal(detail: CeilingViolationCode, message?: string): WispCeilingCheckRefusal {
  const text = message ?? WISP_REFUSAL_MESSAGES[detail];
  return detail === 'inactive'
    ? { code: 'wisp_grant_inactive', detail, message: text }
    : { code: 'wisp_outside_ceiling', detail, message: text };
}

/**
 * `${resource}:${action}` keys a human needs for this call
 * (`resolveToolPermissionRequirements`); [] when the tool has no mapping or the
 * action does not resolve. `enforceWispCeiling` refuses those outright — it
 * never treats [] as "nothing to check".
 */
export function requiredPermissionKeys(toolName: string, input: Record<string, unknown>): string[] {
  const resolution = resolveToolPermissionRequirements(toolName, input);
  return resolution.ok ? resolution.requirements.map((r) => `${r.resource}:${r.action}`) : [];
}

/** The org a call targets for the ceiling check: its explicit `orgId`, else the session org. */
export function targetOrgIdFor(input: Record<string, unknown>, sessionOrgId: string): string {
  return typeof input.orgId === 'string' ? input.orgId : sessionOrgId;
}

function withinCeiling(ceiling: GrantCeiling, orgId: string, permissionKeys: readonly string[]): boolean {
  try {
    assertWithinCeiling(ceiling, { orgId });
    for (const permission of permissionKeys) assertWithinCeiling(ceiling, { orgId, permission });
    return true;
  } catch (err) {
    if (err instanceof CeilingViolationError) return false;
    throw err;
  }
}

/**
 * `auth` cut to the ceiling. Reach = `auth.accessibleOrgIds` (null → every
 * ceiling org) ∩ the ceiling orgs where the org / site terms and every key in
 * `permissionKeys` pass for that org. Required: a caller must say which
 * permissions the call needs ([] = org and site terms only), so a forgotten
 * argument cannot silently widen reach to orgs whose term lacks them.
 * Closures are rebuilt from the new list; the site allowlist is intersected
 * with `ceiling.siteIds` when the ceiling restricts sites (belt and braces —
 * such an org is already out of reach, see the file header). Stamps
 * `wispGrant` (w00 A2/A23) — how the memory tools learn the grant and the
 * source session on a chat turn.
 *
 * `writeDefaultOrgId` (#11432, from `enforceWispCeiling`) becomes
 * `aiWriteDefaultOrgId` when it is inside the narrowed reach, so an org-less
 * write resolves there (`resolveWritableToolOrgId` step 3). Null leaves the
 * auth's own default, if any, as it was.
 */
export function narrowAuthToCeiling(
  auth: AuthContext,
  ceiling: GrantCeiling,
  sessionId: string | undefined,
  permissionKeys: readonly string[],
  writeDefaultOrgId: string | null = null,
): AuthContext {
  const base = auth.accessibleOrgIds ?? [...ceiling.orgIds];
  const accessibleOrgIds = base.filter((orgId) => ceiling.orgIds.has(orgId) && withinCeiling(ceiling, orgId, permissionKeys));

  const reachesWholeCeiling = [...ceiling.orgIds].every((orgId) => accessibleOrgIds.includes(orgId));
  const partnerOrgAccess = auth.partnerOrgAccess === 'all' && !(ceiling.partnerWide && reachesWholeCeiling)
    ? 'selected'
    : auth.partnerOrgAccess;

  let siteFields: Pick<AuthContext, 'allowedSiteIds' | 'canAccessSite'> = {};
  if (ceiling.siteIds !== null) {
    const ceilingSites = ceiling.siteIds;
    const allowedSiteIds = (auth.allowedSiteIds ?? [...ceilingSites]).filter((siteId) => ceilingSites.has(siteId));
    siteFields = { allowedSiteIds, canAccessSite: siteAccessCheck(allowedSiteIds) };
  }

  const narrowed: AuthContext = {
    ...auth,
    accessibleOrgIds,
    ...buildOrgAccessClosures(accessibleOrgIds),
    ...siteFields,
    wispGrant: { grantId: ceiling.grantId, grantRevisionId: ceiling.revisionId, sessionId: sessionId ?? null },
  };
  if (partnerOrgAccess !== undefined) narrowed.partnerOrgAccess = partnerOrgAccess;
  if (writeDefaultOrgId !== null && accessibleOrgIds.includes(writeDefaultOrgId)) narrowed.aiWriteDefaultOrgId = writeDefaultOrgId;
  // Out-of-service report history is a route-only capability; never under a grant.
  delete narrowed.reportHistory;
  return narrowed;
}

/**
 * #11432: the org an org-less write of this call may land in: the thread's
 * focus org, and only when it is also `sessionOrgId`, the org the call is
 * checked against and its approval filed in (the session org at the chat gate,
 * the intent org at release). A focused thread normally anchors its session
 * there (aiAgent.ts `anchorWispSession`); a focus moved after the session began, or
 * an unfocused partner-wide thread, gives null, and the write must name its
 * owner. No other org is ever picked for it (#6667). Read live from the
 * thread (system context: the row is partner-axis); a DB error propagates.
 */
async function focusWriteDefaultOrgId(threadId: string, partnerId: string, sessionOrgId: string): Promise<string | null> {
  const [row] = await inSystemContext(() =>
    db
      .select({ focusOrgId: wispThreads.focusOrgId })
      .from(wispThreads)
      .where(and(eq(wispThreads.id, threadId), eq(wispThreads.partnerId, partnerId)))
      .limit(1),
  );
  return row?.focusOrgId === sessionOrgId ? sessionOrgId : null;
}

/**
 * `auth` with no org reach at all. What a Wisp session's registry handlers
 * fall back to if a call ever arrived without the gate's per-call auth —
 * defence in depth for the session's shared `getAuth`, never a working auth.
 */
export function unreachableWispAuth(auth: AuthContext): AuthContext {
  const closed: AuthContext = { ...auth, accessibleOrgIds: [], ...buildOrgAccessClosures([]) };
  if (closed.partnerOrgAccess !== undefined && closed.partnerOrgAccess !== null) closed.partnerOrgAccess = 'none';
  delete closed.reportHistory;
  return closed;
}

export type WispCeilingResult =
  | {
    ok: true;
    toolAuth: AuthContext;
    ceiling: GrantCeiling;
    permissionKeys: string[];
    /** #11432: the thread-focus write default `toolAuth` carries (null = none); pass it to every re-narrowing. */
    writeDefaultOrgId: string | null;
  }
  | { ok: false; refusal: WispCeilingCheckRefusal };

/**
 * Every ceiling term for one chat tool call. A `GrantInactiveError` is the
 * typed `wisp_grant_inactive` refusal; any OTHER error (DB down, corrupt pin)
 * propagates — the caller fails closed on it.
 *
 * `permissionRequirement` overrides the TOOL_PERMISSIONS lookup (a tenant BYO
 * MCP tool's requirement comes from its tier, not the registry).
 */
export async function enforceWispCeiling(args: {
  grant: WispSessionGrant;
  toolName: string;
  input: Record<string, unknown>;
  sessionOrgId: string;
  sessionId: string;
  toolAuth: AuthContext;
  permissionRequirement?: { resource: string; action: string };
}): Promise<WispCeilingResult> {
  let ceiling: GrantCeiling;
  try {
    ceiling = await resolveGrantCeiling(args.grant.grantId, args.grant.revisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError && err.kind !== 'corrupt') return { ok: false, refusal: refusal('inactive') };
    throw err;
  }

  // A grant belongs to one partner and is held by a partner member; a sign-in
  // outside that partner (or a system-scope one, whose reach ignores org lists
  // in places) cannot carry it.
  if (args.toolAuth.scope === 'system' || (args.toolAuth.partnerId !== null && args.toolAuth.partnerId !== ceiling.partnerId)) {
    return { ok: false, refusal: refusal('org') };
  }

  let permissionKeys: string[];
  if (args.permissionRequirement) {
    permissionKeys = [`${args.permissionRequirement.resource}:${args.permissionRequirement.action}`];
  } else {
    const resolution = resolveToolPermissionRequirements(args.toolName, args.input);
    // No resolvable human permission → it cannot be shown to sit inside the
    // grantor's authority. Fail closed, with RBAC's own model-facing reason.
    if (!resolution.ok) return { ok: false, refusal: refusal('permission', resolution.denial) };
    permissionKeys = resolution.requirements.map((r) => `${r.resource}:${r.action}`);
  }

  const targetOrgId = targetOrgIdFor(args.input, args.sessionOrgId);
  // #11433: the action feeds the tool term's action-level floor. A tenant tool
  // is called with input {} (no action), and has no such floor.
  const toolAction = typeof args.input.action === 'string' ? args.input.action : null;
  try {
    assertWithinCeiling(ceiling, { toolName: args.toolName, toolAction, orgId: targetOrgId });
    for (const permission of permissionKeys) assertWithinCeiling(ceiling, { orgId: targetOrgId, permission });
  } catch (err) {
    if (err instanceof CeilingViolationError) {
      const partnerIdAsOrg = err.code === 'org' && args.input.orgId === ceiling.partnerId;
      // Only when the tool term itself passes: a revision whose snapshot still
      // denies the whole tool keeps the plain tool message.
      const actionFloor = err.code === 'tool'
        && ceilingAdmitsTool(ceiling, args.toolName)
        && isNeverDelegableToolAction(args.toolName, toolAction);
      const message = partnerIdAsOrg ? WISP_PARTNER_ID_AS_ORG_MESSAGE : actionFloor ? WISP_ACTION_NOT_DELEGABLE_MESSAGE : undefined;
      return { ok: false, refusal: refusal(err.code, message) };
    }
    throw err;
  }

  // Only an org-less call that needs more than read permission can use the
  // default (reads never consult it), so only such a call reads the thread: a
  // failed read then denies writes, never every query of the thread. A call
  // that names its org needs none; a tenant tool acts in its executor's org.
  const mayWrite = permissionKeys.some((key) => !key.endsWith(':read'));
  const writeDefaultOrgId = !mayWrite || typeof args.input.orgId === 'string' || args.permissionRequirement
    ? null
    : await focusWriteDefaultOrgId(args.grant.threadId, ceiling.partnerId, args.sessionOrgId);
  const toolAuth = narrowAuthToCeiling(args.toolAuth, ceiling, args.sessionId, permissionKeys, writeDefaultOrgId);
  // The target passed the ceiling but the caller's own reach may not include it.
  if (!toolAuth.canAccessOrg(targetOrgId)) return { ok: false, refusal: refusal('org') };
  return { ok: true, toolAuth, ceiling, permissionKeys, writeDefaultOrgId };
}

/**
 * The thread seed for a turn whose system prompt is rebuilt (a turn carrying
 * `pageContext`). '' when the grant is no longer active or the thread's focus
 * fell outside the ceiling — the seed is context, never authority, so dropping
 * it is the safe side; the next tool call refuses on the same ceiling.
 * A supplied ceiling reuses the live snapshot already resolved for this turn's
 * record prompt; callers without one keep the existing lookup behavior. The
 * turn's record/device context resolves again under that same auth and ceiling
 * for the fenced Viewing now line. A
 * CORRUPT pin also yields '' but is logged and captured (grantAuthority's
 * contract) — the next tool call fails closed on it as gate-unavailable.
 * `model` is this turn's resolved model; given, the seed carries the
 * standing-loop section that names it (#10391).
 */
export async function wispSeedForSession(
  grant: WispSessionGrant,
  auth: AuthContext | null = null,
  ceiling?: GrantCeiling,
  pageContext?: AiPageContext,
  model?: string,
): Promise<string> {
  try {
    const live = ceiling ?? await resolveGrantCeiling(grant.grantId, grant.revisionId);
    let viewing: ResolvedEntity | null = null;
    if (pageContext?.type === 'record' || pageContext?.type === 'device' || pageContext?.type === 'alert') {
      const kind = pageContext.type === 'record' ? pageContext.kind : pageContext.type;
      try {
        const resolved = await resolveEntityRef({ auth, ceiling: live }, {
          kind,
          id: pageContext.id,
        });
        if (isResolveFailure(resolved)) {
          console.debug('[Wisp] Viewing context refused; omitting viewing from seed:', {
            reason: resolved.reason, kind, grantId: grant.grantId,
          });
        } else viewing = resolved;
      } catch (err) {
        console.error('[Wisp] Viewing context lookup failed; omitting viewing from seed:', err);
        captureException(err, undefined, { grantId: grant.grantId, op: 'wisp.seed_viewing' });
      }
    }
    const seedOpts = { ...(viewing ? { viewing } : {}), ...(model !== undefined ? { model } : {}) };
    return Object.keys(seedOpts).length > 0
      ? await seedContextForSession(grant.threadId, live, auth, seedOpts)
      : await seedContextForSession(grant.threadId, live, auth);
  } catch (err) {
    if (err instanceof GrantInactiveError && err.kind === 'corrupt') {
      console.error(`[Wisp] grant ${err.grantId} has a corrupt ceiling pin (thread seed): ${err.message}`);
      captureException(err, undefined, { grantId: err.grantId });
      return '';
    }
    if (err instanceof GrantInactiveError || err instanceof CeilingViolationError) return '';
    throw err;
  }
}

export type WispSessionUnavailableReason =
  | 'session_not_found'
  | 'grant_unpinned'
  | 'thread_unlinked'
  /** A Wisp session driven through a surface with its own MCP server (script builder, helper, client AI, topology). */
  | 'surface_unsupported';

/**
 * A session row pinned to a grant whose chat cannot be gated (no revision pin,
 * no thread link — `createSession` attaches the thread after the insert, so a
 * failed attach leaves exactly this). Thrown by `lookupWispGrant`, so
 * `streamingSessionManager.getOrCreate` refuses the turn instead of running
 * the session's tools ungated.
 */
export class WispSessionUnavailableError extends Error {
  readonly code = 'wisp_session_unavailable' as const;
  constructor(public readonly reason: WispSessionUnavailableReason, public readonly sessionId: string) {
    super('This Wisp conversation could not be resumed. Start a new Wisp conversation to continue.');
    this.name = 'WispSessionUnavailableError';
  }
}

/**
 * The grant pinned on an `ai_sessions` row: null for an ordinary session,
 * `{ grantId, revisionId, threadId }` for a Wisp one. Read in SYSTEM context
 * (the thread join is partner-axis, invisible to an org-scoped request) by the
 * server-chosen session id — never a model input. Fails closed: a missing row,
 * or a grant without its revision pin or thread link, throws
 * `WispSessionUnavailableError`; a DB error propagates.
 */
export async function lookupWispGrant(sessionId: string): Promise<WispSessionGrant | null> {
  const [row] = await inSystemContext(() =>
    db
      .select({
        grantId: aiSessions.wispGrantId,
        revisionId: aiSessions.wispGrantRevisionId,
        threadId: wispThreadSessions.threadId,
      })
      .from(aiSessions)
      .leftJoin(wispThreadSessions, and(eq(wispThreadSessions.sessionId, aiSessions.id), eq(wispThreadSessions.orgId, aiSessions.orgId)))
      .where(eq(aiSessions.id, sessionId))
      .limit(1),
  );
  if (!row) throw new WispSessionUnavailableError('session_not_found', sessionId);
  if (row.grantId === null) return null;
  if (row.revisionId === null) throw new WispSessionUnavailableError('grant_unpinned', sessionId);
  if (row.threadId === null) throw new WispSessionUnavailableError('thread_unlinked', sessionId);
  return { grantId: row.grantId, revisionId: row.revisionId, threadId: row.threadId };
}

/**
 * #10430: which tools a Wisp chat session is OFFERED — its MCP server, and so
 * the ToolSearch index built from it. A tool the ceiling's tool term refuses
 * (`deniedTools`, the agent deny floor, an allowlist) is left out, so the model
 * never finds one the gate would refuse. Built from the pinned revision's
 * snapshot, not the live ceiling: the tool term does not depend on the live
 * grantor or the grant's status, and a paused grant must still open a session
 * whose calls refuse with the "turn Wisp back on" message. Every call still
 * passes `enforceWispCeiling`.
 *
 * A missing revision row or a malformed snapshot is a corrupt pin: the filter
 * falls back to the agent deny floor (logged and captured), and every call
 * then fails closed at the gate. A DB error propagates, as in
 * `lookupWispGrant`.
 */
export async function wispSessionToolFilter(grant: WispSessionGrant): Promise<(toolName: string) => boolean> {
  const [row] = await inSystemContext(() =>
    db
      .select({ ceilingSnapshot: wispGrantRevisions.ceilingSnapshot })
      .from(wispGrantRevisions)
      .where(and(eq(wispGrantRevisions.id, grant.revisionId), eq(wispGrantRevisions.grantId, grant.grantId)))
      .limit(1),
  );
  const parsed = row ? wispCeilingSnapshotSchema.safeParse(row.ceilingSnapshot) : null;
  if (!parsed?.success) {
    const reason = row ? 'malformed ceiling snapshot' : 'revision not found';
    const err = new Error(`[Wisp] grant ${grant.grantId} revision ${grant.revisionId}: ${reason}; offering the agent deny floor only`);
    console.error(err.message);
    captureException(err, undefined, { grantId: grant.grantId, op: 'wisp.session_tool_filter' });
  }
  const term = ceilingToolTermOf(parsed?.success ? parsed.data : { deniedTools: [], toolAllowlist: null });
  return (toolName) => ceilingAdmitsTool(term, toolName);
}
