/**
 * Wisp W02 — the human-authority evaluator (Wisp design §4.1, §4.3).
 *
 *   ceiling = pinned grant revision
 *           ∩ the grantor's LIVE concrete permissions / org reach / site reach
 *           ∩ agent policy (applied by the callers: admission and release)
 *
 * with AGENT_HUMAN_ONLY_TOOLS ∪ AGENT_DENIED_READ_TOOLS always denied.
 *
 * This is deliberately NOT aiSessionLiveAuthority.ts, which refuses every
 * non-`user_session` principal by design: Wisp work runs under the `ai_agent`
 * principal, whose DB context carries `userId: null` and cannot satisfy the
 * partner-axis policies on wisp_grants. Every read here therefore runs in the
 * SYSTEM DB context (w00 A7). That is safe because the grant id is never chosen
 * by the model — it is the one pinned on the run / task / session being
 * evaluated, and every caller passes that pinned pair.
 *
 * One pure function, `assertWithinCeiling`, is the single place a ceiling term
 * is compared. Permission keys are matched with the wildcard-aware
 * `permissionGrantMatches`, never by set membership: a Partner Admin's ceiling
 * is the literal `*:*` (w00 A3).
 *
 * Org-axis precedence ("Wisp never exceeds its human", §4). The human
 * permission resolver (permissions.ts getUserPermissions) resolves the ORG axis
 * first: in an org where the user has an `organization_users` row, that row's
 * role and `site_ids` govern, not the partner role. The live term therefore
 * reads the grantor's org memberships for every org in reach, and:
 *   - an org whose membership role lacks `ai_sessions:use` leaves the ceiling
 *     (the human cannot use AI there), and the grantor no longer counts as
 *     reaching the whole partner (`partnerOrgAccess` drops to 'selected', so
 *     partner-level subjects close);
 *   - every other membership becomes a per-org term (`GrantCeiling.orgTerms`):
 *     role keys ∩ the ceiling's keys and the row's site allowlist ∩ the
 *     ceiling's. It only ever NARROWS: an org role wider than the partner role
 *     does not widen that org (narrowest faithful reading — the partner role is
 *     what the grant was taken under, and a membership can only take away);
 *   - an org without a membership keeps the partner-axis term.
 * A permission check bound to an org uses that org's term; an UNBOUND or
 * partner-level permission check (orgId undefined / null) must hold in the
 * ceiling AND in every per-org term — it could be exercised in any of them.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { organizationUsers, permissions, rolePermissions, users } from '../../db/schema/users';
import { wispEnabled } from '../../config/env';
import { wispGrantRevisions, wispGrants } from '../../db/schema/wisp';
import type { WispCeilingSnapshot, WispGrantStatus } from '../../db/schema/wisp';
import { AGENT_DENIED_READ_TOOLS, AGENT_HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import { permissionGrantMatches } from '../permissionMatching';

export type GrantCeiling = {
  grantId: string;
  revisionId: string;
  partnerId: string;
  /** w00 A3 — W03's broker and W05's watches read it; no second lookup. */
  grantorUserId: string;
  /** w00 A30 — `wisp_grants.org_id`; null = partner-wide. */
  scopeOrgId: string | null;
  /**
   * True only for a partner-wide grant (scopeOrgId null) whose grantor STILL
   * has `org_access = 'all'`. Partner-level subjects (check.orgId null — they
   * aggregate across every org of the partner) pass only when this is true, so
   * a grantor narrowed to 'selected' keeps per-org reach but loses the
   * cross-org view live.
   */
  partnerWide: boolean;
  /** Orgs inside the ceiling (partner-wide → every live org of the partner the grantor may access ∩ snapshot). */
  orgIds: ReadonlySet<string>;
  /** null = unrestricted within orgIds. */
  siteIds: ReadonlySet<string> | null;
  /** Concrete `${resource}:${action}` keys the grantor holds NOW ∩ snapshot; may contain wildcards. */
  permissionKeys: ReadonlySet<string>;
  /** Snapshot allowlist; null = agent policy default. */
  toolAllowlist: ReadonlySet<string> | null;
  /** AGENT_HUMAN_ONLY_TOOLS ∪ AGENT_DENIED_READ_TOOLS ∪ snapshot denies. */
  deniedTools: ReadonlySet<string>;
  /**
   * Per-org narrowing from the grantor's `organization_users` rows (org-axis
   * precedence; see the file header). Only orgs inside `orgIds` that have a
   * membership appear; an org without an entry is governed by the ceiling-wide
   * terms alone. Entries never widen the ceiling.
   */
  orgTerms: ReadonlyMap<string, OrgCeilingTerm>;
  status: WispGrantStatus;
};

export type OrgCeilingTerm = {
  /** The membership role's keys ∩ `permissionKeys`; may contain wildcards. */
  permissionKeys: ReadonlySet<string>;
  /** null = no site restriction from the membership. */
  siteIds: ReadonlySet<string> | null;
};

/** One `organization_users` row of the grantor (duplicates for one org already intersected). */
export type LiveOrgMembership = { orgId: string; permissionKeys: string[]; siteIds: string[] | null };

export type CeilingCheck = {
  toolName?: string;
  /** `${resource}:${action}` */
  permission?: string;
  /** undefined = no org term; null = a partner-level subject (allowed only for a partner-wide grant). */
  orgId?: string | null;
  siteId?: string | null;
};

export type CeilingViolationCode = 'org' | 'site' | 'permission' | 'tool' | 'inactive';

/**
 * Why a grant cannot be used, for callers that must tell a recoverable state
 * from a permanent one (release pauses only `paused`):
 *   - `paused`  — may come back: a pause of any reason, the grantor's lost
 *                 standing (the reconciler persists it), or Wisp switched off;
 *   - `ended`   — never comes back: revoked, expired, or the grant is gone;
 *   - `corrupt` — the pin itself is broken (revision of another grant,
 *                 malformed snapshot). Callers log and capture it.
 */
export type GrantInactiveKind = 'paused' | 'ended' | 'corrupt';

/** The grant cannot be used right now (paused / revoked / expired / missing / grantor lost standing). */
export class GrantInactiveError extends Error {
  readonly code = 'grant_inactive' as const;
  readonly kind: GrantInactiveKind;
  constructor(
    public readonly grantId: string,
    public readonly status: WispGrantStatus,
    detail?: string,
    kind?: GrantInactiveKind,
  ) {
    super(`Wisp grant ${grantId} is not active (${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'GrantInactiveError';
    this.kind = kind ?? (status === 'revoked' || status === 'expired' ? 'ended' : 'paused');
  }
}

/** A specific check fell outside the delegation ceiling. */
export class CeilingViolationError extends Error {
  constructor(
    public readonly code: CeilingViolationCode,
    message: string,
  ) {
    super(message);
    this.name = 'CeilingViolationError';
  }
}

export type LiveHumanTerm =
  | {
    ok: true;
    permissionKeys: string[];
    orgIds: string[];
    siteIds: string[] | null;
    partnerOrgAccess: 'all' | 'selected' | 'none';
    /** The grantor's org memberships for orgs in `orgIds` (each holds `ai_sessions:use`). */
    orgMemberships: LiveOrgMembership[];
  }
  | { ok: false; reason: 'grantor_suspended' | 'grantor_access_lost' };

type LiveOk = Extract<LiveHumanTerm, { ok: true }>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parsePermissionKey(key: string): { resource: string; action: string } | null {
  const i = key.indexOf(':');
  if (i <= 0 || i === key.length - 1) return null;
  return { resource: key.slice(0, i), action: key.slice(i + 1) };
}

function keyMatches(keys: Iterable<string>, resource: string, action: string): boolean {
  for (const k of keys) {
    const grant = parsePermissionKey(k);
    if (grant && permissionGrantMatches(grant, resource, action)) return true;
  }
  return false;
}

/**
 * Throws CeilingViolationError when `check` falls outside `ceiling`. Order:
 * inactive → tool (deny registries, then allowlist) → org → site → permission.
 */
export function assertWithinCeiling(ceiling: GrantCeiling, check: CeilingCheck): void {
  if (ceiling.status !== 'active') {
    throw new CeilingViolationError('inactive', `delegation grant ${ceiling.grantId} is ${ceiling.status}`);
  }

  if (check.toolName !== undefined) {
    // The two agent deny registries are checked directly too, so the
    // never-delegable floor does not depend on how the ceiling was built.
    if (
      ceiling.deniedTools.has(check.toolName)
      || AGENT_HUMAN_ONLY_TOOLS.has(check.toolName)
      || AGENT_DENIED_READ_TOOLS.has(check.toolName)
    ) {
      throw new CeilingViolationError('tool', `tool ${check.toolName} is never delegable`);
    }
    if (ceiling.toolAllowlist !== null && !ceiling.toolAllowlist.has(check.toolName)) {
      throw new CeilingViolationError('tool', `tool ${check.toolName} is outside the grant's tool allowlist`);
    }
  }

  if (check.orgId !== undefined) {
    if (check.orgId === null) {
      if (ceiling.scopeOrgId !== null || !ceiling.partnerWide) {
        throw new CeilingViolationError('org', 'a partner-level subject needs a partner-wide grant held with full partner org access');
      }
    } else if (
      !ceiling.orgIds.has(check.orgId)
      // Belt and braces: an org-scoped grant never reaches past its scope org,
      // whatever its org set says.
      || (ceiling.scopeOrgId !== null && check.orgId !== ceiling.scopeOrgId)
    ) {
      throw new CeilingViolationError('org', `organization ${check.orgId} is outside the delegation ceiling`);
    }
  }

  // The org's own term (org-axis precedence), when the check is bound to an org.
  const orgTerm = typeof check.orgId === 'string' ? ceiling.orgTerms.get(check.orgId) : undefined;

  if (check.orgId !== undefined || check.siteId !== undefined) {
    // An unknown site never widens a site-restricted ceiling — nor a
    // site-restricted org membership.
    for (const siteIds of [ceiling.siteIds, orgTerm?.siteIds ?? null]) {
      if (siteIds !== null && (check.siteId == null || !siteIds.has(check.siteId))) {
        throw new CeilingViolationError('site', `site ${check.siteId ?? '(unknown)'} is outside the delegation ceiling`);
      }
    }
  }

  if (check.permission !== undefined) {
    const required = parsePermissionKey(check.permission);
    // Always the ceiling-wide keys (an org term never widens them), plus the
    // bound org's term — or, unbound / partner-level, EVERY org term.
    const termKeys: Array<ReadonlySet<string>> = [ceiling.permissionKeys];
    if (orgTerm) termKeys.push(orgTerm.permissionKeys);
    else if (typeof check.orgId !== 'string') for (const t of ceiling.orgTerms.values()) termKeys.push(t.permissionKeys);
    if (!required || termKeys.some((keys) => !keyMatches(keys, required.resource, required.action))) {
      throw new CeilingViolationError('permission', `permission ${check.permission} is outside the delegation ceiling`);
    }
  }
}

/**
 * One tool call against the ceiling: the tool / org / site terms first (so a
 * never-delegable tool reports as such), then EVERY human permission the call
 * needs. `requirements` is `requiredPermissionsForTool(toolName, input)` from
 * the caller; null or empty — no resolvable human permission — cannot be shown
 * to sit inside the grantor's authority, so it FAILS CLOSED as a permission
 * violation. The run loop and release both use this; there is no second copy.
 */
export function assertToolCallWithinCeiling(
  ceiling: GrantCeiling,
  call: { toolName: string; orgId: string; siteId: string | null },
  requirements: ReadonlyArray<{ resource: string; action: string }> | null,
): void {
  assertWithinCeiling(ceiling, call);
  if (!requirements || requirements.length === 0) {
    throw new CeilingViolationError('permission', `tool ${call.toolName} has no human permission mapping`);
  }
  for (const r of requirements) {
    assertWithinCeiling(ceiling, { ...call, permission: `${r.resource}:${r.action}` });
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** sha256 hex of the canonical snapshot: fixed key order, every array sorted + deduplicated. */
export function ceilingSnapshotHash(snapshot: WispCeilingSnapshot): string {
  const canonical = JSON.stringify({
    deniedTools: sortedUnique(snapshot.deniedTools),
    orgIds: sortedUnique(snapshot.orgIds),
    permissionKeys: sortedUnique(snapshot.permissionKeys),
    siteIds: snapshot.siteIds === null ? null : sortedUnique(snapshot.siteIds),
    toolAllowlist: snapshot.toolAllowlist === null ? null : sortedUnique(snapshot.toolAllowlist),
    version: snapshot.version,
    partnerWide: snapshot.partnerWide === true,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Meet of two grants on one axis: the narrower value, or null when disjoint. */
function meetAxis(a: string, b: string): string | null {
  if (a === b) return a;
  if (a === '*') return b;
  if (b === '*') return a;
  return null;
}

/**
 * Wildcard-aware permission intersection: every pairwise meet. `*:*` ∩
 * `devices:read` = `devices:read`; `devices:*` ∩ `*:read` = `devices:read`.
 * Never wider than either side.
 */
function intersectPermissionKeys(a: Iterable<string>, b: Iterable<string>): Set<string> {
  const left = [...a].map(parsePermissionKey).filter((p): p is { resource: string; action: string } => p !== null);
  const right = [...b].map(parsePermissionKey).filter((p): p is { resource: string; action: string } => p !== null);
  const out = new Set<string>();
  for (const l of left) {
    for (const r of right) {
      const resource = meetAxis(l.resource, r.resource);
      const action = meetAxis(l.action, r.action);
      if (resource !== null && action !== null) out.add(`${resource}:${action}`);
    }
  }
  return out;
}

/** Snapshot ∩ live for the three reach terms. Never widens any term. */
export function intersectSnapshotWithLive(
  snapshot: WispCeilingSnapshot,
  live: LiveOk,
): Pick<GrantCeiling, 'orgIds' | 'siteIds' | 'permissionKeys'> {
  const liveOrgs = new Set(live.orgIds);
  const orgIds = new Set(snapshot.orgIds.filter((id) => liveOrgs.has(id)));

  let siteIds: Set<string> | null;
  if (snapshot.siteIds === null) {
    siteIds = live.siteIds === null ? null : new Set(live.siteIds);
  } else if (live.siteIds === null) {
    siteIds = new Set(snapshot.siteIds);
  } else {
    const liveSites = new Set(live.siteIds);
    siteIds = new Set(snapshot.siteIds.filter((id) => liveSites.has(id)));
  }

  return { orgIds, siteIds, permissionKeys: intersectPermissionKeys(snapshot.permissionKeys, live.permissionKeys) };
}

/** Two optional site allowlists → the narrower one (null = unrestricted). */
function intersectSiteAllowlists(a: Iterable<string> | null, b: Iterable<string> | null): Set<string> | null {
  if (a === null) return b === null ? null : new Set(b);
  if (b === null) return new Set(a);
  const right = new Set(b);
  return new Set([...a].filter((id) => right.has(id)));
}

/**
 * Per-org terms for the orgs inside the ceiling that carry a grantor
 * membership: role keys ∩ ceiling keys (never wider than the ceiling), and the
 * membership's sites ∩ the ceiling's.
 */
export function buildOrgTerms(
  ceiling: Pick<GrantCeiling, 'orgIds' | 'siteIds' | 'permissionKeys'>,
  memberships: ReadonlyArray<LiveOrgMembership>,
): Map<string, OrgCeilingTerm> {
  const out = new Map<string, OrgCeilingTerm>();
  for (const m of memberships) {
    if (!ceiling.orgIds.has(m.orgId)) continue;
    const prior = out.get(m.orgId);
    out.set(m.orgId, {
      permissionKeys: intersectPermissionKeys(prior?.permissionKeys ?? ceiling.permissionKeys, m.permissionKeys),
      siteIds: intersectSiteAllowlists(prior ? prior.siteIds : ceiling.siteIds, m.siteIds),
    });
  }
  return out;
}

/** Both agent deny registries — the floor every ceiling carries. */
export function agentDeniedToolNames(): string[] {
  return [...AGENT_HUMAN_ONLY_TOOLS, ...AGENT_DENIED_READ_TOOLS.keys()];
}

// ---------------------------------------------------------------------------
// Live human term
// ---------------------------------------------------------------------------

/**
 * Run in system scope, reusing an ambient SYSTEM context (admission and the
 * coordinator already hold one) rather than taking a second pooled connection;
 * from a request context, exit it first (a nested system wrapper would keep the
 * narrower context).
 */
export function inSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * The grantor's LIVE authority inside `partnerId`, read in system context
 * (no ambient request context is required or used). `ok: false` when the user
 * is missing / not `active` (suspended), no longer a member of the partner, no
 * longer holds `ai_sessions:use`, or reaches zero orgs (access lost). Orgs
 * where the grantor's `organization_users` role lacks `ai_sessions:use` do not
 * count as reached; the other memberships come back as `orgMemberships`.
 */
export async function computeLiveHumanTerm(userId: string, partnerId: string): Promise<LiveHumanTerm> {
  // Lazy: run admission, the run loop and release import this module, and the
  // permission resolver / auth middleware graphs are not theirs to load.
  const [{ getUserPermissions }, { computeAccessibleOrgIds }, { notHiddenOrgType }] = await Promise.all([
    import('../permissions'),
    import('../../middleware/auth'),
    import('../unassignedPool/visibility'),
  ]);
  // One system transaction for the whole term: getUserPermissions and
  // computeAccessibleOrgIds both reuse an ambient system context.
  return inSystemContext(async () => {
    const [user] = await db
      .select({ status: users.status, partnerId: users.partnerId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.status !== 'active') return { ok: false, reason: 'grantor_suspended' };
    if (user.partnerId !== partnerId) return { ok: false, reason: 'grantor_access_lost' };

    const perms = await getUserPermissions(userId, { partnerId, scope: 'partner' }, { bypassCache: true });
    if (!perms || perms.scope !== 'partner') return { ok: false, reason: 'grantor_access_lost' };
    if (!keyMatches(perms.permissions.map((p) => `${p.resource}:${p.action}`), 'ai_sessions', 'use')) {
      return { ok: false, reason: 'grantor_access_lost' };
    }

    const reach = await computeAccessibleOrgIds('partner', partnerId, null, userId);
    const reachable = reach.orgIds ?? [];
    // computeAccessibleOrgIds always grants the partner's hidden Quick Support
    // org (it holds only ad-hoc support sessions with outsiders' devices). Hidden
    // orgs (Quick Support, the holding org) are never delegable to Wisp, and must
    // not keep a grantor whose real reach shrank to nothing looking "ok". This
    // only NARROWS the ceiling; it selects no targets.
    const orgIds = reachable.length === 0 ? [] : (await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(inArray(organizations.id, reachable), notHiddenOrgType()))
      .limit(reachable.length))
      .map((o) => o.id);
    if (orgIds.length === 0) return { ok: false, reason: 'grantor_access_lost' };

    // Org-axis precedence: where the grantor holds an org membership, that
    // role governs. An org whose role cannot use AI leaves the term.
    const memberships = await readOrgMemberships(userId, orgIds);
    const noAi = new Set(memberships.filter((m) => !keyMatches(m.permissionKeys, 'ai_sessions', 'use')).map((m) => m.orgId));
    const usableOrgIds = [...new Set(orgIds)].filter((id) => !noAi.has(id));
    if (usableOrgIds.length === 0) return { ok: false, reason: 'grantor_access_lost' };

    const partnerOrgAccess = reach.partnerOrgAccess ?? 'none';
    return {
      ok: true,
      permissionKeys: sortedUnique(perms.permissions.map((p) => `${p.resource}:${p.action}`)),
      orgIds: usableOrgIds,
      siteIds: perms.allowedSiteIds ? [...new Set(perms.allowedSiteIds)] : null,
      // An org carved out above means the grantor no longer reaches the whole
      // partner, so partner-level (cross-org) subjects must close.
      partnerOrgAccess: partnerOrgAccess === 'all' && noAi.size > 0 ? 'selected' : partnerOrgAccess,
      orgMemberships: memberships.filter((m) => !noAi.has(m.orgId)),
    };
  });
}

/** `site_ids` as the resolver reads it: NULL = unrestricted, an array as-is, anything else fails closed to none. */
function normalizeMembershipSites(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  return Array.isArray(raw) ? [...new Set(raw as string[])] : [];
}

/**
 * The grantor's `organization_users` rows for `orgIds`, with their role keys
 * (the role → permissions read of permissions.ts buildPerms, batched). The
 * table has no (org_id, user_id) unique key; the resolver would pick one row
 * arbitrarily, so several rows for one org INTERSECT here (fail closed).
 * Must run inside the caller's system context.
 */
async function readOrgMemberships(userId: string, orgIds: string[]): Promise<LiveOrgMembership[]> {
  const rows = await db
    .select({ orgId: organizationUsers.orgId, roleId: organizationUsers.roleId, siteIds: organizationUsers.siteIds })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.userId, userId), inArray(organizationUsers.orgId, orgIds)));
  // A row without a role is "nothing on this axis" to the resolver (it falls
  // through to the partner role); mirror that.
  const withRole = rows.filter((r) => typeof r.roleId === 'string' && r.roleId.length > 0);
  if (withRole.length === 0) return [];

  const roleIds = [...new Set(withRole.map((r) => r.roleId))];
  const rolePerms = await db
    .select({ roleId: rolePermissions.roleId, resource: permissions.resource, action: permissions.action })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(inArray(rolePermissions.roleId, roleIds));
  const keysByRole = new Map<string, string[]>();
  for (const p of rolePerms) {
    const keys = keysByRole.get(p.roleId) ?? [];
    keys.push(`${p.resource}:${p.action}`);
    keysByRole.set(p.roleId, keys);
  }

  const byOrg = new Map<string, LiveOrgMembership>();
  for (const r of withRole) {
    const keys = sortedUnique(keysByRole.get(r.roleId) ?? []);
    const siteIds = normalizeMembershipSites(r.siteIds);
    const prior = byOrg.get(r.orgId);
    if (!prior) {
      byOrg.set(r.orgId, { orgId: r.orgId, permissionKeys: keys, siteIds });
      continue;
    }
    const sites = intersectSiteAllowlists(prior.siteIds, siteIds);
    byOrg.set(r.orgId, {
      orgId: r.orgId,
      permissionKeys: sortedUnique(intersectPermissionKeys(prior.permissionKeys, keys)),
      siteIds: sites === null ? null : [...sites],
    });
  }
  return [...byOrg.values()];
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/** jsonb has no compile-time shape: a snapshot that does not parse fails closed. */
export const wispCeilingSnapshotSchema = z.object({
  version: z.literal(1),
  permissionKeys: z.array(z.string()),
  orgIds: z.array(z.string()),
  siteIds: z.array(z.string()).nullable(),
  toolAllowlist: z.array(z.string()).nullable(),
  deniedTools: z.array(z.string()),
  partnerWide: z.boolean().optional(),
});

/**
 * The live ceiling of the pinned (grant, revision) pair. Throws
 * GrantInactiveError when the grant is missing, not `active`, past
 * `expires_at`, the revision is not this grant's, the snapshot is malformed,
 * or the grantor's live term fails (the reconciler persists that pause; this
 * function fails closed without writing).
 */
export async function resolveGrantCeiling(grantId: string, revisionId: string): Promise<GrantCeiling> {
  // Deployment switch: with Wisp off nothing runs under a grant, including
  // work admitted before the flag flipped. Runs and releases treat it as a
  // pause (kind 'paused'); an Operator task reaching its requester gate is
  // handed off, as for any inactive grant.
  if (!wispEnabled()) throw new GrantInactiveError(grantId, 'paused', 'Wisp is disabled on this deployment', 'paused');
  const { grant, revision } = await inSystemContext(async () => {
      const [g] = await db
        .select({
          id: wispGrants.id,
          partnerId: wispGrants.partnerId,
          orgId: wispGrants.orgId,
          grantorUserId: wispGrants.grantorUserId,
          status: wispGrants.status,
          expiresAt: wispGrants.expiresAt,
        })
        .from(wispGrants)
        .where(eq(wispGrants.id, grantId))
        .limit(1);
      const [r] = await db
        .select({ id: wispGrantRevisions.id, grantId: wispGrantRevisions.grantId, ceilingSnapshot: wispGrantRevisions.ceilingSnapshot })
        .from(wispGrantRevisions)
        .where(and(eq(wispGrantRevisions.id, revisionId), eq(wispGrantRevisions.grantId, grantId)))
        .limit(1);
      return { grant: g, revision: r };
  });

  if (!grant) throw new GrantInactiveError(grantId, 'revoked', 'grant not found', 'ended');
  if (!revision || revision.grantId !== grantId) {
    throw new GrantInactiveError(grantId, grant.status, `revision ${revisionId} does not belong to this grant`, 'corrupt');
  }
  if (grant.status !== 'active') throw new GrantInactiveError(grantId, grant.status);
  if (!(grant.expiresAt instanceof Date) || grant.expiresAt.getTime() <= Date.now()) {
    throw new GrantInactiveError(grantId, 'expired');
  }
  const parsed = wispCeilingSnapshotSchema.safeParse(revision.ceilingSnapshot);
  if (!parsed.success) throw new GrantInactiveError(grantId, grant.status, 'malformed ceiling snapshot', 'corrupt');
  const snapshot = parsed.data as WispCeilingSnapshot;

  const live = await computeLiveHumanTerm(grant.grantorUserId, grant.partnerId);
  if (!live.ok) throw new GrantInactiveError(grantId, 'paused', live.reason);

  const reach = intersectSnapshotWithLive(snapshot, live);
  const scopeOrgId = grant.orgId ?? null;
  // An org-scoped grant is clamped to its scope org whatever the snapshot says.
  const orgIds = scopeOrgId === null
    ? reach.orgIds
    : new Set([...reach.orgIds].filter((id) => id === scopeOrgId));
  // Zero orgs left = the grantor lost access to everything the grant covers.
  // Fail closed; the reconciler persists the pause (grantor_access_lost).
  if (orgIds.size === 0) throw new GrantInactiveError(grantId, 'paused', 'grantor_access_lost');

  return {
    grantId,
    revisionId,
    partnerId: grant.partnerId,
    grantorUserId: grant.grantorUserId,
    scopeOrgId,
    // Pinned AND live: a grantor widened to org_access 'all' after the revision
    // was taken needs a refresh before partner-level subjects open (§4.4).
    partnerWide: scopeOrgId === null && snapshot.partnerWide === true && live.partnerOrgAccess === 'all',
    ...reach,
    orgIds,
    toolAllowlist: snapshot.toolAllowlist === null ? null : new Set(snapshot.toolAllowlist),
    deniedTools: new Set([...snapshot.deniedTools, ...agentDeniedToolNames()]),
    orgTerms: buildOrgTerms({ ...reach, orgIds }, live.orgMemberships),
    status: 'active',
  };
}
