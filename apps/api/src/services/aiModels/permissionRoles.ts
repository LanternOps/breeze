/**
 * Role names that grant a permission, for the picker's "Requires <role>"
 * (AI model registry W05, #7603, spec §11). Explicit grants plus every
 * wildcard form the RBAC matcher honours (`permissionGrantMatches`: the
 * resource and the action may each be `*`). Roles are not inherited through
 * `parent_role_id` at permission-resolution time, so neither are they here.
 *
 * Tenancy: roles are partner / org rows and the picker runs under org tokens,
 * so this reads in a fresh system context with EXPLICIT filters — the
 * caller's own partner's roles, the caller's own org's roles, and the global
 * system templates (no partner, no org). Never another tenant's role names.
 */
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';

const MAX_ROLE_NAMES = 3;

export async function rolesGrantingPermission(input: {
  partnerId: string;
  orgId: string | null;
  permission: string;
}): Promise<string[]> {
  const [resource, action, ...rest] = input.permission.split(':');
  if (!resource || !action || rest.length > 0) return [];
  const orgArm = input.orgId ? sql`OR r.org_id = ${input.orgId}::uuid` : sql``;
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ name: string }>(sql`
    SELECT DISTINCT r.name
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.resource IN (${resource}, '*') AND p.action IN (${action}, '*')
      AND (
        r.partner_id = ${input.partnerId}::uuid
        ${orgArm}
        OR (r.partner_id IS NULL AND r.org_id IS NULL)
      )
    ORDER BY r.name
    LIMIT ${MAX_ROLE_NAMES}
  `)));
  const rows = Array.isArray(result) ? result : (result as { rows?: Array<{ name: string }> }).rows ?? [];
  return rows.map((r) => r.name);
}
