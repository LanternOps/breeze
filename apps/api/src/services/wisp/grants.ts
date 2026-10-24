/**
 * Wisp W02 — delegation grants (Wisp design §4.2, §4.4; w00 "Grants (W02)").
 *
 * A grant is created ONLY by its grantor, for themselves, in an interactive
 * partner-scoped `user_session`, with a consumed `wisp_grant` step-up grant
 * bound to the grantor + scope + the server-computed ceiling hash. It pins an
 * immutable `wisp_grant_revisions` row; refresh appends revision n+1 and never
 * mutates an old one, so work stays pinned to the revision it was admitted
 * under.
 *
 * Context discipline:
 *   - caller-facing create / refresh / revoke / settings / user pause+resume /
 *     list run in the caller's REQUEST DB context — RLS (self-only INSERT) and
 *     the wisp_grants_update_guard trigger are part of the contract;
 *   - pauseGrant / resumeGrant / getActiveGrantForUser / wideningAvailable run
 *     in SYSTEM context: their callers are workers and the reconciler, and
 *     every read is equality-keyed on the ids the caller already holds.
 */
import { and, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
import { db } from '../../db';
import { wispGrantRevisions, wispGrants } from '../../db/schema/wisp';
import type { WispCeilingSnapshot, WispGrantPauseReason, WispGrantRow, WispGrantStatus } from '../../db/schema/wisp';
import { hasSatisfiedMfa, type AuthContext } from '../../middleware/auth';
import { ENABLE_2FA } from '../../routes/auth/schemas';
import { createAuditLogAsync } from '../auditService';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { getUserEpochs } from '../authEpochs';
import { consumeStepUpGrant, wispGrantResourceDigest } from '../mfaStepUpGrant';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { permissionGrantMatches } from '../permissionMatching';
import {
  agentDeniedToolNames,
  ceilingSnapshotHash,
  computeLiveHumanTerm,
  inSystemContext,
  wispCeilingSnapshotSchema,
  type LiveHumanTerm,
} from './grantAuthority';
import { EntitlementResolutionError, getEntitlements } from '../entitlements';
import { loadWispEntitlement } from './wispEntitlementLimits';
// budget.ts imports only types from this module, so this is not a runtime cycle.
import { WISP_BUDGET_DEFAULT_BY_PLAN } from './budget';

export type { WispGrantStatus } from '../../db/schema/wisp';

export type WispGrantScope = { partnerId: string; orgId: string | null };

export type WispGrant = {
  id: string;
  partnerId: string;
  orgId: string | null;
  grantorUserId: string;
  grantee: 'wisp';
  currentRevisionId: string | null;
  status: WispGrantStatus;
  pausedReason: string | null;
  expiresAt: Date;
  budgetCentsPerDay: number;
  floorTickMinutes: number;
};

export type WispGrantErrorCode =
  | 'not_user_session'
  | 'partner_mismatch'
  | 'org_out_of_reach'
  | 'mfa_required'
  | 'step_up_required'
  | 'grantor_access_lost'
  | 'grantor_suspended'
  | 'not_found'
  | 'forbidden'
  | 'already_active'
  | 'not_active'
  | 'settings_out_of_bounds'
  | 'not_user_paused'
  /** The partner's `wisp` entitlement is disabled (plan default, row, or expired past grace). */
  | 'entitlement_required'
  /** Entitlements could not be resolved (resolver past its stale ceiling); transient. */
  | 'entitlement_check_failed';

export class WispGrantError extends Error {
  constructor(public readonly code: WispGrantErrorCode, message: string) {
    super(message);
    this.name = 'WispGrantError';
  }
}

/** W01 `WispLimits.maxGrants` reached (w00 A21); the route answers 409 GRANT_LIMIT_REACHED. */
export class GrantLimitReachedError extends Error {
  readonly code = 'grant_limit_reached' as const;
  constructor(public readonly partnerId: string, public readonly maxGrants: number, public readonly active: number) {
    super(`Partner ${partnerId} already has ${active} active Wisp grants (plan limit ${maxGrants}).`);
    this.name = 'GrantLimitReachedError';
  }
}

/** W05 derives plan bounds from W01 entitlements; W02 alone uses DEFAULT_SETTINGS_BOUNDS. */
export type GrantSettingsBounds = { budgetCentsPerDayMax: number; minFloorTickMinutes: number };

const DEFAULT_SETTINGS_BOUNDS: GrantSettingsBounds = { budgetCentsPerDayMax: 5000, minFloorTickMinutes: 15 };
const MAX_FLOOR_TICK_MINUTES = 240;
const GRANT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_FLOOR_TICK_MINUTES = 30;
const ONE_LIVE_PER_SCOPE_INDEX = 'wisp_grants_one_live_per_scope_uq';

/** Pause reasons owned by W02's own lifecycle; the others belong to W01/W05. */
export const SYSTEM_PAUSE_REASONS = [
  'grantor_access_lost',
  'grantor_suspended',
  'factor_expired',
  'entitlement_lost',
  'budget_exhausted',
  'partner_disabled',
] as const satisfies readonly Exclude<WispGrantPauseReason, 'user_paused'>[];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toGrant(row: WispGrantRow): WispGrant {
  return {
    id: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId ?? null,
    grantorUserId: row.grantorUserId,
    grantee: 'wisp',
    currentRevisionId: row.currentRevisionId ?? null,
    status: row.status,
    pausedReason: row.pausedReason ?? null,
    expiresAt: row.expiresAt,
    budgetCentsPerDay: row.budgetCentsPerDay,
    floorTickMinutes: row.floorTickMinutes,
  };
}

function systemContext<T>(fn: () => Promise<T>): Promise<T> {
  return inSystemContext(fn);
}

async function audit(input: {
  grant: Pick<WispGrant, 'id' | 'partnerId' | 'orgId'>;
  action: string;
  actor: { type: 'user'; id: string; email?: string } | { type: 'system' };
  details?: Record<string, unknown>;
}): Promise<void> {
  await createAuditLogAsync({
    partnerId: input.grant.partnerId,
    orgId: input.grant.orgId,
    actorType: input.actor.type,
    actorId: input.actor.type === 'user' ? input.actor.id : ANONYMOUS_ACTOR_ID,
    actorEmail: input.actor.type === 'user' ? input.actor.email : undefined,
    action: input.action,
    resourceType: 'wisp_grant',
    resourceId: input.grant.id,
    details: input.details,
    result: 'success',
  });
}

/**
 * The interactive-grantor gate shared by create / preview / refresh: a human
 * in a partner-scoped session, inside `scope.partnerId`, who can reach the
 * scope org. MFA is checked separately (preview does not need it).
 */
function assertInteractivePartnerCaller(auth: AuthContext, scope: WispGrantScope): void {
  if (auth.principal?.kind !== 'user_session') {
    throw new WispGrantError('not_user_session', 'A Wisp grant can only be managed from an interactive session.');
  }
  if (auth.scope !== 'partner' || !auth.partnerId || auth.partnerId !== scope.partnerId) {
    throw new WispGrantError('partner_mismatch', 'A Wisp grant lives inside your own partner.');
  }
  if (scope.orgId !== null && !auth.canAccessOrg(scope.orgId)) {
    throw new WispGrantError('org_out_of_reach', 'Organization not found.');
  }
}

function assertMfa(auth: AuthContext): void {
  if (!hasSatisfiedMfa(auth)) throw new WispGrantError('mfa_required', 'MFA is required to manage a Wisp grant.');
}

function liveOrThrow(live: LiveHumanTerm): Extract<LiveHumanTerm, { ok: true }> {
  if (!live.ok) throw new WispGrantError(live.reason, `Your current access does not allow a Wisp grant (${live.reason}).`);
  return live;
}

/** The ceiling the create / refresh path pins: the grantor's live reach, clamped to the scope. */
export function buildGrantSnapshot(live: Extract<LiveHumanTerm, { ok: true }>, scope: WispGrantScope): WispCeilingSnapshot {
  const orgIds = scope.orgId === null ? [...live.orgIds] : live.orgIds.filter((id) => id === scope.orgId);
  if (orgIds.length === 0) throw new WispGrantError('org_out_of_reach', 'Organization not found.');
  return {
    version: 1,
    permissionKeys: [...new Set(live.permissionKeys)].sort(),
    orgIds: [...new Set(orgIds)].sort(),
    siteIds: live.siteIds === null ? null : [...new Set(live.siteIds)].sort(),
    toolAllowlist: null,
    deniedTools: [...new Set(agentDeniedToolNames())].sort(),
    // Pinned so a later widening to org_access 'all' needs a refresh (§4.4).
    partnerWide: scope.orgId === null && live.partnerOrgAccess === 'all',
  };
}

/**
 * Consume the `wisp_grant` step-up bound to (caller, scope, ceiling hash).
 * Under ENABLE_2FA=false no step-up can be minted at all (the mint route is
 * off), exactly like every other step-up gate (partnerAiScriptPolicy.ts);
 * config/validate.ts refuses BREEZE_WISP_ENABLED in production in that state.
 */
async function consumeWispStepUp(auth: AuthContext, scope: WispGrantScope, ceilingHash: string, stepUpGrantId: string): Promise<string> {
  if (!ENABLE_2FA) return 'mfa_disabled';
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!stepUpGrantId || !epochs || !sid) {
    throw new WispGrantError('step_up_required', 'A fresh step-up verification is required.');
  }
  const ok = await consumeStepUpGrant(stepUpGrantId, {
    userId: auth.user.id,
    operation: 'wisp_grant',
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest: wispGrantResourceDigest({
      grantorUserId: auth.user.id,
      partnerId: scope.partnerId,
      orgId: scope.orgId,
      requestedCeilingHash: ceilingHash,
    }),
  });
  if (!ok) throw new WispGrantError('step_up_required', 'A fresh step-up verification is required.');
  return 'step_up';
}

async function loadGrantInContext(grantId: string): Promise<WispGrantRow> {
  const [row] = await db.select().from(wispGrants).where(eq(wispGrants.id, grantId)).limit(1);
  if (!row) throw new WispGrantError('not_found', 'Wisp grant not found.');
  return row;
}

/**
 * W01 `WispLimits.maxGrants` for the partner, or null for no cap (the
 * entitlement is enabled with no limits, w00 A21).
 *
 * Fails closed: a disabled `wisp` entitlement throws `entitlement_required`,
 * an unresolvable one `entitlement_check_failed`. Any other error is a bug and
 * propagates as itself; none is ever read as "no cap". Only `createGrant`
 * calls this, so existing grants are unaffected by an entitlement change.
 */
export async function resolveMaxGrants(partnerId: string): Promise<number | null> {
  let entitlement;
  try {
    entitlement = await loadWispEntitlement(partnerId);
  } catch (err) {
    if (err instanceof EntitlementResolutionError) {
      throw new WispGrantError('entitlement_check_failed', 'Entitlement check temporarily unavailable.');
    }
    throw err;
  }
  if (!entitlement.enabled) {
    throw new WispGrantError('entitlement_required', 'Wisp is not enabled for this partner.');
  }
  return entitlement.limits?.maxGrants ?? null;
}

/**
 * Spec §16 plan default for a new grant's `budget_cents_per_day` (W05). Same
 * failure mapping as resolveMaxGrants: unresolvable → entitlement_check_failed,
 * any other error propagates. Called right after resolveMaxGrants, so the
 * resolver's 60 s cache answers it without a second DB read.
 */
async function resolvePlanBudgetDefault(partnerId: string): Promise<number> {
  try {
    return WISP_BUDGET_DEFAULT_BY_PLAN[(await getEntitlements(partnerId)).plan];
  } catch (err) {
    if (err instanceof EntitlementResolutionError) {
      throw new WispGrantError('entitlement_check_failed', 'Entitlement check temporarily unavailable.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// caller-facing
// ---------------------------------------------------------------------------

/** What createGrant would pin, and the hash the client mints its step-up against (w00 A4). */
export async function previewGrantCeiling(input: { auth: AuthContext; scope: WispGrantScope }): Promise<{
  scope: WispGrantScope;
  ceilingSnapshot: WispCeilingSnapshot;
  ceilingHash: string;
}> {
  assertInteractivePartnerCaller(input.auth, input.scope);
  const live = liveOrThrow(await computeLiveHumanTerm(input.auth.user.id, input.scope.partnerId));
  const ceilingSnapshot = buildGrantSnapshot(live, input.scope);
  return { scope: input.scope, ceilingSnapshot, ceilingHash: ceilingSnapshotHash(ceilingSnapshot) };
}

export async function createGrant(input: { auth: AuthContext; scope: WispGrantScope; stepUpGrantId: string }): Promise<WispGrant> {
  const { auth, scope } = input;
  assertInteractivePartnerCaller(auth, scope);
  assertMfa(auth);

  // Entitlement gate + commercial cap (spec §10 limits.maxGrants) — checked
  // before the step-up is consumed so a refused attempt does not burn the proof. Two concurrent
  // creates at max−1 can both pass: the cap is a commercial limit, not an
  // authority term, so a transient +1 is accepted and the next create refuses.
  const maxGrants = await resolveMaxGrants(scope.partnerId);
  if (maxGrants !== null) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wispGrants)
      .where(and(eq(wispGrants.partnerId, scope.partnerId), eq(wispGrants.status, 'active')));
    const active = Number(row?.count ?? 0);
    if (active >= maxGrants) throw new GrantLimitReachedError(scope.partnerId, maxGrants, active);
  }
  const budgetCentsPerDay = await resolvePlanBudgetDefault(scope.partnerId);

  const live = liveOrThrow(await computeLiveHumanTerm(auth.user.id, scope.partnerId));
  const snapshot = buildGrantSnapshot(live, scope);
  const method = await consumeWispStepUp(auth, scope, ceilingSnapshotHash(snapshot), input.stepUpGrantId);

  let created: WispGrantRow;
  try {
    created = await db.transaction(async (tx) => {
      const [grant] = await tx
        .insert(wispGrants)
        .values({
          partnerId: scope.partnerId,
          orgId: scope.orgId,
          grantorUserId: auth.user.id,
          grantee: 'wisp',
          currentRevisionId: null,
          status: 'active',
          expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
          budgetCentsPerDay,
          floorTickMinutes: DEFAULT_FLOOR_TICK_MINUTES,
        })
        .returning();
      if (!grant) throw new Error('wisp grant insert returned no row');
      const [revision] = await tx
        .insert(wispGrantRevisions)
        .values({
          grantId: grant.id,
          partnerId: scope.partnerId,
          revision: 1,
          ceilingSnapshot: snapshot,
          factorProof: { method, verifiedAt: new Date().toISOString() },
        })
        .returning({ id: wispGrantRevisions.id });
      if (!revision) throw new Error('wisp grant revision insert returned no row');
      const [linked] = await tx
        .update(wispGrants)
        .set({ currentRevisionId: revision.id })
        .where(eq(wispGrants.id, grant.id))
        .returning();
      if (!linked) throw new Error('wisp grant revision link returned no row');
      return linked;
    });
  } catch (err) {
    if (isPgUniqueViolation(err, ONE_LIVE_PER_SCOPE_INDEX)) {
      throw new WispGrantError('already_active', 'You already have Wisp turned on for this scope.');
    }
    throw err;
  }

  const grant = toGrant(created);
  await audit({
    grant,
    action: 'wisp.grant.created',
    actor: { type: 'user', id: auth.user.id, email: auth.user.email },
    details: { revisionId: grant.currentRevisionId, revision: 1 },
  });
  return grant;
}

/** Re-snapshot the grantor's live reach as revision n+1 (the §4.4 widening path) and renew the expiry. */
export async function refreshGrant(input: { auth: AuthContext; grantId: string; stepUpGrantId: string }): Promise<WispGrant> {
  const { auth } = input;
  const row = await loadGrantInContext(input.grantId);
  if (row.grantorUserId !== auth.user.id) throw new WispGrantError('forbidden', 'Only the grantor can refresh a Wisp grant.');
  if (row.status !== 'active' && row.status !== 'paused') throw new WispGrantError('not_active', 'This Wisp grant has ended; turn Wisp on again.');
  const scope: WispGrantScope = { partnerId: row.partnerId, orgId: row.orgId ?? null };
  assertInteractivePartnerCaller(auth, scope);
  assertMfa(auth);

  const live = liveOrThrow(await computeLiveHumanTerm(auth.user.id, scope.partnerId));
  const snapshot = buildGrantSnapshot(live, scope);
  const method = await consumeWispStepUp(auth, scope, ceilingSnapshotHash(snapshot), input.stepUpGrantId);

  let refreshed: { updated: WispGrantRow; revisionNumber: number };
  try {
    refreshed = await db.transaction(async (tx) => {
    const [agg] = await tx
      .select({ maxRevision: max(wispGrantRevisions.revision) })
      .from(wispGrantRevisions)
      .where(eq(wispGrantRevisions.grantId, row.id));
    const nextRevision = Number(agg?.maxRevision ?? 0) + 1;
    const [revision] = await tx
      .insert(wispGrantRevisions)
      .values({
        grantId: row.id,
        partnerId: row.partnerId,
        revision: nextRevision,
        ceilingSnapshot: snapshot,
        factorProof: { method, verifiedAt: new Date().toISOString() },
      })
      .returning({ id: wispGrantRevisions.id });
    if (!revision) throw new Error('wisp grant revision insert returned no row');
    // A paused grant stays paused: refresh widens the pin, never the status.
    const [next] = await tx
      .update(wispGrants)
      .set({ currentRevisionId: revision.id, expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS) })
      .where(and(eq(wispGrants.id, row.id), eq(wispGrants.status, row.status)))
      .returning();
    if (!next) throw new WispGrantError('not_active', 'This Wisp grant changed while refreshing; try again.');
    return { updated: next, revisionNumber: nextRevision };
    });
  } catch (err) {
    // Two concurrent refreshes compute the same revision n+1; the loser trips
    // wisp_grant_revisions_grant_rev_uq. Not a server error: tell it to retry.
    if (isPgUniqueViolation(err, 'wisp_grant_revisions_grant_rev_uq')) {
      throw new WispGrantError('not_active', 'This Wisp grant changed while refreshing; try again.');
    }
    throw err;
  }
  const { updated, revisionNumber } = refreshed;

  const grant = toGrant(updated);
  await audit({
    grant,
    action: 'wisp.grant.refreshed',
    actor: { type: 'user', id: auth.user.id, email: auth.user.email },
    details: { revisionId: grant.currentRevisionId, revision: revisionNumber },
  });
  return grant;
}

/** Grantor or partner admin (canManagePartnerWidePolicies). Revoking a revoked/expired grant is a no-op. */
export async function revokeGrant(input: { auth: AuthContext; grantId: string }): Promise<void> {
  const { auth } = input;
  const row = await loadGrantInContext(input.grantId);
  if (row.grantorUserId !== auth.user.id && !canManagePartnerWidePolicies(auth)) {
    throw new WispGrantError('forbidden', 'Only the grantor or a partner admin can revoke a Wisp grant.');
  }
  if (row.status === 'revoked' || row.status === 'expired') return;
  const [updated] = await db
    .update(wispGrants)
    .set({ status: 'revoked', revokedAt: new Date(), revokedByUserId: auth.user.id, pausedReason: null })
    .where(and(eq(wispGrants.id, row.id), eq(wispGrants.status, row.status)))
    .returning();
  if (!updated) throw new WispGrantError('not_active', 'This Wisp grant changed while revoking; try again.');
  await audit({
    grant: toGrant(updated),
    action: 'wisp.grant.revoked',
    actor: { type: 'user', id: auth.user.id, email: auth.user.email },
    details: { revisionId: updated.currentRevisionId, byGrantor: row.grantorUserId === auth.user.id },
  });
}

/**
 * Budget and floor tick are operational settings, not authority (w00 A6): the
 * grantor or a partner admin may change them; the revision is never touched.
 */
export async function updateGrantSettings(input: {
  auth: AuthContext;
  grantId: string;
  patch: { budgetCentsPerDay?: number; floorTickMinutes?: number };
  bounds?: GrantSettingsBounds;
}): Promise<WispGrant> {
  // The DB CHECK floor is 15 minutes; caller bounds can only tighten it.
  const requested = input.bounds ?? DEFAULT_SETTINGS_BOUNDS;
  const bounds: GrantSettingsBounds = {
    budgetCentsPerDayMax: requested.budgetCentsPerDayMax,
    minFloorTickMinutes: Math.max(DEFAULT_SETTINGS_BOUNDS.minFloorTickMinutes, requested.minFloorTickMinutes),
  };
  const { budgetCentsPerDay, floorTickMinutes } = input.patch;
  const outOfBounds = () => new WispGrantError(
    'settings_out_of_bounds',
    `Budget must be 0–${bounds.budgetCentsPerDayMax} cents/day and the floor tick ${bounds.minFloorTickMinutes}–${MAX_FLOOR_TICK_MINUTES} minutes.`,
  );
  if (budgetCentsPerDay === undefined && floorTickMinutes === undefined) throw outOfBounds();
  if (budgetCentsPerDay !== undefined
    && (!Number.isInteger(budgetCentsPerDay) || budgetCentsPerDay < 0 || budgetCentsPerDay > bounds.budgetCentsPerDayMax)) {
    throw outOfBounds();
  }
  if (floorTickMinutes !== undefined
    && (!Number.isInteger(floorTickMinutes) || floorTickMinutes < bounds.minFloorTickMinutes || floorTickMinutes > MAX_FLOOR_TICK_MINUTES)) {
    throw outOfBounds();
  }

  const { auth } = input;
  const row = await loadGrantInContext(input.grantId);
  if (row.grantorUserId !== auth.user.id && !canManagePartnerWidePolicies(auth)) {
    throw new WispGrantError('forbidden', 'Only the grantor or a partner admin can change these settings.');
  }
  const set: { budgetCentsPerDay?: number; floorTickMinutes?: number } = {};
  if (budgetCentsPerDay !== undefined) set.budgetCentsPerDay = budgetCentsPerDay;
  if (floorTickMinutes !== undefined) set.floorTickMinutes = floorTickMinutes;
  const [updated] = await db.update(wispGrants).set(set).where(eq(wispGrants.id, row.id)).returning();
  if (!updated) throw new WispGrantError('not_found', 'Wisp grant not found.');
  await audit({
    grant: toGrant(updated),
    action: 'wisp.grant.settings_changed',
    actor: { type: 'user', id: auth.user.id, email: auth.user.email },
    details: {
      from: { budgetCentsPerDay: row.budgetCentsPerDay, floorTickMinutes: row.floorTickMinutes },
      to: { budgetCentsPerDay: updated.budgetCentsPerDay, floorTickMinutes: updated.floorTickMinutes },
    },
  });
  return toGrant(updated);
}

/** w00 A29: the grantor's own off-switch. No step-up — pausing never widens. */
export async function userPauseGrant(input: { auth: AuthContext; grantId: string }): Promise<WispGrant> {
  const { auth } = input;
  const row = await loadGrantInContext(input.grantId);
  if (row.grantorUserId !== auth.user.id) throw new WispGrantError('forbidden', 'Only the grantor can pause their Wisp.');
  if (row.status !== 'active') throw new WispGrantError('not_active', 'Wisp is not running under this grant.');
  const [updated] = await db
    .update(wispGrants)
    .set({ status: 'paused', pausedReason: 'user_paused', pausedAt: new Date() })
    .where(and(eq(wispGrants.id, row.id), eq(wispGrants.status, 'active')))
    .returning();
  if (!updated) throw new WispGrantError('not_active', 'Wisp is not running under this grant.');
  const grant = toGrant(updated);
  await audit({ grant, action: 'wisp.grant.paused', actor: { type: 'user', id: auth.user.id, email: auth.user.email }, details: { reason: 'user_paused', revisionId: grant.currentRevisionId } });
  return grant;
}

/**
 * w00 A29: resume a USER pause only — system pauses resume through their own
 * reconcilers (`not_user_paused`, 409). Keeps the current revision; no
 * step-up. Fails closed when the grantor lost standing while paused.
 */
export async function userResumeGrant(input: { auth: AuthContext; grantId: string }): Promise<WispGrant> {
  const { auth } = input;
  const row = await loadGrantInContext(input.grantId);
  if (row.grantorUserId !== auth.user.id) throw new WispGrantError('forbidden', 'Only the grantor can resume their Wisp.');
  if (row.status !== 'paused' || row.pausedReason !== 'user_paused') {
    throw new WispGrantError('not_user_paused', 'This Wisp grant is not paused by you, so it cannot be resumed here.');
  }
  if (row.expiresAt.getTime() <= Date.now()) throw new WispGrantError('not_active', 'This Wisp grant has expired; turn Wisp on again.');
  liveOrThrow(await computeLiveHumanTerm(row.grantorUserId, row.partnerId));

  const [updated] = await db
    .update(wispGrants)
    .set({ status: 'active', pausedReason: null, pausedAt: null })
    .where(and(eq(wispGrants.id, row.id), eq(wispGrants.status, 'paused'), eq(wispGrants.pausedReason, 'user_paused')))
    .returning();
  if (!updated) throw new WispGrantError('not_user_paused', 'This Wisp grant is not paused by you, so it cannot be resumed here.');

  // Restart the watches the pause stopped (w00 A29). wisp_watches is W05's
  // table; until it exists this is skipped. W05: keep this UPDATE admitted for
  // the grantor's own request context.
  const present = (await db.execute(sql`SELECT to_regclass('public.wisp_watches') IS NOT NULL AS present`)) as unknown as Array<{ present?: boolean }>;
  if (present[0]?.present) {
    await db.execute(sql`
      UPDATE wisp_watches SET status = 'active', stopped_reason = NULL, next_due_at = now()
       WHERE grant_id = ${row.id} AND stopped_reason = 'paused'`);
  }

  const grant = toGrant(updated);
  await audit({ grant, action: 'wisp.grant.resumed', actor: { type: 'user', id: auth.user.id, email: auth.user.email }, details: { revisionId: grant.currentRevisionId, reason: 'user_paused' } });
  return grant;
}

export async function listGrants(input: { auth: AuthContext; view: 'mine' | 'partner' }): Promise<WispGrant[]> {
  const { auth } = input;
  if (!auth.partnerId) return [];
  if (input.view === 'partner' && !canManagePartnerWidePolicies(auth)) {
    throw new WispGrantError('forbidden', 'Listing every Wisp grant in the partner requires full partner access.');
  }
  const where = input.view === 'mine'
    ? and(eq(wispGrants.partnerId, auth.partnerId), eq(wispGrants.grantorUserId, auth.user.id))
    : eq(wispGrants.partnerId, auth.partnerId);
  const rows = await db.select().from(wispGrants).where(where).orderBy(desc(wispGrants.createdAt)).limit(500);
  return rows.map(toGrant);
}

// ---------------------------------------------------------------------------
// system paths (workers, reconciler, later waves)
// ---------------------------------------------------------------------------

/**
 * Tighten: active → paused. On an already-paused grant the earlier reason
 * stands, except that a system reason replaces 'user_paused' (so the grantor's
 * resume is refused with not_user_paused and the system owner resumes it). A
 * revoked / expired grant is never touched.
 */
export async function pauseGrant(
  grantId: string,
  reason: WispGrantPauseReason,
  opts: {
    /**
     * Pause only an ACTIVE grant; never touch one already paused. The W02
     * reconciler passes this: its standing was judged against an active row,
     * and a pause the grantor made meanwhile must stay theirs (w00 A29).
     */
    onlyFromActive?: boolean;
  } = {},
): Promise<void> {
  const changed = await systemContext(async () => {
    const [row] = await db.select().from(wispGrants).where(eq(wispGrants.id, grantId)).limit(1);
    if (!row) return null;
    if (row.status === 'active') {
      const [updated] = await db
        .update(wispGrants)
        .set({ status: 'paused', pausedReason: reason, pausedAt: new Date() })
        .where(and(eq(wispGrants.id, grantId), eq(wispGrants.status, 'active')))
        .returning();
      return updated ?? null;
    }
    if (!opts.onlyFromActive && row.status === 'paused' && row.pausedReason === 'user_paused' && reason !== 'user_paused') {
      const [updated] = await db
        .update(wispGrants)
        .set({ pausedReason: reason })
        .where(and(eq(wispGrants.id, grantId), eq(wispGrants.status, 'paused'), eq(wispGrants.pausedReason, 'user_paused')))
        .returning();
      return updated ?? null;
    }
    return null;
  });
  if (changed) {
    await audit({ grant: toGrant(changed), action: 'wisp.grant.paused', actor: { type: 'system' }, details: { reason, revisionId: changed.currentRevisionId } });
  }
}

/**
 * paused → active for a SYSTEM pause whose cause has cleared. Never resumes a
 * 'user_paused' grant (w00 A29), an expired one, or a non-paused one.
 * Callers own the "has the cause cleared" judgement for their reason, so they
 * pass `expectedReason`: the resume is a compare-and-set on exactly the pause
 * they judged, and a different pause set meanwhile (another wave's budget or
 * entitlement pause) is left alone.
 */
export async function resumeGrant(grantId: string, expectedReason?: WispGrantPauseReason): Promise<void> {
  const changed = await systemContext(async () => {
    const [row] = await db.select().from(wispGrants).where(eq(wispGrants.id, grantId)).limit(1);
    if (!row || row.status !== 'paused' || row.pausedReason === 'user_paused') return null;
    if (expectedReason !== undefined && row.pausedReason !== expectedReason) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const [updated] = await db
      .update(wispGrants)
      .set({ status: 'active', pausedReason: null, pausedAt: null })
      .where(and(eq(wispGrants.id, grantId), eq(wispGrants.status, 'paused'), eq(wispGrants.pausedReason, row.pausedReason!)))
      .returning();
    return updated ? { updated, from: row.pausedReason } : null;
  });
  if (changed) {
    await audit({ grant: toGrant(changed.updated), action: 'wisp.grant.resumed', actor: { type: 'system' }, details: { reason: changed.from, revisionId: changed.updated.currentRevisionId } });
  }
}

/** The user's live (active, unexpired) grant for exactly this scope, or null. */
export async function getActiveGrantForUser(userId: string, scope: WispGrantScope): Promise<WispGrant | null> {
  const [row] = await systemContext(() =>
    db
      .select()
      .from(wispGrants)
      .where(and(
        eq(wispGrants.grantorUserId, userId),
        eq(wispGrants.partnerId, scope.partnerId),
        scope.orgId === null ? isNull(wispGrants.orgId) : eq(wispGrants.orgId, scope.orgId),
        eq(wispGrants.status, 'active'),
        sql`${wispGrants.expiresAt} > now()`,
      ))
      .limit(1),
  );
  return row ? toGrant(row) : null;
}

function covers(keys: readonly string[], key: string): boolean {
  const i = key.indexOf(':');
  if (i <= 0) return false;
  const resource = key.slice(0, i);
  const action = key.slice(i + 1);
  return keys.some((k) => {
    const j = k.indexOf(':');
    return j > 0 && permissionGrantMatches({ resource: k.slice(0, j), action: k.slice(j + 1) }, resource, action);
  });
}

/**
 * Spec §4.4 widening offer: true when the grantor's LIVE reach exceeds the
 * current revision's snapshot (an org or a permission key the snapshot does
 * not cover); false when equal, narrower, or the live term is not ok.
 */
export async function wideningAvailable(grantId: string): Promise<boolean> {
  const [row] = await systemContext(() =>
    db
      .select({
        id: wispGrants.id,
        partnerId: wispGrants.partnerId,
        orgId: wispGrants.orgId,
        grantorUserId: wispGrants.grantorUserId,
        ceilingSnapshot: wispGrantRevisions.ceilingSnapshot,
      })
      .from(wispGrants)
      .innerJoin(wispGrantRevisions, and(eq(wispGrantRevisions.id, wispGrants.currentRevisionId), eq(wispGrantRevisions.grantId, wispGrants.id)))
      .where(eq(wispGrants.id, grantId))
      .limit(1),
  );
  if (!row) return false;
  const parsed = wispCeilingSnapshotSchema.safeParse(row.ceilingSnapshot);
  if (!parsed.success) return false;
  const live = await computeLiveHumanTerm(row.grantorUserId, row.partnerId);
  if (!live.ok) return false;

  const snapshotOrgs = new Set(parsed.data.orgIds);
  const liveOrgs = row.orgId === null ? live.orgIds : live.orgIds.filter((id) => id === row.orgId);
  if (liveOrgs.some((id) => !snapshotOrgs.has(id))) return true;
  // A partner-wide grant whose grantor gained org_access 'all' since the pin.
  if (row.orgId === null && live.partnerOrgAccess === 'all' && parsed.data.partnerWide !== true) return true;
  return live.permissionKeys.some((k) => !covers(parsed.data.permissionKeys, k));
}
