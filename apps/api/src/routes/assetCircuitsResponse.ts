/**
 * Shared response builder for GET /devices/:id/circuits and
 * GET /discovery/assets/:id/circuits. The route modules only resolve the subject;
 * capabilities, scope and the response contract are assembled here, once.
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md §8, §9.1
 */

import type { Context } from 'hono';
import type { AuthContext } from '../middleware/auth';
import { listAssetCircuitDtos, type AssetCircuitSubject } from '../services/circuitAssetView';
import { requireTopologySiteAccess, TopologyError } from '../services/topology/access';
import { resolveCallerPermissions, resolveCallerSiteScope } from './sitePermissionScope';

export async function respondAssetCircuits(c: Context, subject: AssetCircuitSubject) {
  const auth = c.get('auth') as AuthContext;
  const permissions = await resolveCallerPermissions(c);

  const can = async (capability: 'read' | 'write'): Promise<boolean> => {
    try {
      await requireTopologySiteAccess(auth, permissions, subject.siteId, capability);
      return true;
    } catch (err) {
      if (err instanceof TopologyError) return false;
      throw err;
    }
  };
  const interfacesVisible = await can('read');
  const wanRoleWritable = await can('write');
  const scope = await resolveCallerSiteScope(c);

  const view = await listAssetCircuitDtos(subject, {
    scope,
    canAccessOrg: (orgId) => auth.canAccessOrg(orgId),
    includeInterfaces: interfacesVisible,
  });

  return c.json({
    subject: { kind: subject.kind, id: subject.id, orgId: subject.orgId, siteId: subject.siteId },
    topology: { bound: view.bound },
    capabilities: { interfacesVisible, wanRoleWritable },
    interfaces: interfacesVisible ? view.interfaces : [],
    interfacesTruncated: interfacesVisible ? view.interfacesTruncated : false,
    circuits: view.circuits,
  });
}
