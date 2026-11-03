/**
 * Wisp W08 (feature #9906; w00 A35, Review Focus 1–3) — `resolveEntityRef`:
 * the ONE path from a `(kind, id)` link to "may this caller, under this
 * grant, see this object right now — and what is it?".
 *
 * Every read of a thread link (the links route, `GET /wisp/home`, the session
 * seed, `list_links`) and every add (`POST …/links`, `link_entity`) goes
 * through it. The stored label is a cache and the stored org is never trusted:
 *
 *   1. read the entity inside the grant's partner (`loadEntityForPartner`) —
 *      missing / deleted / hidden org / another partner's → `not_found`;
 *   2. take the org FROM THE ENTITY (`organization` ⇒ its own id; `user` ⇒
 *      null, partner-level);
 *   3. the caller's own authority: the kind's read permission, org reach
 *      (`canAccessOrg`) and site reach (`canAccessSite`) → `forbidden`;
 *   4. the grant's LIVE ceiling (`assertWithinCeiling` with the entity's org,
 *      site and the read permission; a partner-level entity needs a
 *      partner-wide grant held with full org access) → `outside_ceiling`;
 *   5. the current token: an organization-scoped token resolves only its own
 *      org and never a partner-level entity → `outside_token_scope`.
 *
 * Plain chat uses `resolveEntityForCaller`: the same checks in the caller's
 * own partner, without step 4. A caller without a partner resolves nothing.
 *
 * Refusals carry no data. Callers decide what a refusal does to a stored row
 * (threadLinks: `not_found` deletes, the rest are kept and hidden — the grant
 * or the role may widen again).
 */
import {
  wispEntityHref,
  WISP_LINK_LABEL_MAX,
  type BreezeEntityRef,
  type WispEntityKind,
} from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions, hasPermission } from '../permissions';
import { loadEntityForPartner } from './entityLoaders';
import { assertWithinCeiling, CeilingViolationError, type GrantCeiling } from './grantAuthority';

export type ResolvedEntity = {
  ref: BreezeEntityRef;
  orgId: string | null;
  label: string;
  status: string | null;
  href: string;
};
export type ResolveFailureReason = 'not_found' | 'forbidden' | 'outside_ceiling' | 'outside_token_scope';
export type ResolveFailure = { reason: ResolveFailureReason };
/**
 * `auth` is the caller's request/chat auth. It is absent only on paths with no
 * caller (the session seed built for a new chat turn): there the ceiling alone
 * decides — its permission and org sets are the grantor's LIVE authority
 * (`computeLiveHumanTerm`) ∩ the snapshot — and there is no token to scope.
 */
export type EntityResolveContext = { auth?: AuthContext | null; ceiling: GrantCeiling };

/** The permission a person needs to open each kind's own page. */
export const ENTITY_READ_PERMISSION: Readonly<Record<WispEntityKind, `${string}:read`>> = Object.freeze({
  ticket: 'tickets:read',
  quote: 'quotes:read',
  invoice: 'invoices:read',
  contract: 'contracts:read',
  device: 'devices:read',
  organization: 'organizations:read',
  site: 'sites:read',
  alert: 'alerts:read',
  run: 'ai_agents:read',
  task: 'ai_agents:read',
  user: 'users:read',
});

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResolveFailure(r: ResolvedEntity | ResolveFailure): r is ResolveFailure {
  return 'reason' in r;
}

/** Collapse whitespace and cap at WISP_LINK_LABEL_MAX code points (the DB CHECK is char_length). */
export function capLabel(raw: string, fallback: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat || fallback);
  return cps.length > WISP_LINK_LABEL_MAX ? cps.slice(0, WISP_LINK_LABEL_MAX).join('') : cps.join('');
}

/**
 * A resolver bound to one caller + ceiling. The caller's permission set is
 * read once and reused across every ref (a home render resolves up to 50).
 */
export function createEntityResolver(ctx: EntityResolveContext) {
  return createResolver(ctx);
}

/** One-off plain-chat resolve, using only the caller's own authority. */
export function resolveEntityForCaller(
  auth: AuthContext,
  ref: { kind: WispEntityKind; id: string },
): Promise<ResolvedEntity | ResolveFailure> {
  return createResolver({ auth })(ref);
}

/** Shared ordered checks; a grant-bound resolver also applies step 4. */
function createResolver({ auth, ceiling }:
  | { auth: AuthContext; ceiling?: GrantCeiling }
  | EntityResolveContext,
) {
  if (!auth && !ceiling) throw new Error('Entity resolution requires caller auth or a grant ceiling');
  const partnerId = ceiling ? ceiling.partnerId : auth?.partnerId ?? null;
  let perms: ReturnType<typeof getUserPermissions> | null = null;
  const permissionsOnce = (auth: AuthContext) => {
    perms ??= getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId ?? undefined,
      orgId: auth.orgId ?? undefined,
      scope: auth.scope,
    });
    return perms;
  };

  return async function resolve(ref: { kind: WispEntityKind; id: string }): Promise<ResolvedEntity | ResolveFailure> {
    if (partnerId === null || !GUID_RE.test(ref.id)) return { reason: 'not_found' };

    // (1) existence inside the selected partner; (2) the org is the entity's.
    const entity = await loadEntityForPartner(ref.kind, ref.id, partnerId);
    if (!entity) return { reason: 'not_found' };
    const orgId = entity.orgId;
    const permission = ENTITY_READ_PERMISSION[ref.kind];

    // (3) the caller's own authority.
    if (auth) {
      const userPerms = await permissionsOnce(auth);
      const [resource, action] = permission.split(':') as [string, string];
      if (!userPerms || !hasPermission(userPerms, resource, action)) return { reason: 'forbidden' };
      if (orgId !== null && !auth.canAccessOrg(orgId)) return { reason: 'forbidden' };
      // A device-pinned principal (a device-bound agent run) reaches only its
      // allowlisted devices — and no other kind, which it cannot be shown to own.
      if (auth.allowedDeviceIds !== undefined && (ref.kind !== 'device' || !auth.allowedDeviceIds.includes(ref.id))) {
        return { reason: 'forbidden' };
      }
      if (entity.siteId !== undefined && auth.canAccessSite && !auth.canAccessSite(entity.siteId)) {
        return { reason: 'forbidden' };
      }
    }

    // (4) the grant's live ceiling, against the entity's own org and site.
    if (ceiling) {
      try {
        assertWithinCeiling(ceiling, { orgId, siteId: entity.siteId, permission });
      } catch (err) {
        if (err instanceof CeilingViolationError) return { reason: 'outside_ceiling' };
        throw err;
      }
    }

    // (5) the current token's reach.
    if (auth?.scope === 'organization' && (orgId === null || orgId !== auth.orgId)) {
      return { reason: 'outside_token_scope' };
    }

    return {
      ref: { kind: ref.kind, id: ref.id, orgId },
      orgId,
      label: capLabel(entity.title, ref.kind),
      status: entity.status,
      href: wispEntityHref(ref.kind, ref.id, orgId),
    };
  };
}

/** One-off resolve (a single add). Many refs → `createEntityResolver`. */
export function resolveEntityRef(
  ctx: EntityResolveContext,
  ref: { kind: WispEntityKind; id: string },
): Promise<ResolvedEntity | ResolveFailure> {
  return createEntityResolver(ctx)(ref);
}
