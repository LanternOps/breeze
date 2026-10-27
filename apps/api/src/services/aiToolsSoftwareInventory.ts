/**
 * `manage_software_inventory` (full-control W12, #6782): the AI twin of
 * /software-inventory.
 *
 *  - `list` / `names` / `devices` (t1): software seen across the fleet (with
 *    its allow/block badge), a name search, and the devices that have one
 *    package. The route's own queries (services/softwareInventoryPolicy.ts),
 *    site-filtered; refused to a session bound to exact devices.
 *  - `approve` / `deny` / `clear` (supervised): add to, or remove from, the
 *    org's REST-managed `Default Allowlist` / `Default Blocklist`. With an
 *    enforcing default policy these change what auto-uninstall acts on (plan
 *    fact 5). The tool refuses to adopt a same-named default configuration
 *    policy that carries other settings (quorum QW7), records the acting user
 *    only when it is a `users` row (W12-D3, QW4), and refuses site- or
 *    device-restricted sessions (REST parity: `canMutateOrgWideGovernance`).
 *
 * Approve/deny keep any entry in the opposite list; clear removes from both,
 * so they are not exact inverses (QW8). No partner-wide row is ever written
 * (W12-D9): partner-wide allowlists stay with `manage_software_policy`.
 */
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { isHoldingOrg } from './unassignedPool/protectedOrg';
import {
  approveInventorySoftware, clearInventorySoftware, denyInventorySoftware, listInventory, listInventoryDevices,
  searchInventoryNames,
} from './softwareInventoryPolicy';
import { SOFTWARE_INVENTORY_ACTIONS } from './aiToolSchemasSoftware';
import { resolveWritableToolOrgId } from './aiToolWriteOrg';
import {
  auditToolWrite, bounded, clampLimit, clampOffset, deviceBoundDenied, httpResult, jsonError, notFound, orgWideWriteDenied, requireFields, str,
  thrown, verifiedUserIdOrNull,
} from './aiToolsSoftwareShared';

type Action = (typeof SOFTWARE_INVENTORY_ACTIONS)[number];
const TOOL = 'manage_software_inventory';

/** The site axis the route's readers apply (`perms.allowedSiteIds`); the exact-device axis is refused before. */
function readScope(auth: AuthContext): { allowedSiteIds?: string[] } | undefined {
  return auth.allowedSiteIds !== undefined ? { allowedSiteIds: [...auth.allowedSiteIds] } : undefined;
}

export function registerSoftwareInventoryTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'patching',
    searchHint: 'software seen across the fleet; approve or block an application for an organization',
    definition: {
      name: TOOL,
      description: 'Fleet software inventory. list (with allow/block status), names (search), devices (who has softwareName); approve/deny add to the org default allow/blocklist, clear removes. Writes need approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SOFTWARE_INVENTORY_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (required for writes in partner scope)' },
          search: { type: 'string', description: 'list: name filter' },
          vendor: { type: 'string', description: 'list/devices filter; approve/deny/clear: vendor of softwareName' },
          softwareName: { type: 'string', description: 'devices/approve/deny/clear: exact software name' },
          query: { type: 'string', description: 'names: search text' },
          sortBy: { type: 'string', enum: ['name', 'vendor', 'deviceCount', 'lastSeen'], description: 'list sort' },
          sortOrder: { type: 'string', enum: ['asc', 'desc'], description: 'list sort order' },
          limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
          offset: { type: 'number', description: 'Rows to skip' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SOFTWARE_INVENTORY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;

      try {
        if (action === 'list' || action === 'names' || action === 'devices') {
          // The readers apply the site axis only; a session bound to exact devices gets no fleet-wide inventory.
          const deviceBound = deviceBoundDenied(auth, 'The fleet software inventory');
          if (deviceBound) return deviceBound;
          const orgId = str(input.orgId);
          if (orgId && !auth.canAccessOrg(orgId)) return notFound('Organization');
          const scope = readScope(auth);
          const limit = clampLimit(input.limit, 50, action === 'names' ? 50 : 200);
          if (action === 'list') {
            return bounded(await listInventory({
              auth, perms: scope, orgId,
              search: str(input.search), vendor: str(input.vendor),
              sortBy: (input.sortBy as 'name' | 'vendor' | 'deviceCount' | 'lastSeen' | undefined) ?? 'deviceCount',
              sortOrder: (input.sortOrder as 'asc' | 'desc' | undefined) ?? 'desc',
              limit, offset: clampOffset(input.offset),
            }));
          }
          if (action === 'names') {
            const missing = requireFields(input, ['query'], action);
            if (missing) return missing;
            return bounded(await searchInventoryNames({ auth, perms: scope, orgId, q: String(input.query).trim(), limit }));
          }
          const missing = requireFields(input, ['softwareName'], action);
          if (missing) return missing;
          return bounded(await listInventoryDevices({
            auth, perms: scope, orgId, softwareName: String(input.softwareName), vendor: str(input.vendor),
            limit, offset: clampOffset(input.offset),
          }));
        }

        // approve / deny / clear
        const denied = orgWideWriteDenied(auth, 'The default software allowlist and blocklist');
        if (denied) return denied;
        const missing = requireFields(input, ['softwareName'], action);
        if (missing) return missing;
        const resolved = resolveWritableToolOrgId(auth, str(input.orgId));
        if (resolved.error || !resolved.orgId) return jsonError(resolved.error ?? 'orgId is required', 'VALIDATION_ERROR');
        const orgId = resolved.orgId;
        if (await isHoldingOrg(orgId)) return jsonError('This organization is protected and cannot be changed', 'ACCESS_DENIED');
        const softwareName = String(input.softwareName);
        const vendor = str(input.vendor);
        const actorUserId = await verifiedUserIdOrNull(auth);
        const audit = (event: RouteAuditInput) => auditToolWrite(auth, {
          orgId, action: event.action, resourceType: event.resourceType,
          ...(event.resourceId ? { resourceId: event.resourceId } : {}),
          ...(event.resourceName ? { resourceName: event.resourceName } : {}),
          ...(event.details ? { details: event.details } : {}),
        });
        const params = { auth, orgId, softwareName, vendor, actorUserId, audit, actor: 'ai' as const, refuseForeignConfigLink: true };
        const result = action === 'approve'
          ? await approveInventorySoftware(params)
          : action === 'deny'
            ? await denyInventorySoftware(params)
            : await clearInventorySoftware(params);
        return httpResult(result);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
