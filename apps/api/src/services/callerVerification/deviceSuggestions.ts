/**
 * Workstation device suggestions for caller verification (#6354 W02).
 *
 * Suggests online devices, inside the actor's org/site reach, whose last
 * reported login (`devices.last_user`) matches a login-name hint derived from
 * the contact: its name, its email and email local part, and its active
 * bindings' OS username and UPN (and UPN local part). Each suggestion carries
 * live per-device readiness from heartbeat telemetry.
 *
 * Hints only: a suggestion neither authorizes nor binds anything. The
 * technician still confirms the device and user, `start` re-checks the
 * selected pair, the agent resolves the console login authoritatively, and
 * `hasBinding` never sets a tier — only the answering principal matching a
 * non-revoked binding does.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { reachableContact } from './access';
import { bindingsForContact } from './subjects';
import { workstationUserAvailable } from './workstationCapabilities';
import type { BindingRow, CallerVerificationActor } from './types';

export type DeviceSuggestion = {
  deviceId: string;
  hostname: string;
  username: string;
  hasBinding: boolean;
  available: boolean;
  unavailableReason?: 'helper_outdated';
};

const MAX_SUGGESTIONS = 50;
const norm = (value: string) => value.trim().toLowerCase();

export function suggestionCandidates(
  contact: { name: string | null; email: string | null },
  bindings: Array<Pick<BindingRow, 'osUsername' | 'upnSnapshot' | 'revokedAt'>>,
): string[] {
  const values: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value || !value.trim()) return;
    values.push(norm(value));
    const at = value.indexOf('@');
    if (at > 0) values.push(norm(value.slice(0, at)));
  };
  add(contact.name);
  add(contact.email);
  for (const binding of bindings) {
    if (binding.revokedAt) continue;
    add(binding.osUsername);
    add(binding.upnSnapshot);
  }
  return [...new Set(values)];
}

export function matchSuggestedUsername(lastUser: string | null, candidates: string[], bound: string[]): { username: string; hasBinding: boolean } | null {
  if (!lastUser || !lastUser.trim()) return null;
  const name = norm(lastUser);
  if (!candidates.some((value) => norm(value) === name)) return null;
  return { username: lastUser, hasBinding: bound.some((value) => norm(value) === name) };
}

export async function deviceSuggestions(actor: CallerVerificationActor, orgId: string, contactId: string): Promise<DeviceSuggestion[]> {
  const contact = await reachableContact(actor, orgId, contactId);
  if (actor.allowedSiteIds !== null && actor.allowedSiteIds.length === 0) return [];
  const bindings = await bindingsForContact(orgId, contactId);
  const candidates = suggestionCandidates(contact, bindings);
  if (!candidates.length) return [];
  const bound = bindings.flatMap((b) => (!b.revokedAt && b.osUsername ? [b.osUsername] : []));

  const rows = await db.select({ id: devices.id, hostname: devices.hostname, lastUser: devices.lastUser }).from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      eq(devices.status, 'online'),
      actor.allowedSiteIds === null ? undefined : inArray(devices.siteId, actor.allowedSiteIds),
      inArray(sql<string>`lower(trim(${devices.lastUser}))`, candidates),
    ))
    .orderBy(devices.hostname, devices.id)
    .limit(MAX_SUGGESTIONS);

  const result: DeviceSuggestion[] = [];
  for (const row of rows) {
    const match = matchSuggestedUsername(row.lastUser, candidates, bound);
    if (!match) continue;
    const available = await workstationUserAvailable(orgId, row.id, match.username);
    result.push({
      deviceId: row.id, hostname: row.hostname, ...match, available,
      ...(available ? {} : { unavailableReason: 'helper_outdated' as const }),
    });
  }
  return result;
}
