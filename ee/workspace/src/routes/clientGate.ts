import type { MiddlewareHandler } from 'hono';
import type { WorkspaceRouteEnv } from './adminGate';

/**
 * The /client/* boundary: the end-user surface the Outlook add-in pane talks
 * to through core's generic client proxy.
 *
 * The proxy authenticates the pane's user via the client-ai Entra exchange and
 * synthesizes an ORGANIZATION-scoped auth context — `{ user, scope:
 * 'organization', orgId, partnerId: undefined, accessibleOrgIds: [orgId] }` —
 * before dispatching here.
 *
 * This is deliberately the INVERSE of `adminGate`, and the difference is the
 * whole point of having two gates:
 *
 *  - adminGate admits partner/system scope and reads the target org from
 *    `?orgId`, because an MSP operator legitimately acts across orgs.
 *  - clientGate admits ONLY organization scope, and takes the org from the
 *    authenticated context — never from the query, the body, or the path. A
 *    partner- or system-scoped principal is rejected here rather than
 *    silently upgraded: these routes file mail on an end user's behalf and
 *    attribute the action to `auth.user.id`, so an operator token must not be
 *    able to drive them.
 *
 * Everything fails closed: no auth var, a non-organization scope, a blank org,
 * or an org outside the caller's own accessible set all answer the same 403.
 */
export const clientGate: MiddlewareHandler<WorkspaceRouteEnv> = async (c, next) => {
  const deny = () => c.json({ error: 'organization access required' }, 403);

  const auth = c.get('auth');
  if (!auth || auth.scope !== 'organization') return deny();

  const orgId = typeof auth.orgId === 'string' ? auth.orgId.trim() : '';
  if (!orgId) return deny();

  // The proxy pins exactly one org and lists it. A pinned org that is not in
  // the caller's own accessible set means the upstream context is inconsistent
  // (or forged) — refuse rather than trust the more permissive half of it.
  // `null` (adminGate's unrestricted sentinel) is never honored on this
  // surface: an end-user session is always explicitly scoped.
  if (!Array.isArray(auth.accessibleOrgIds) || !auth.accessibleOrgIds.includes(orgId)) {
    return deny();
  }

  // Identity is load-bearing here, not decoration: the handlers attribute every
  // filing action to `auth.user.id` in the audit trail, and that is the entire
  // security story of an end-user surface. `user` is typed non-optional, but a
  // synthesized or partial context would otherwise either throw a TypeError
  // (500) or — worse — file the email successfully and write `actorId:
  // undefined`. An unattributable actor is denied, not accommodated.
  const userId = (auth.user as { id?: unknown } | undefined)?.id;
  if (typeof userId !== 'string' || userId.trim() === '') return deny();

  c.set('workspaceOrgId', orgId);
  await next();
};
