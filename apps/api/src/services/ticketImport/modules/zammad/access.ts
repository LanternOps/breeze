import type { ConnectReport, SourceCatalog, SourceHandle } from '../../moduleContract';
import { clockSkewFromDateHeader, SourceAuthError, SourceHttpError } from '../../sourceFetch';
import {
  firstTicket,
  getMe,
  getVersion,
  listGroups,
  listObjectAttributes,
  listOrganizations,
  listPriorities,
  listRoles,
  listStates,
  listUsers,
} from './api';
import { stateTypeName } from './directory';
import { cleanText, isCustomTicketAttribute, personName, usableEmail } from './mapping';
import { personOf, type zammadMeSchema } from './shapes';
import type { z } from 'zod';

/**
 * Token, access and catalog of a Zammad 7.2.x source (#8313 W5; spec
 * 2026-10-19 §6.1, §5.11 preflight).
 *
 * - The token must read tickets: one ticket page is the live test (a 401 is
 *   a refused credential, a 403 a token that cannot read tickets).
 * - The version: any 7.2.x is accepted and reported (`sourceVersion`); one
 *   outside 7.2 is a warning, not a refusal: the module's shape checks fail
 *   loudly on what it does not know. `GET /version` needs the exact `admin`
 *   permission, so the recommended `ticket.agent` token reads none: a
 *   warning, and `sourceVersion` null.
 * - Ticket visibility comes from group access, and only ACTIVE groups count
 *   (Z1): every inactive group is flagged "tickets here will not be
 *   imported". When the token user's group access can be read (`/users/me`
 *   and its roles; `/users/me` is documented but unverified in the 7.2.2
 *   source, §11), an active group it has no `read` on is flagged too. Only
 *   active roles count, as in 7.2.2; 7.2.0 still honours an inactive role's
 *   group access (fixed in 7.2.1/7.2.2), so on 7.2.0 such a group can be
 *   flagged although readable.
 * - A token cannot be read-only: `ticket.agent` can still change users and
 *   organizations (Z11). Every connect says so, so the wizard can recommend
 *   revoking the token after the cutover.
 * - The clock skew is the source's `Date` header against Breeze's clock
 *   (§5.2).
 */

/** 7.2, 7.2.0, 7.2.2, or a packaged 7.2.0-<build>; not 7.20 or 7.3. */
export function isZammad72(version: string): boolean {
  return /^7\.2(?:\.\d+)?(?:$|[-+ ])/.test(version.trim());
}

type Me = z.infer<typeof zammadMeSchema>;
type GroupAccess = Map<string, Set<string>>;

const READ_ACCESS = new Set(['read', 'full']);

function quiet<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((error: unknown) => {
    // A refused credential stops everything; a call this token may not make (403) or that 7.2.2 lacks (404) does not.
    if (error instanceof SourceAuthError || !(error instanceof SourceHttpError) || ![403, 404].includes(error.status)) throw error;
    return null;
  });
}

/** The token user, the permissions of its active roles, and its group access (direct and by role). */
async function tokenUser(src: SourceHandle<unknown>): Promise<{ me: Me | null; permissions: string[] | null; access: GroupAccess | null }> {
  const meResponse = await quiet(getMe(src));
  const me = meResponse?.body ?? null;
  if (!me) return { me: null, permissions: null, access: null };
  const roles = (await quiet(listRoles(src)))?.rows ?? null;
  const mine = (roles ?? []).filter((r) => (me.role_ids ?? []).includes(r.id) && r.active !== false);
  const permissions = roles ? [...new Set(mine.flatMap((r) => r.permissions ?? []))].sort() : null;
  const access: GroupAccess = new Map();
  for (const grants of [me.group_ids ?? {}, ...mine.map((r) => r.group_ids ?? {})]) {
    for (const [groupId, levels] of Object.entries(grants)) {
      const set = access.get(groupId) ?? new Set<string>();
      for (const level of levels) set.add(level);
      access.set(groupId, set);
    }
  }
  return { me, permissions, access: access.size > 0 ? access : null };
}

function canRead(access: GroupAccess | null, groupId: number): boolean | undefined {
  if (!access) return undefined;
  return [...(access.get(String(groupId)) ?? [])].some((level) => READ_ACCESS.has(level));
}

export async function connectZammad(src: SourceHandle<unknown>): Promise<ConnectReport> {
  const probe = await firstTicket(src);
  const clockSkewMs = clockSkewFromDateHeader(probe.headers);
  const warnings: ConnectReport['warnings'] = [];
  if (probe.count === 0) warnings.push({ code: 'no_visible_tickets' });

  const version = await quiet(getVersion(src));
  const sourceVersion = version === null ? null : cleanText(version).trim().slice(0, 100);
  if (sourceVersion === null) warnings.push({ code: 'version_unreadable' });
  else if (!isZammad72(sourceVersion)) warnings.push({ code: 'version_unsupported', detail: sourceVersion });

  const { me, permissions, access } = await tokenUser(src);
  if (!me) warnings.push({ code: 'identity_unreadable' });
  if (me && permissions === null) warnings.push({ code: 'permissions_unreadable' });
  if (permissions && !permissions.includes('ticket.agent')) warnings.push({ code: 'token_user_not_agent' });

  for (const group of (await listGroups(src)).rows) {
    const label = `${cleanText(group.name)} (id ${group.id})`;
    if (group.active === false) warnings.push({ code: 'group_inactive', detail: label });
    else if (canRead(access, group.id) === false) warnings.push({ code: 'group_unreadable', detail: label });
  }
  warnings.push({ code: 'token_not_read_only' });

  return {
    identity: me
      ? { key: String(me.id), name: personName(personOf(me), me.id), email: usableEmail(me.email) }
      : { key: null, name: null, email: null },
    permissions: permissions ?? [],
    warnings,
    clockSkewMs,
    sourceVersion,
  };
}

export async function catalogZammad(src: SourceHandle<unknown>): Promise<SourceCatalog> {
  const organizations = await listOrganizations(src);
  const groups = await listGroups(src);
  const priorities = await listPriorities(src);
  const states = await listStates(src);
  const { access } = await tokenUser(src);
  const lists = [organizations, groups, priorities, states];
  // Definitions need admin.object (Z17); without it the dry run discovers attribute names from ticket keys.
  const definitions = await quiet(listObjectAttributes(src));
  const attributes = (definitions?.rows ?? [])
    .filter((a) => (a.object == null || a.object === 'Ticket') && isCustomTicketAttribute(a.name))
    .map((a) => ({ key: a.name, name: cleanText(a.display ?? a.name), active: a.active !== false }));
  const users = await listUsers(src);
  return {
    orgs: organizations.rows.map((o) => ({ key: String(o.id), name: cleanText(o.name), active: o.active !== false })),
    groups: groups.rows.map((g) => {
      const readable = g.active !== false && canRead(access, g.id) !== false;
      return { key: String(g.id), name: cleanText(g.name), active: g.active !== false, readable };
    }),
    priorities: priorities.rows.map((p) => ({ key: String(p.id), name: cleanText(p.name), active: p.active !== false })),
    states: states.rows.map((s) => ({ key: String(s.id), name: `${cleanText(s.name)} (${stateTypeName(s.state_type_id, s.state_type)})`, active: s.active !== false })),
    attributes,
    counts: {
      organizations: organizations.rows.length,
      groups: groups.rows.length,
      inactiveGroups: groups.rows.filter((g) => g.active === false).length,
      users: users.rows.length,
      states: states.rows.length,
      priorities: priorities.rows.length,
      attributeDefinitionsReadable: definitions ? 1 : 0,
      // Rows of these lists the module could not read, skipped one by one.
      invalidRows: [...lists, users, ...(definitions ? [definitions] : [])].reduce((n, l) => n + l.invalid, 0),
    },
  };
}
