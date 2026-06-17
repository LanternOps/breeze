import type { PermissionResource, PermissionAction } from '@breeze/shared';
import { useAuthStore, type Permission } from '../stores/auth';

/**
 * Wildcard-aware permission check, mirroring the server's `hasPermission`
 * (apps/api/src/services/permissions.ts). A grant matches when its resource and
 * action equal the requested ones, or are the `*` wildcard (held by admins via
 * the `*:*` grant).
 *
 * UX only — never an authorization decision. Every API route re-checks the same
 * permission server-side, so a stale or spoofed client list cannot grant access.
 */
export function hasPermission(
  permissions: Permission[] | undefined,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  if (!permissions) return false;
  return permissions.some(
    (p) =>
      (p.resource === resource || p.resource === '*') &&
      (p.action === action || p.action === '*'),
  );
}

/**
 * React hook returning a `can(resource, action)` checker bound to the current
 * user's permissions. Re-renders when the permission set changes.
 *
 * While permissions are still loading (undefined — e.g. a freshly restored
 * session before /users/me resolves), `can` returns false, so gated UI stays
 * hidden until grants are known rather than flashing then disappearing.
 */
export function usePermissions(): {
  permissions: Permission[] | undefined;
  can: (resource: PermissionResource, action: PermissionAction) => boolean;
} {
  const permissions = useAuthStore((s) => s.user?.permissions);
  return {
    permissions,
    can: (resource: PermissionResource, action: PermissionAction) =>
      hasPermission(permissions, resource, action),
  };
}
