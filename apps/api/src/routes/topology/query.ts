import type { Context } from 'hono';
import { TopologyOperationError } from '../../services/topology/operationErrors';

/**
 * The web client's `fetchWithAuth` appends `?orgId=<ambient org>` to every
 * `/api/v1` request. Site-scoped topology readers resolve their tenant from
 * `:siteId` (`requireTopologySiteCapability`) and parse the raw query through
 * `.strict()` schemas, so the extra key was a hard 400 on every browser call
 * (pass-3 sweep G4-5). The key is redundant when it names the site's own org
 * and is dropped before the strict parse; a DIFFERENT org is still a scope
 * override and stays a 400 — the query must never widen or move the tenant
 * the middleware resolved. The value is discarded either way, so it can never
 * reach a service.
 */
export function siteScopedQuery(
  c: Context,
  reject: (message: string) => Error = (message) => new TopologyOperationError('invalid_topology_query', 400, message),
): Record<string, string> {
  const { orgId, ...query } = c.req.query();
  if (orgId !== undefined && orgId !== c.get('topologyContext')?.scope?.orgId) {
    throw reject('Invalid topology query');
  }
  return query;
}

/**
 * Same tolerance for readers that carry no site scope (template-library
 * routes authorise on the template's own owner, not on a site). The ambient
 * key has nothing to be compared against and is never read, so it is dropped.
 */
export function withoutAmbientOrgId(query: Record<string, string>): Record<string, string> {
  const { orgId: _orgId, ...rest } = query;
  return rest;
}
