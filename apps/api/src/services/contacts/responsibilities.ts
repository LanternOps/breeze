import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { db } from '../../db';
import { contactRoles } from '../../db/schema/contactRoles';
import { contacts } from '../../db/schema/contacts';
import { deviceGroupMemberships, deviceGroups } from '../../db/schema/devices';
import { sites } from '../../db/schema/orgs';
import type { ContactExecutor } from './compat';
import { CONTACT_ROLES, type ContactRole } from './types';

export type ResponsibilityScopeInput =
  | { type: 'organization' }
  | { type: 'site'; siteId: string }
  | { type: 'device_group'; deviceGroupId: string };

export interface ContactResponsibilityInput {
  role: ContactRole;
  scope: ResponsibilityScopeInput;
  isPrimary?: boolean;
}

export class ResponsibilityValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'contact-not-in-org'
      | 'site-not-in-org'
      | 'device-group-not-in-org'
      | 'unsupported-role'
      | 'unsupported-scope'
      | 'duplicate-assignment',
  ) {
    super(message);
    this.name = 'ResponsibilityValidationError';
  }
}

function scopeColumns(scope: ResponsibilityScopeInput): { siteId: string | null; deviceGroupId: string | null } {
  if (scope.type === 'organization') return { siteId: null, deviceGroupId: null };
  if (scope.type === 'site') return { siteId: scope.siteId, deviceGroupId: null };
  if (scope.type === 'device_group') return { siteId: null, deviceGroupId: scope.deviceGroupId };
  throw new ResponsibilityValidationError('Unsupported responsibility scope', 'unsupported-scope');
}

function assignmentKey(input: ContactResponsibilityInput): string {
  const scope = scopeColumns(input.scope);
  return `${input.role}\u0000${scope.siteId ?? ''}\u0000${scope.deviceGroupId ?? ''}`;
}

function projectedRoleList(assignments: readonly ContactResponsibilityInput[]): ContactRole[] {
  const roles = new Set(assignments.map((assignment) => assignment.role));
  return CONTACT_ROLES.filter((role) => roles.has(role));
}

async function replaceCanonicalSet(
  exec: ContactExecutor,
  input: { contactId: string; orgId: string; responsibilities: readonly ContactResponsibilityInput[] },
): Promise<void> {
  await exec
    .delete(contactRoles)
    .where(and(eq(contactRoles.contactId, input.contactId), eq(contactRoles.orgId, input.orgId)));

  if (input.responsibilities.length > 0) {
    await exec.insert(contactRoles).values(input.responsibilities.map((assignment) => ({
      contactId: input.contactId,
      orgId: input.orgId,
      role: assignment.role,
      isPrimary: assignment.isPrimary ?? false,
      ...scopeColumns(assignment.scope),
    })));
  }

  // `contacts.roles[]` is now a compatibility projection only. The canonical
  // assignment set above is authoritative; project its distinct roles back in
  // stable CONTACT_ROLES order for legacy readers.
  await exec
    .update(contacts)
    .set({ roles: projectedRoleList(input.responsibilities), updatedAt: new Date() })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));
}

/**
 * Compatibility adapter for legacy writers that still accept only
 * `contacts.site_id` + role names (spec §7.4, §8.3, §9). It is NOT an
 * authoritative writer: it applies a *delta* against the assignments already
 * held in `contact_roles`, and leaves everything it has no authority over alone.
 *
 *   - role added    => one assignment at the scope derived from the resulting
 *                      pin (site_id NULL => Organization, SET => that Site);
 *   - role removed  => every assignment of that role, at any scope, is removed
 *                      (the only way to keep the `roles[]` projection true);
 *   - role kept     => stays, but when the contact is pinned to a Site its
 *                      Organization/Site-scoped assignments are re-scoped to
 *                      that Site (§7.4 re-pin): a legacy pin must never leave
 *                      an organization-wide authorizer behind;
 *   - Device Group  => never touched by a re-pin; a legacy writer has no
 *                      authority over them (§8.4).
 *
 * Un-pinning (site_id back to NULL) deliberately does not widen anything yet:
 * it is held for an explicit decision, see the PR discussion.
 *
 * `contacts.roles[]` is then re-projected from the resulting canonical set.
 */
export async function syncLegacyContactRoles(
  exec: ContactExecutor,
  input: {
    contactId: string;
    orgId: string;
    siteId: string | null;
    roles: readonly ContactRole[] | readonly string[] | null | undefined;
  },
): Promise<void> {
  const desired = new Set<string>(input.roles ?? []);
  const owned = and(eq(contactRoles.contactId, input.contactId), eq(contactRoles.orgId, input.orgId));

  const existing = await exec
    .select({
      role: contactRoles.role,
      siteId: contactRoles.siteId,
      deviceGroupId: contactRoles.deviceGroupId,
      isPrimary: contactRoles.isPrimary,
    })
    .from(contactRoles)
    .where(owned);
  const held = new Set<string>(existing.map((row) => row.role));

  const removed = [...held].filter((role) => !desired.has(role));
  // Not filtered to CONTACT_ROLES: an unknown name must reach the role CHECK and
  // be refused, exactly as the replace-the-set adapter did, not dropped silently.
  const added = [
    ...CONTACT_ROLES.filter((role) => desired.has(role) && !held.has(role)),
    ...[...desired].filter((role) => !held.has(role) && !(CONTACT_ROLES as readonly string[]).includes(role)),
  ];

  if (removed.length > 0) {
    await exec.delete(contactRoles).where(and(owned, inArray(contactRoles.role, removed)));
  }

  const scope: ResponsibilityScopeInput = input.siteId === null
    ? { type: 'organization' }
    : { type: 'site', siteId: input.siteId };
  const inserts = added.map((role) => ({ role, isPrimary: false }));

  if (input.siteId !== null) {
    // Kept roles with a legacy-derived (Organization or other-Site) row move to
    // the pinned Site; a row already at the pinned Site is left as it is.
    const pinned = input.siteId;
    const atPinnedSite = new Set(existing.filter((row) => row.siteId === pinned).map((row) => row.role));
    const stale = existing.filter((row) =>
      desired.has(row.role) && row.deviceGroupId === null && row.siteId !== pinned);
    const staleRoles = [...new Set(stale.map((row) => row.role))];
    if (staleRoles.length > 0) {
      await exec.delete(contactRoles).where(and(
        owned,
        inArray(contactRoles.role, staleRoles),
        isNull(contactRoles.deviceGroupId),
        or(isNull(contactRoles.siteId), ne(contactRoles.siteId, pinned)),
      ));
      for (const role of staleRoles) {
        if (atPinnedSite.has(role)) continue;
        inserts.push({ role, isPrimary: stale.some((row) => row.role === role && row.isPrimary) });
      }
    }
  }

  if (inserts.length > 0) {
    await exec.insert(contactRoles).values(inserts.map(({ role, isPrimary }) => ({
      contactId: input.contactId,
      orgId: input.orgId,
      role,
      isPrimary,
      ...scopeColumns(scope),
    })));
  }

  // kept ∪ added == the desired roles inside the vocabulary.
  const resulting = CONTACT_ROLES.filter((role) => desired.has(role));
  await exec
    .update(contacts)
    .set({ roles: resulting, updatedAt: new Date() })
    .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));
}

/** Replace a contact's explicit canonical responsibility set atomically. */
export async function replaceContactResponsibilities(
  exec: ContactExecutor,
  input: { contactId: string; orgId: string; responsibilities: readonly ContactResponsibilityInput[] },
): Promise<void> {
  const [contact] = await exec
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)))
    .limit(1);
  if (!contact) throw new ResponsibilityValidationError('Contact does not belong to this organization', 'contact-not-in-org');

  const seen = new Set<string>();
  for (const assignment of input.responsibilities) {
    if (!(CONTACT_ROLES as readonly string[]).includes(assignment.role)) {
      throw new ResponsibilityValidationError(`Unsupported contact role: ${assignment.role}`, 'unsupported-role');
    }
    const key = assignmentKey(assignment);
    if (seen.has(key)) throw new ResponsibilityValidationError('Duplicate responsibility assignment', 'duplicate-assignment');
    seen.add(key);
  }

  const siteIds = [...new Set(input.responsibilities.flatMap((assignment) =>
    assignment.scope.type === 'site' ? [assignment.scope.siteId] : []))];
  if (siteIds.length > 0) {
    const rows = await exec
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.orgId, input.orgId), inArray(sites.id, siteIds)));
    const valid = new Set(rows.map((row) => row.id));
    if (siteIds.some((id) => !valid.has(id))) {
      throw new ResponsibilityValidationError('Site does not belong to this organization', 'site-not-in-org');
    }
  }

  const groupIds = [...new Set(input.responsibilities.flatMap((assignment) =>
    assignment.scope.type === 'device_group' ? [assignment.scope.deviceGroupId] : []))];
  if (groupIds.length > 0) {
    const rows = await exec
      .select({ id: deviceGroups.id })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.orgId, input.orgId), inArray(deviceGroups.id, groupIds)));
    const valid = new Set(rows.map((row) => row.id));
    if (groupIds.some((id) => !valid.has(id))) {
      throw new ResponsibilityValidationError('Device Group does not belong to this organization', 'device-group-not-in-org');
    }
  }

  await replaceCanonicalSet(exec, input);
}

export async function listContactResponsibilities(
  exec: ContactExecutor,
  input: { contactId: string; orgId: string },
) {
  return exec
    .select({
      id: contactRoles.id,
      contactId: contactRoles.contactId,
      orgId: contactRoles.orgId,
      role: contactRoles.role,
      isPrimary: contactRoles.isPrimary,
      siteId: contactRoles.siteId,
      deviceGroupId: contactRoles.deviceGroupId,
    })
    .from(contactRoles)
    .where(and(eq(contactRoles.contactId, input.contactId), eq(contactRoles.orgId, input.orgId)))
    .orderBy(asc(contactRoles.role), asc(contactRoles.siteId), asc(contactRoles.deviceGroupId), asc(contactRoles.id));
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

/**
 * Batch facade of the canonical resolver for Organization-context consumers.
 * It centralizes the Organization-scope rule and avoids N+1 lookups in bulk
 * consumers such as Report Series.
 */
export async function resolveOrganizationResponsibilitiesForOrgs(
  exec: Pick<typeof db, 'select'>,
  input: { orgIds: readonly string[]; roles: readonly ContactRole[] },
): Promise<ResponsibilityRow[]> {
  if (input.orgIds.length === 0 || input.roles.length === 0) return [];
  const rows = await exec
    .select(responsibilityColumns())
    .from(contactRoles)
    .where(and(
      inArray(contactRoles.orgId, [...new Set(input.orgIds)]),
      inArray(contactRoles.role, [...new Set(input.roles)]),
      isNull(contactRoles.siteId),
      isNull(contactRoles.deviceGroupId),
    ))
    .orderBy(asc(contactRoles.orgId), asc(contactRoles.contactId), asc(contactRoles.id)) as ResponsibilityRow[];
  return rows;
}
