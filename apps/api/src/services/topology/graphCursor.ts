import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { graphQuerySchema, topologyScopeSchema, type TopologyScope } from '@breeze/shared';
import { getSecretDerivedKeyMaterials } from '../secretCrypto';
import { getPermissionAuthorityVersion, getUserPermissions, hasPermission } from '../permissions';
import { requireTopologySiteAccess, topologyPermissionPairs, type TopologyRequestContext } from './access';

export class GraphReadError extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(message); this.name = 'GraphReadError';
  }
}
export const nodeListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(), kind: z.enum(['endpoint', 'network', 'gateway', 'internet', 'manual']).optional(),
  deviceId: z.string().uuid().optional(), assetId: z.string().uuid().optional(),
  lifecycle: z.enum(['active', 'withdrawn', 'archived']).default('active'),
  health: z.enum(['unknown', 'healthy', 'degraded', 'failed_check']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100), cursor: z.string().max(2048).optional(),
}).strict();
export type NodeListQuery = z.input<typeof nodeListQuerySchema>;
const filterSchema = z.union([graphQuerySchema, nodeListQuerySchema.omit({ cursor: true })]);
const claimsSchema = topologyScopeSchema.extend({
  version: z.literal(1), kind: z.enum(['graph', 'nodes', 'evidence']), authority: z.string().regex(/^[a-f0-9]{64}$/),
  graphRevision: z.string().regex(/^(0|[1-9]\d*)$/), filter: filterSchema,
  after: z.string().uuid().optional(), edgeAfter: z.string().uuid().optional(),
  boundaryAfter: z.string().uuid().optional(), boundaryOnly: z.boolean().optional(),
  relationshipId: z.string().uuid().optional(), expiresAt: z.number().int().nonnegative(),
}).strict();
export type GraphTokenClaims = z.infer<typeof claimsSchema>;
const DOMAIN = 'topology-read-cursor:v1';
const invalidToken = () => new GraphReadError('invalid_topology_cursor', 400, 'Invalid or expired topology cursor');
export function issueGraphToken(claims: Omit<GraphTokenClaims, 'version' | 'expiresAt'>, now = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify(claimsSchema.parse({ ...claims, version: 1, expiresAt: now + 600 }))).toString('base64url');
  const key = getSecretDerivedKeyMaterials(DOMAIN).active.key;
  const signature = createHmac('sha256', key).update(`${DOMAIN}.${body}`).digest('base64url');
  return `${body}.${signature}`;
}
export function verifyGraphToken(token: string, authority: string, scope: TopologyScope, now = Math.floor(Date.now() / 1000)): GraphTokenClaims {
  if (token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) throw invalidToken();
  const [body, signature] = token.split('.') as [string, string];
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== 32 || supplied.toString('base64url') !== signature) throw invalidToken();
  const matches = getSecretDerivedKeyMaterials(DOMAIN).retained.some(({ key }) => {
    const expected = createHmac('sha256', key).update(`${DOMAIN}.${body}`).digest();
    return timingSafeEqual(supplied, expected);
  });
  if (!matches) throw invalidToken();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw invalidToken(); }
  const parsed = claimsSchema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAt <= now) throw invalidToken();
  const claims = parsed.data;
  if (claims.authority !== authority || claims.orgId !== scope.orgId || claims.siteId !== scope.siteId) throw invalidToken();
  return claims;
}
const sorted = (values: string[] | null | undefined) => values == null ? null : [...values].sort();
/** Read live grants as well as shared invalidation generations; never broaden request/API-key ceilings. */
export async function graphAuthority(ctx: TopologyRequestContext) {
  const before = await getPermissionAuthorityVersion(ctx.auth.user.id);
  if (before === null) throw new GraphReadError('topology_authority_unavailable', 503, 'Current permission version is unavailable');
  const current = await getUserPermissions(ctx.auth.user.id, {
    orgId: ctx.auth.orgId ?? undefined, partnerId: ctx.auth.partnerId ?? undefined, scope: ctx.auth.scope,
  }, { bypassCache: true });
  if (!current) throw new GraphReadError('topology_permission_denied', 403, 'Topology permission denied');
  await requireTopologySiteAccess(ctx.auth, current, ctx.scope.siteId, 'read');
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'read');
  const after = await getPermissionAuthorityVersion(ctx.auth.user.id);
  if (after === null || after !== before) throw new GraphReadError('topology_authority_unavailable', 503, 'Permissions changed during the request; retry');
  const digest = createHash('sha256').update(JSON.stringify({
    version: after, actor: ctx.auth.user.id, principal: ctx.auth.principal,
    orgId: ctx.scope.orgId, siteId: ctx.scope.siteId,
    authSites: sorted(ctx.auth.allowedSiteIds), authOrgs: sorted(ctx.auth.accessibleOrgIds),
    permissions: [ctx.permissions, current].map((p) => ({
      grants: p.permissions.map((g) => `${g.resource}:${g.action}`).sort(), role: p.roleId, scope: p.scope,
      orgId: p.orgId, partnerId: p.partnerId, orgAccess: p.orgAccess,
      orgs: sorted(p.allowedOrgIds), sites: sorted(p.allowedSiteIds),
    })),
  })).digest('hex');
  return { digest, canEdit: topologyPermissionPairs('write').every(([r, a]) => hasPermission(current, r, a) && hasPermission(ctx.permissions, r, a)) };
}
/** Weak validator ignores response assembly time; revisions, projection and authority remain included. */
export function topologyReadEtag(authority: string, value: unknown): string {
  return `W/"${createHash('sha256').update(authority).update(JSON.stringify(value)).digest('hex')}"`;
}
