/**
 * `manage_device_links` (full-control W13, #6783, PR A): the AI twin of the
 * device link-group routes (routes/devices/links.ts, #2138 / #2308) — device
 * records marked as boot profiles of one machine (`multiboot`) or a host and
 * its guests (`vm_host`). Every action runs the route's own logic in
 * `services/deviceLinkGroupOps.ts` (moved verbatim, W13-D3) and the route's own
 * zod body schemas.
 *
 *  - list / get / for_device (t1); create / update / dissolve (t2: rendering
 *    only, non-destructive, undone by linking again). dissolve needs
 *    devices:delete like the DELETE route.
 *  - Site axis: the service's own (`loadMembers` hides out-of-site members; the
 *    mutation lock re-authorizes every member's site).
 *  - Exact-device axis (W13-D12, quorum QW5): a session bound to specific
 *    devices may not change link groups at all (a write touches every member,
 *    including collateral dissolution below two members), and its reads only
 *    show members inside its allowlist.
 *  - `device_link_groups.created_by` is a `users` FK: a verified user or NULL
 *    (W13-D5). Every write's REST twin carries `requireMfa()` (W13-D6).
 */
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { verifyDeviceAccess } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import {
  createLinkGroup, dissolveLinkGroup, getDeviceLinkGroup, getLinkGroup, listLinkGroups, updateLinkGroup,
  type CheckDevice, type LinkGroupOpResult,
} from './deviceLinkGroupOps';
import { createLinkGroupSchema, updateLinkGroupSchema } from '../routes/devices/schemas';
import { ensureOrgAccess } from '../routes/devices/helpers';
import { captureException } from './sentry';
import { DEVICE_LINK_ACTIONS, LINK_GROUP_KIND_VALUES } from './aiToolSchemasDeviceOps';
import { auditToolWrite, bounded, jsonError, thrown, verifiedUserIdOrNull } from './aiToolsSoftwareShared';

type Action = (typeof DEVICE_LINK_ACTIONS)[number];

/** Most link groups an org list returns; the REST list is unpaged. */
export const MAX_LINK_GROUPS_LISTED = 100;

const MEMBER_FIELDS = ['deviceId', 'hostname', 'displayName', 'osType', 'status', 'lastSeenAt', 'role'] as const;

function projectGroup(group: unknown, auth: AuthContext): Record<string, unknown> | null {
  if (!group || typeof group !== 'object') return null;
  const g = group as Record<string, unknown>;
  const allowed = auth.allowedDeviceIds ? new Set(auth.allowedDeviceIds) : null;
  const members = (Array.isArray(g.members) ? g.members : [])
    .filter((m) => !allowed || allowed.has(String((m as Record<string, unknown>).deviceId)))
    .map((m) => {
      const row = m as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of MEMBER_FIELDS) if (key in row) out[key] = row[key];
      return out;
    });
  // A device-bound session never learns of a group none of whose members it may see.
  if (allowed && members.length === 0) return null;
  return { id: g.id, orgId: g.orgId, kind: g.kind, name: g.name ?? null, members };
}

function toolResult(result: LinkGroupOpResult, project: (body: Record<string, unknown>) => unknown): string {
  if (result.status >= 200 && result.status < 300) return bounded(project(result.body));
  const message = typeof result.body.error === 'string' ? result.body.error : `Request failed (${result.status})`;
  const code = result.status === 404 ? 'NOT_FOUND' : result.status === 403 ? 'ACCESS_DENIED'
    : result.status === 409 ? 'CONFLICT' : result.status === 400 ? 'VALIDATION_ERROR' : 'FAILED';
  return jsonError(message, code);
}

export function registerDeviceLinkTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_device_links', {
    tier: 1,
    domain: 'devices',
    searchHint: 'linked device profiles: multi-boot records of one machine, or a VM host and its guests',
    deviceArgs: ['deviceId', 'deviceIds', 'hostDeviceId', 'addDeviceIds', 'removeDeviceIds'],
    definition: {
      name: 'manage_device_links',
      description: 'Actions: list, get, for_device, create, update, dissolve. Links 2-10 device records as boot profiles of one machine (multiboot) or a vm_host with hostDeviceId. Members keep their data.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...DEVICE_LINK_ACTIONS], description: 'The action to perform' },
          groupId: { type: 'string', description: 'get / update / dissolve: link group UUID' },
          deviceId: { type: 'string', description: 'for_device: device UUID' },
          kind: { type: 'string', enum: [...LINK_GROUP_KIND_VALUES], description: 'create: multiboot (default) or vm_host' },
          name: { type: ['string', 'null'], description: 'create / update: label (null clears on update)' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'create: 2-10 device UUIDs of one org' },
          hostDeviceId: { type: 'string', description: 'create vm_host: the host device (one of deviceIds)' },
          addDeviceIds: { type: 'array', items: { type: 'string' }, description: 'update: devices to add' },
          removeDeviceIds: { type: 'array', items: { type: 'string' }, description: 'update: devices to remove' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!DEVICE_LINK_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const isWrite = action === 'create' || action === 'update' || action === 'dissolve';
      if (isWrite) {
        const mfa = mfaGatedToolError('manage_device_links', action, auth);
        if (mfa) return mfa;
        if (auth.allowedDeviceIds !== undefined) {
          return jsonError('A session bound to specific devices cannot change link groups (a change touches every member)', 'ACCESS_DENIED');
        }
      }
      const checkDevice: CheckDevice = async (id) => {
        const access = await verifyDeviceAccess(id, auth);
        return 'error' in access ? null : access.device;
      };
      const hasOrgAccess = async (orgId: string) => ensureOrgAccess(orgId, auth);
      const audit = (event: RouteAuditInput) => auditToolWrite(auth, {
        orgId: event.orgId ?? null,
        action: event.action,
        resourceType: event.resourceType,
        ...(event.resourceId ? { resourceId: event.resourceId } : {}),
        ...(event.resourceName ? { resourceName: event.resourceName } : {}),
        ...(event.details ? { details: event.details } : {}),
      });
      const deps = { auth, audit, checkDevice, hasOrgAccess };
      const groupOf = (body: Record<string, unknown>) => ({ group: projectGroup(body, auth) });
      try {
        if (action === 'list') {
          return toolResult(await listLinkGroups(deps), (body) => {
            const groups = (Array.isArray(body.data) ? body.data : [])
              .map((g) => projectGroup(g, auth))
              .filter((g): g is Record<string, unknown> => g !== null);
            return {
              groups: groups.slice(0, MAX_LINK_GROUPS_LISTED),
              total: groups.length,
              ...(groups.length > MAX_LINK_GROUPS_LISTED ? { truncated: true } : {}),
            };
          });
        }
        if (action === 'for_device') {
          if (typeof input.deviceId !== 'string') return jsonError('deviceId is required', 'VALIDATION_ERROR');
          let dangling = false;
          const result = await getDeviceLinkGroup({
            auth, checkDevice,
            // The route's loud-failure path (Sentry); the model is told, never shown "not linked".
            reportDanglingReference: (err) => { dangling = true; captureException(err); },
          }, input.deviceId);
          if (dangling) {
            return jsonError('This device points at a link group that cannot be read (a data-integrity problem); do not re-link it', 'DATA_INTEGRITY');
          }
          return toolResult(result, (body) => ({
            group: body.group ? projectGroup({ ...(body.group as object), members: body.members }, auth) : null,
          }));
        }
        if (action === 'create') {
          const parsed = createLinkGroupSchema.safeParse({
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(typeof input.name === 'string' ? { name: input.name } : {}),
            deviceIds: input.deviceIds,
            ...(input.hostDeviceId !== undefined ? { hostDeviceId: input.hostDeviceId } : {}),
          });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          const result = await createLinkGroup({ ...deps, actorUserId: await verifiedUserIdOrNull(auth) }, parsed.data);
          return toolResult(result, groupOf);
        }

        if (typeof input.groupId !== 'string') return jsonError('groupId is required', 'VALIDATION_ERROR');
        if (action === 'get') return toolResult(await getLinkGroup(deps, input.groupId), groupOf);
        if (action === 'dissolve') {
          return toolResult(await dissolveLinkGroup(deps, input.groupId), () => ({ dissolved: true, groupId: input.groupId }));
        }
        const parsed = updateLinkGroupSchema.safeParse({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.addDeviceIds !== undefined ? { addDeviceIds: input.addDeviceIds } : {}),
          ...(input.removeDeviceIds !== undefined ? { removeDeviceIds: input.removeDeviceIds } : {}),
        });
        if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
        const groupId = input.groupId;
        // Removing members below two (or a vm_host's host) dissolves the group: say so, never show an empty group.
        return toolResult(await updateLinkGroup(deps, groupId, parsed.data), (body) =>
          body.dissolved === true ? { dissolved: true, groupId } : groupOf(body));
      } catch (error) {
        return thrown('manage_device_links', error);
      }
    },
  });
}
