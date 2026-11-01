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
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups, devices, notificationChannels, scripts } from '../../db/schema';
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

/**
 * Where a script read runs. The default is a fresh system context (the owner
 * predicate is explicit). Tool Catalog W06 (#5221) Task B3: the conversion
 * switch creates generated scripts in its own, still uncommitted, transaction
 * and passes that transaction here, so enable can see them. The owner
 * predicate is the same on both paths; RLS on a caller's transaction can only
 * hide more rows, never fewer (a hidden script reads as not owned).
 */
export type ScriptReadExecutor = Pick<typeof db, 'select'>;

export async function findOwnedScriptIds(
  owner: ToolOwnerRef,
  ids: Iterable<string>,
  opts: { executor?: ScriptReadExecutor } = {},
): Promise<Set<string>> {
  const wanted = uuidsOnly(ids);
  if (wanted.length === 0) return new Set();
  const read = (executor: ScriptReadExecutor) => executor
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(inArray(scripts.id, wanted), isNull(scripts.deletedAt), scriptOwnershipCondition(asReferenceOwner(owner))));
  const rows = opts.executor ? await read(opts.executor) : await system(async () => read(db), 'flowValidator.scripts');
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

/** A notification channel a flow owner may send to (W5 #5220, Decision 14). */
export interface OwnedNotificationChannel {
  id: string;
  type: string;
  orgId: string | null;
  partnerId: string | null;
  enabled: boolean;
}

/**
 * Rule 6 for notification channels (W5 #5220, Decision 14): an org flow may
 * use its org's channels and its partner's partner-wide channels; a
 * partner-wide flow only its partner's partner-wide channels (an org channel
 * would send one customer's notices from every customer's runs). Null for
 * foreign and nonexistent alike.
 */
export async function findOwnedNotificationChannel(owner: ToolOwnerRef, channelId: string): Promise<OwnedNotificationChannel | null> {
  if (!UUID_RE.test(channelId)) return null;
  const partnerWide = and(isNull(notificationChannels.orgId), eq(notificationChannels.partnerId, owner.partnerId));
  const [row] = await system(
    async () => db
      .select({
        id: notificationChannels.id,
        type: notificationChannels.type,
        orgId: notificationChannels.orgId,
        partnerId: notificationChannels.partnerId,
        enabled: notificationChannels.enabled,
      })
      .from(notificationChannels)
      .where(and(
        eq(notificationChannels.id, channelId),
        owner.orgId ? or(eq(notificationChannels.orgId, owner.orgId), partnerWide) : partnerWide,
      ))
      .limit(1),
    'flowValidator.notificationChannel',
  );
  return row ? { ...row, type: String(row.type) } : null;
}
