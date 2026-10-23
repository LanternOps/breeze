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
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users, wispGrantRevisions, wispGrants } from '../../db/schema';
import type { WispCeilingSnapshot, WispGrantStatus } from '../../db/schema/wisp';
import { computeAccessibleOrgIds } from '../../middleware/auth';
import { AGENT_DENIED_READ_TOOLS, AGENT_HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import { permissionGrantMatches } from '../permissionMatching';
import { getUserPermissions } from '../permissions';

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
  status: WispGrantStatus;
};

export type CeilingCheck = {
  toolName?: string;
  /** `${resource}:${action}` */
  permission?: string;
  /** undefined = no org term; null = a partner-level subject (allowed only for a partner-wide grant). */
  orgId?: string | null;
  siteId?: string | null;
};

export type CeilingViolationCode = 'org' | 'site' | 'permission' | 'tool' | 'inactive';

/** The grant cannot be used right now (paused / revoked / expired / missing / grantor lost standing). */
export class GrantInactiveError extends Error {
  readonly code = 'grant_inactive' as const;
  constructor(
    public readonly grantId: string,
    public readonly status: WispGrantStatus,
    detail?: string,
  ) {
    super(`Wisp grant ${grantId} is not active (${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'GrantInactiveError';
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
  | { ok: true; permissionKeys: string[]; orgIds: string[]; siteIds: string[] | null; partnerOrgAccess: 'all' | 'selected' | 'none' }
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
    if (ceiling.deniedTools.has(check.toolName)) {
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

  if (ceiling.siteIds !== null && (check.orgId !== undefined || check.siteId !== undefined)) {
    // An unknown site never widens a site-restricted ceiling.
    if (check.siteId == null || !ceiling.siteIds.has(check.siteId)) {
      throw new CeilingViolationError('site', `site ${check.siteId ?? '(unknown)'} is outside the delegation ceiling`);
    }
  }

  if (check.permission !== undefined) {
    const required = parsePermissionKey(check.permission);
    if (!required || !keyMatches(ceiling.permissionKeys, required.resource, required.action)) {
      throw new CeilingViolationError('permission', `permission ${check.permission} is outside the delegation ceiling`);
    }
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

/** Both agent deny registries — the floor every ceiling carries. */
export function agentDeniedToolNames(): string[] {
  return [...AGENT_HUMAN_ONLY_TOOLS, ...AGENT_DENIED_READ_TOOLS.keys()];
}

// ---------------------------------------------------------------------------
// Live human term
// ---------------------------------------------------------------------------

/**
 * The grantor's LIVE authority inside `partnerId`, read in system context
 * (no ambient request context is required or used). `ok: false` when the user
 * is missing / not `active` (suspended), no longer a member of the partner, no
 * longer holds `ai_sessions:use`, or reaches zero orgs (access lost).
 */
export async function computeLiveHumanTerm(userId: string, partnerId: string): Promise<LiveHumanTerm> {
  return runOutsideDbContext(async () => {
    const [user] = await withSystemDbAccessContext(() =>
      db
        .select({ status: users.status, partnerId: users.partnerId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    if (!user || user.status !== 'active') return { ok: false, reason: 'grantor_suspended' };
    if (user.partnerId !== partnerId) return { ok: false, reason: 'grantor_access_lost' };

    const perms = await getUserPermissions(userId, { partnerId, scope: 'partner' }, { bypassCache: true });
    if (!perms || perms.scope !== 'partner') return { ok: false, reason: 'grantor_access_lost' };
    if (!keyMatches(perms.permissions.map((p) => `${p.resource}:${p.action}`), 'ai_sessions', 'use')) {
      return { ok: false, reason: 'grantor_access_lost' };
    }

    const reach = await computeAccessibleOrgIds('partner', partnerId, null, userId);
    const orgIds = reach.orgIds ?? [];
    if (orgIds.length === 0) return { ok: false, reason: 'grantor_access_lost' };

    return {
      ok: true,
      permissionKeys: sortedUnique(perms.permissions.map((p) => `${p.resource}:${p.action}`)),
      orgIds: [...new Set(orgIds)],
      siteIds: perms.allowedSiteIds ? [...new Set(perms.allowedSiteIds)] : null,
      partnerOrgAccess: reach.partnerOrgAccess ?? 'none',
    };
  });
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
});

/**
 * The live ceiling of the pinned (grant, revision) pair. Throws
 * GrantInactiveError when the grant is missing, not `active`, past
 * `expires_at`, the revision is not this grant's, the snapshot is malformed,
 * or the grantor's live term fails (the reconciler persists that pause; this
 * function fails closed without writing).
 */
export async function resolveGrantCeiling(grantId: string, revisionId: string): Promise<GrantCeiling> {
  const { grant, revision } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
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
    }),
  );

  if (!grant) throw new GrantInactiveError(grantId, 'revoked', 'grant not found');
  if (!revision || revision.grantId !== grantId) {
    throw new GrantInactiveError(grantId, grant.status, `revision ${revisionId} does not belong to this grant`);
  }
  if (grant.status !== 'active') throw new GrantInactiveError(grantId, grant.status);
  if (!(grant.expiresAt instanceof Date) || grant.expiresAt.getTime() <= Date.now()) {
    throw new GrantInactiveError(grantId, 'expired');
  }
  const parsed = wispCeilingSnapshotSchema.safeParse(revision.ceilingSnapshot);
  if (!parsed.success) throw new GrantInactiveError(grantId, grant.status, 'malformed ceiling snapshot');
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
    partnerWide: scopeOrgId === null && live.partnerOrgAccess === 'all',
    ...reach,
    orgIds,
    toolAllowlist: snapshot.toolAllowlist === null ? null : new Set(snapshot.toolAllowlist),
    deniedTools: new Set([...snapshot.deniedTools, ...agentDeniedToolNames()]),
    status: 'active',
  };
}
