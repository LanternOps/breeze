/**
 * Tool Catalog W03 (#5218), spec §6.3 rule 6 — which literal asset ids in a
 * flow belong to the flow's owner.
 *
 * System context with explicit owner predicates: the validator runs inside
 * request and chat contexts whose RLS may not match the owner (a partner tech
 * drafting an org flow). Each function returns the subset of `ids` the owner
 * owns; the caller reports every other id with ONE message whether it is
 * foreign or nonexistent (no existence oracle).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups, devices, scripts } from '../../db/schema';
import { scriptOwnershipCondition, type AutomationReferenceOwner } from '../automationReferenceAuthorization';
import type { ToolOwnerRef } from '../toolSources/resolver';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only well-formed uuids reach SQL; malformed ones are rule-2 schema issues already. */
function uuidsOnly(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => UUID_RE.test(id)))];
}

function asReferenceOwner(owner: ToolOwnerRef): AutomationReferenceOwner {
  return owner.orgId
    ? { scope: 'organization', orgId: owner.orgId, partnerId: owner.partnerId }
    : { scope: 'partner', orgId: null, partnerId: owner.partnerId };
}

function system<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export async function findOwnedScriptIds(owner: ToolOwnerRef, ids: Iterable<string>): Promise<Set<string>> {
  const wanted = uuidsOnly(ids);
  if (wanted.length === 0) return new Set();
  const rows = await system(
    async () => db
      .select({ id: scripts.id })
      .from(scripts)
      .where(and(inArray(scripts.id, wanted), isNull(scripts.deletedAt), scriptOwnershipCondition(asReferenceOwner(owner)))),
    'flowValidator.scripts',
  );
  return new Set(rows.map((r) => r.id));
}

export async function findOwnedDeviceGroupIds(orgId: string, ids: Iterable<string>): Promise<Set<string>> {
  const wanted = uuidsOnly(ids);
  if (wanted.length === 0) return new Set();
  const rows = await system(
    async () => db
      .select({ id: deviceGroups.id })
      .from(deviceGroups)
      .where(and(inArray(deviceGroups.id, wanted), eq(deviceGroups.orgId, orgId))),
    'flowValidator.deviceGroups',
  );
  return new Set(rows.map((r) => r.id));
}

export async function findOwnedDeviceIds(orgId: string, ids: Iterable<string>): Promise<Set<string>> {
  const wanted = uuidsOnly(ids);
  if (wanted.length === 0) return new Set();
  const rows = await system(
    async () => db
      .select({ id: devices.id })
      .from(devices)
      .where(and(inArray(devices.id, wanted), eq(devices.orgId, orgId))),
    'flowValidator.devices',
  );
  return new Set(rows.map((r) => r.id));
}
