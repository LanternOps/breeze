import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { contactRoles } from '../../db/schema/contactRoles';
import { deviceGroupMemberships, deviceGroups } from '../../db/schema/devices';
import type { ContactExecutor } from './compat';
import type { ContactRole } from './types';

/**
 * Compatibility-window reconciliation for legacy contact writers.
 *
 * Legacy APIs carry only `contacts.site_id` + `contacts.roles[]`, so the
 * responsibility scope is derived deterministically from the resulting row:
 *   - site_id NULL => Organization
 *   - site_id SET  => that exact Site
 *
 * During this window the whole assignment set is legacy-derived. Replacing it
 * atomically is therefore intentional: a re-pin moves the assignments instead
 * of leaving a broader Organization assignment behind.
 */
export async function reconcileLegacyContactResponsibilities(
  exec: ContactExecutor,
  input: {
    contactId: string;
    orgId: string;
    siteId: string | null;
    roles: readonly ContactRole[] | readonly string[] | null | undefined;
  },
): Promise<void> {
  const roles = [...new Set(input.roles ?? [])];

  await exec
    .delete(contactRoles)
    .where(and(eq(contactRoles.contactId, input.contactId), eq(contactRoles.orgId, input.orgId)));

  if (roles.length === 0) return;

  await exec
    .insert(contactRoles)
    .values(roles.map((role) => ({
      contactId: input.contactId,
      orgId: input.orgId,
      role,
      siteId: input.siteId,
      deviceGroupId: null,
    })))
    .onConflictDoNothing();
}


export type ResponsibilityScopeLevel = 'device_group' | 'site' | 'organization';

export interface ResolvedContactResponsibility {
  level: ResponsibilityScopeLevel;
  assignments: Array<{
    id: string;
    contactId: string;
    orgId: string;
    role: string;
    isPrimary: boolean;
    siteId: string | null;
    deviceGroupId: string | null;
  }>;
}

export interface ResolveContactResponsibilityInput {
  orgId: string;
  role: ContactRole;
  siteId?: string | null;
  deviceGroupIds?: readonly string[];
  deviceId?: string;
}

const responsibilityColumns = () => ({
  id: contactRoles.id,
  contactId: contactRoles.contactId,
  orgId: contactRoles.orgId,
  role: contactRoles.role,
  isPrimary: contactRoles.isPrimary,
  siteId: contactRoles.siteId,
  deviceGroupId: contactRoles.deviceGroupId,
});

type ResponsibilityRow = ResolvedContactResponsibility['assignments'][number];

function dedupeAssignmentsByContact(rows: ResponsibilityRow[]): ResponsibilityRow[] {
  const byContact = new Map<string, ResponsibilityRow>();
  for (const row of rows) {
    const existing = byContact.get(row.contactId);
    // Deterministic representative when one contact reaches the same effective
    // group specificity through multiple unrelated matching groups.
    if (!existing || row.id.localeCompare(existing.id) < 0) byContact.set(row.contactId, row);
  }
  return [...byContact.values()].sort((a, b) => a.contactId.localeCompare(b.contactId));
}

async function directDeviceGroupIds(
  exec: ContactExecutor,
  input: ResolveContactResponsibilityInput,
): Promise<string[]> {
  if (input.deviceGroupIds !== undefined) return [...new Set(input.deviceGroupIds)];
  if (!input.deviceId) return [];

  const rows = await exec
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(and(
      eq(deviceGroupMemberships.orgId, input.orgId),
      eq(deviceGroupMemberships.deviceId, input.deviceId),
    ));
  return [...new Set(rows.map((row) => row.groupId))];
}

async function resolveGroupLevel(
  exec: ContactExecutor,
  input: ResolveContactResponsibilityInput,
  directIds: string[],
): Promise<ResponsibilityRow[]> {
  let frontier = [...new Set(directIds)];
  const visited = new Set<string>();

  while (frontier.length > 0) {
    const levelIds = frontier.filter((id) => !visited.has(id));
    if (levelIds.length === 0) break;
    levelIds.forEach((id) => visited.add(id));

    const matches = await exec
      .select(responsibilityColumns())
      .from(contactRoles)
      .where(and(
        eq(contactRoles.orgId, input.orgId),
        eq(contactRoles.role, input.role),
        inArray(contactRoles.deviceGroupId, levelIds),
      ))
      .orderBy(asc(contactRoles.contactId), asc(contactRoles.id)) as ResponsibilityRow[];

    if (matches.length > 0) return dedupeAssignmentsByContact(matches);

    const groups = await exec
      .select({ id: deviceGroups.id, parentId: deviceGroups.parentId })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.orgId, input.orgId), inArray(deviceGroups.id, levelIds)));

    frontier = [...new Set(groups
      .map((group) => group.parentId)
      .filter((parentId): parentId is string => parentId !== null && !visited.has(parentId)))];
  }

  return [];
}

/**
 * Canonical responsibility resolver. More-specific matches stop fallback:
 * Device Group (direct, then nearest ancestor) > Site > Organization.
 */
export async function resolveContactResponsibility(
  exec: ContactExecutor,
  input: ResolveContactResponsibilityInput,
): Promise<ResolvedContactResponsibility> {
  const groupIds = await directDeviceGroupIds(exec, input);
  if (groupIds.length > 0) {
    const assignments = await resolveGroupLevel(exec, input, groupIds);
    if (assignments.length > 0) return { level: 'device_group', assignments };
  }

  if (input.siteId) {
    const assignments = await exec
      .select(responsibilityColumns())
      .from(contactRoles)
      .where(and(
        eq(contactRoles.orgId, input.orgId),
        eq(contactRoles.role, input.role),
        eq(contactRoles.siteId, input.siteId),
        isNull(contactRoles.deviceGroupId),
      ))
      .orderBy(asc(contactRoles.contactId), asc(contactRoles.id)) as ResponsibilityRow[];
    if (assignments.length > 0) return { level: 'site', assignments: dedupeAssignmentsByContact(assignments) };
  }

  const assignments = await exec
    .select(responsibilityColumns())
    .from(contactRoles)
    .where(and(
      eq(contactRoles.orgId, input.orgId),
      eq(contactRoles.role, input.role),
      isNull(contactRoles.siteId),
      isNull(contactRoles.deviceGroupId),
    ))
    .orderBy(asc(contactRoles.contactId), asc(contactRoles.id)) as ResponsibilityRow[];

  return { level: 'organization', assignments: dedupeAssignmentsByContact(assignments) };
}
