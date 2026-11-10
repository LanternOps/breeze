/**
 * Identity read tools (full-control W18, #6789): `list_users`, `get_user` and
 * `list_roles`. Tier 1 and read-only; W18-1 keeps every user and role write
 * `identity` (human-only, no tool action).
 *
 * Thin adapters over services/userDirectory.ts and services/roleDirectory.ts,
 * whose `*ForCaller` entry points carry the routers' gates: a partner
 * technician without full partner access is refused here exactly as REST
 * refuses them. A session bound to specific devices is refused outright:
 * the directory has no device axis. Headless agents never reach these
 * (`AGENT_DENIED_READ_TOOLS`).
 */
import type { AiTool } from './aiTools';
import { getScopedUserForCaller, listScopedUsersForCaller, type DirectoryRefusal } from './userDirectory';
import {
  getRoleDetailForCaller,
  getRoleEffectivePermissionsForCaller,
  listRoleUsersForCaller,
  listRolesForCaller,
} from './roleDirectory';
import { orgAdminToolSchemas } from './aiToolSchemasOrgAdmin';
import {
  bounded,
  capped,
  deviceBoundDenied,
  jsonError,
  notFound,
  orgAdminInputSchema,
  parseInput,
  thrown,
} from './aiToolsOrgAdminShared';

function refusal(result: DirectoryRefusal, what: string): string {
  return result.code === 'NOT_FOUND' ? notFound(what) : jsonError(result.message, 'FORBIDDEN');
}

export function registerIdentityReadTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_users', {
    tier: 1,
    domain: 'admin',
    searchHint: 'Breeze staff logins: technicians and admins, their roles, MFA status, last login',
    deviceArgs: [],
    definition: {
      name: 'list_users',
      description:
        'Breeze logins (technicians and admins) in your partner or organization: name, email, status, role, MFA status, last login. Not Microsoft 365 users (m365_query_users) or users signed in to a device (get_active_users). Requires full partner access.',
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.list_users),
    },
    handler: async (input, auth) => {
      const denied = deviceBoundDenied(auth, 'The user directory');
      if (denied) return denied;
      const parsed = parseInput(orgAdminToolSchemas.list_users, input);
      if (!parsed.ok) return parsed.error;
      try {
        const result = await listScopedUsersForCaller(auth);
        if (!result.ok) return refusal(result, 'User');
        const page = capped(result.value, parsed.value.limit ?? 100);
        return bounded({ users: page.rows, showing: page.showing, total: page.total, truncated: page.truncated });
      } catch (error) {
        return thrown('list_users', error);
      }
    },
  });

  aiTools.set('get_user', {
    tier: 1,
    domain: 'admin',
    searchHint: 'one Breeze login: role, status, organization or site access',
    deviceArgs: [],
    definition: {
      name: 'get_user',
      description:
        "One Breeze login by id: name, email, status, role, and its organization access (partner) or site and device-group access (organization). Requires full partner access.",
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.get_user),
    },
    handler: async (input, auth) => {
      const denied = deviceBoundDenied(auth, 'The user directory');
      if (denied) return denied;
      const parsed = parseInput(orgAdminToolSchemas.get_user, input);
      if (!parsed.ok) return parsed.error;
      try {
        const result = await getScopedUserForCaller(auth, parsed.value.userId);
        return result.ok ? bounded(result.value) : refusal(result, 'User');
      } catch (error) {
        return thrown('get_user', error);
      }
    },
  });

  aiTools.set('list_roles', {
    tier: 1,
    domain: 'admin',
    searchHint: 'roles and permissions: what a role can do, who holds it, inherited permissions',
    deviceArgs: [],
    definition: {
      name: 'list_roles',
      description:
        "Breeze roles. list: roles with member counts. get: one role's permissions. users: who holds it. effective_permissions: its permissions including inherited ones. Read-only. Partner callers need full partner access.",
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.list_roles),
    },
    handler: async (input, auth) => {
      const denied = deviceBoundDenied(auth, 'Roles');
      if (denied) return denied;
      const parsed = parseInput(orgAdminToolSchemas.list_roles, input);
      if (!parsed.ok) return parsed.error;
      const { action, roleId, orgId } = parsed.value;
      const limit = parsed.value.limit ?? 100;
      if (action !== 'list' && !roleId) return jsonError(`roleId is required for ${action}`, 'VALIDATION_ERROR');
      try {
        switch (action) {
          case 'list': {
            const result = await listRolesForCaller(auth, orgId);
            if (!result.ok) return refusal(result, 'Role');
            const page = capped(result.value, limit);
            return bounded({ roles: page.rows, showing: page.showing, total: page.total, truncated: page.truncated });
          }
          case 'get': {
            const result = await getRoleDetailForCaller(auth, roleId!, orgId);
            return result.ok ? bounded(result.value) : refusal(result, 'Role');
          }
          case 'users': {
            const result = await listRoleUsersForCaller(auth, roleId!, orgId);
            if (!result.ok) return refusal(result, 'Role');
            const page = capped(result.value, limit);
            return bounded({ users: page.rows, showing: page.showing, total: page.total, truncated: page.truncated });
          }
          case 'effective_permissions': {
            const result = await getRoleEffectivePermissionsForCaller(auth, roleId!, orgId);
            return result.ok ? bounded(result.value) : refusal(result, 'Role');
          }
          default:
            return jsonError(`Unknown list_roles action: ${String(action satisfies never)}`, 'VALIDATION_ERROR');
        }
      } catch (error) {
        return thrown('list_roles', error);
      }
    },
  });
}
