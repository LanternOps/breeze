/**
 * Same-org device site move — the ONE implementation behind PATCH /devices/:id (a `siteId` change)
 * and POST /devices/bulk/site (#9796; spec §4.4 "Shared move logic"). Extracted verbatim from the
 * PATCH handler; the bulk route must never re-implement any of it.
 *
 * Division of labour (do not blur it):
 *  - The CALLER authorizes the device — org scope and the SOURCE site allowlist — through the
 *    `getDeviceWithOrgAndSiteCheck` chokepoint (routes/devices/helpers.ts) and passes the row in.
 *    This module never re-derives org access.
 *  - This module owns the move: the `expectedSiteId` guard (S§12.2), the target-site same-org
 *    check, the TARGET site allowlist (`canAccessSite`), the `FOR UPDATE` row lock + re-read
 *    (S§12.1), the guarded UPDATE savepoint with the denormalized `site_id` rewrite, dynamic-group
 *    re-evaluation, peripheral reconciliation and both audit entries (`device.update` and the
 *    semantic `device.site_move`, S§12.4).
 *  - It runs on whatever DB access context the caller holds (PATCH: the request transaction;
 *    bulk: one `runBulkIsolated` transaction per device). It never opens one and never touches
 *    the Hono context — permissions and the audit sink are passed in explicitly.
 *
 * A refused move writes nothing. A `conflict` names the device's current site only when the
 * caller may see it (the visibility rule PATCH's 409 has always used).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices, sites } from '../db/schema';
import { canAccessSite, type UserPermissions } from './permissions';
import { persistDeviceCustomFieldValues, type CustomFieldValueWrite } from './customFields/queries';
import { requestDeviceGroupReevaluationAfterCommit } from '../jobs/deviceGroupJobs';
import { schedulePeripheralPolicyDevice } from '../jobs/peripheralJobs';
// Same import the org move uses (services/deviceOrgMove): the rewrite list lives beside the other
// device table lists in core.ts, which the moveOrg.coverage drift detector reads.
import { rewriteDeviceSiteDenormalizedTables } from '../routes/devices/core';

/**
 * Per-device outcome of a site move. The service itself produces `moved`, `already_there`,
 * `conflict` and `forbidden`; `not_found` (the authorization chokepoint returned nothing) and
 * `error` (an unexpected throw, logged server-side) are produced by the bulk route around it.
 *
 * There is deliberately no `not_agent`: a network or manual row's id is a `discovered_assets` /
 * `manual_assets` id, which is simply not in `devices` → `not_found`. Probing the other tables to
 * tell them apart would be an existence oracle. Agent-only filtering lives in the web funnels.
 */
export type SiteMoveOutcome = 'moved' | 'already_there' | 'conflict' | 'forbidden' | 'not_found' | 'error';

/** The authorized device row the caller hands in (a subset of the chokepoint's full row). */
export type SiteMoveDevice = Pick<typeof devices.$inferSelect, 'id' | 'orgId' | 'siteId' | 'hostname' | 'displayName'>;

export type SiteMoveTrigger = 'manual' | 'topology_suggestion';

/** Why a move was refused as `forbidden`. PATCH maps these to its historical 400 / 403 bodies. */
export type SiteMoveForbiddenReason = 'target_site_not_found' | 'target_site_denied';

export type SiteMoveConflict = { outcome: 'conflict'; currentSiteId?: string; message: string };
export type SiteMoveForbidden = { outcome: 'forbidden'; reason: SiteMoveForbiddenReason; message: string };
export type SiteMoveAlreadyThere = { outcome: 'already_there'; fromSiteId: string };
export type SiteMoveMoved = { outcome: 'moved'; fromSiteId: string; device: typeof devices.$inferSelect };

export type PreparedSiteMove =
  | { outcome: 'ready'; targetSiteName: string | null }
  | SiteMoveAlreadyThere
  | SiteMoveConflict
  | SiteMoveForbidden;

export type SiteMoveResult = SiteMoveMoved | SiteMoveAlreadyThere | SiteMoveConflict | SiteMoveForbidden;

/**
 * One audit row. The caller turns it into a `writeRouteAudit(c, entry)` so both rows keep the
 * request's actor / IP / user-agent attribution; the bulk route adds `details.bulk = true`.
 */
export type SiteMoveAuditEntry = {
  orgId: string;
  action: 'device.update' | 'device.site_move';
  resourceType: 'device';
  resourceId: string;
  resourceName: string | null;
  details: Record<string, unknown>;
};
export type SiteMoveAuditSink = (entry: SiteMoveAuditEntry) => void;

export type SiteMoveEvidence = {
  matchedSiteId: string | null; prefix: string | null; gatewayAddress: string | null; macCorroborated: boolean;
  days: number | null; firstObservedAt: string | null; lastObservedAt: string | null; fingerprintVersion: string;
};
export type SiteMoveSuggestion = { state: 'eligible' | 'not_eligible'; evidence: SiteMoveEvidence | null };
export type SiteMoveAuditInput = {
  from: string; fromName: string | null; to: string; toName: string | null;
  expectedSiteId: string | null; trigger: SiteMoveTrigger;
  /** Only for `topology_suggestion` moves: read server-side from the presence row (S§12.3). */
  suggestion?: SiteMoveSuggestion;
};

/** `device.site_move` audit details (S§12.4), with server-derived suggestion evidence for suggestion moves (W3). */
export function siteMoveAuditDetails(input: SiteMoveAuditInput): Record<string, unknown> {
  return { fromSiteId: input.from, fromSiteName: input.fromName, toSiteId: input.to, toSiteName: input.toName,
    expectedSiteId: input.expectedSiteId, trigger: input.trigger,
    ...(input.suggestion ? { suggestionState: input.suggestion.state, evidence: input.suggestion.evidence } : {}) };
}

const SITE_CHANGED_MESSAGE = "The device's site changed since it was read";

/** S§12 visibility rule: name the current site only when the caller may see it. */
function conflict(permissions: UserPermissions | undefined, currentSiteId: string | null | undefined): SiteMoveConflict {
  const visible = !!currentSiteId && (!permissions || canAccessSite(permissions, currentSiteId));
  return { outcome: 'conflict', message: SITE_CHANGED_MESSAGE, ...(visible ? { currentSiteId: currentSiteId! } : {}) };
}

/** Thrown inside the site-move savepoint when the guarded UPDATE matches no row, so nothing in it commits. */
class GuardedUpdateConflict extends Error {
  constructor() { super('device site changed during the move'); }
}

const isoOrNull = (value: string | Date | null | undefined) => (value ? new Date(value).toISOString() : null);

/**
 * Site location W3 (S§12.3): the evidence for a move accepted from a wrong-site suggestion, read from the device's
 * presence row under the caller's RLS context. Never from the client. Must run BEFORE the devices UPDATE, whose
 * BEFORE trigger (breeze_topology_presence_device_moved) deletes the presence row. `eligible` only when the stored
 * suggestion names the destination and the row is still valid for the current assignment (S§7.3) and unconfirmed;
 * otherwise the move still proceeds (the user's explicit choice) and the audit says `not_eligible`.
 */
async function readSuggestionEvidence(deviceId: string, fromSiteId: string, toSiteId: string): Promise<SiteMoveSuggestion> {
  const rows = await db.execute<{
    suggested_site_id: string | null; suggestion_days: number | null; suggestion_first_at: string | Date | null; suggestion_last_at: string | Date | null;
    matched_site_id: string | null; prefix: string | null; gateway_address: string | null; mac_corroborated: boolean; fingerprint_version: string;
    assigned_site_id: string; version_ok: boolean | null; fresh: boolean; confirmed: boolean;
  }>(sql`SELECT p.suggested_site_id::text AS suggested_site_id, p.suggestion_days, p.suggestion_first_at, p.suggestion_last_at,
      p.matched_site_id::text AS matched_site_id, p.prefix::text AS prefix, host(p.gateway_address) AS gateway_address, p.mac_corroborated,
      p.fingerprint_version::text AS fingerprint_version, p.assigned_site_id::text AS assigned_site_id,
      (p.fingerprint_version = s.fingerprint_version) AS version_ok, (p.fresh_until IS NOT NULL AND p.fresh_until > now()) AS fresh,
      (d.site_assignment_confirmed_at IS NOT NULL) AS confirmed
    FROM topology_device_presence p
    JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
    LEFT JOIN topology_org_presence_state s ON s.org_id = p.org_id
    WHERE p.device_id = ${deviceId}::uuid`);
  const row = (rows as unknown as typeof rows | undefined)?.[0];
  if (!row) return { state: 'not_eligible', evidence: null };
  const eligible = row.suggested_site_id === toSiteId.toLowerCase() && row.version_ok === true && row.fresh && row.assigned_site_id === fromSiteId && !row.confirmed;
  return {
    state: eligible ? 'eligible' : 'not_eligible',
    evidence: {
      matchedSiteId: row.matched_site_id, prefix: row.prefix, gatewayAddress: row.gateway_address, macCorroborated: row.mac_corroborated,
      days: row.suggestion_days, firstObservedAt: isoOrNull(row.suggestion_first_at), lastObservedAt: isoOrNull(row.suggestion_last_at),
      fingerprintVersion: row.fingerprint_version,
    },
  };
}

/**
 * Phase 1 — the checks that need no lock, in PATCH's historical order: the stale-view guard, then
 * "already there", then the target site (same org as the device, then the caller's allowlist).
 * Writes nothing. PATCH runs its custom-field validation between this and {@link executeDeviceSiteMove},
 * which is why the two phases are separate; every other caller uses {@link moveDeviceToSite}.
 *
 * `toSiteId === device.siteId` is an exact comparison (PATCH semantics: only a real move writes
 * `site_id`, so a stale echo of the current site cannot revert a concurrent move).
 */
export async function prepareDeviceSiteMove(args: {
  device: SiteMoveDevice;
  permissions: UserPermissions | undefined;
  toSiteId: string;
  expectedSiteId: string | null | undefined;
}): Promise<PreparedSiteMove> {
  const { device, permissions, toSiteId, expectedSiteId } = args;
  // The caller acted on a stale view of the device's site: refuse before any write (S§12.2).
  if (expectedSiteId !== undefined && expectedSiteId !== null && expectedSiteId.toLowerCase() !== device.siteId.toLowerCase()) {
    return conflict(permissions, device.siteId);
  }
  if (toSiteId === device.siteId) return { outcome: 'already_there', fromSiteId: device.siteId };

  // Same org as the device AND, for a site-restricted caller, a site they may place devices into.
  // The source site was already gated by the caller's getDeviceWithOrgAndSiteCheck.
  const [targetSite] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, toSiteId), eq(sites.orgId, device.orgId)))
    .limit(1);
  if (!targetSite) {
    return { outcome: 'forbidden', reason: 'target_site_not_found', message: 'Target site not found or belongs to a different organization' };
  }
  if (permissions?.allowedSiteIds && !canAccessSite(permissions, toSiteId)) {
    return { outcome: 'forbidden', reason: 'target_site_denied', message: 'Access to this site denied' };
  }
  return { outcome: 'ready', targetSiteName: targetSite.name ?? null };
}

/**
 * Phase 2 — the move itself, after {@link prepareDeviceSiteMove} returned `ready`.
 *
 * `updates` / `customFieldWrites` let PATCH write its other columns (displayName, tags, …) and its
 * custom-field values in the SAME savepoint, so a guarded-UPDATE conflict rolls all of them back
 * with the move. `groupFilterFields` are the non-site fields those updates touched; `siteId` is
 * appended (it makes the worker re-evaluate every dynamic group, which a move needs).
 * `changedFields` is the `device.update` audit's list.
 *
 * Throws on any unexpected error (a deadlock, a trigger) — never swallowed here, so the caller's
 * transaction rolls back and the caller reports it.
 */
export async function executeDeviceSiteMove(args: {
  device: SiteMoveDevice;
  permissions: UserPermissions | undefined;
  toSiteId: string;
  targetSiteName: string | null;
  expectedSiteId: string | null | undefined;
  trigger: SiteMoveTrigger;
  updates?: Record<string, unknown>;
  customFieldWrites?: CustomFieldValueWrite[];
  groupFilterFields?: string[];
  changedFields: string[];
  reevaluationReason: string;
  audit: SiteMoveAuditSink;
  /**
   * `inline` (PATCH, unchanged): schedule peripheral reconciliation here, inside the caller's
   * transaction. `caller` (bulk): the caller schedules it once the device's own transaction has
   * committed, so a rolled-back move never queues a job. Default `inline`.
   */
  peripheralReconciliation?: 'inline' | 'caller';
}): Promise<SiteMoveMoved | SiteMoveConflict> {
  const { device, permissions, toSiteId } = args;
  const deviceId = device.id;
  const customFieldWrites = args.customFieldWrites ?? [];

  // Site-move concurrency guard (S§12.1), before ANY write: lock the device row and re-read its
  // site. A concurrent move that committed after the caller's access check makes this read return
  // the new site (READ COMMITTED re-reads the latest version once the lock is granted), so the
  // loser gets a conflict instead of silently overwriting the winner — and none of this move's
  // writes (custom fields included) happen. The lock is held until the caller's transaction
  // commits, so the guarded UPDATE below cannot lose the row in between.
  // devices alone: a joined relation would keep its pre-wait row in the post-lock recheck and drop the row.
  const [locked] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .for('update');
  if (!locked || locked.siteId !== device.siteId) {
    return conflict(permissions, locked?.siteId);
  }
  const [sourceSite] = await db.select({ name: sites.name }).from(sites).where(eq(sites.id, device.siteId)).limit(1);
  const sourceSiteName = sourceSite?.name ?? null;
  // Under the row lock and before the UPDATE (whose trigger deletes the presence row).
  const suggestion = args.trigger === 'topology_suggestion'
    ? await readSuggestionEvidence(deviceId, device.siteId, toSiteId)
    : undefined;

  // The denormalized `site_id` on every DEVICE_SITE_DENORMALIZED_TABLES entry (current-epoch rows)
  // must be rewritten in the SAME transaction as the devices row flip — otherwise child rows (e.g.
  // elevation_requests) stay pinned under the OLD site_id and drift out of site-visibility scoping.
  // The proxied `db` resolves to the caller's context transaction via AsyncLocalStorage, so this
  // opens a savepoint within it. breeze_topology_inventory_lifecycle detaches the old current
  // binding BEFORE the device UPDATE, so the generic loop cannot drag historical topology nodes,
  // manual facts or pins into the destination site. The UPDATE is guarded on the site read at the
  // access check (S§12.1): zero rows means the device moved under us, and the savepoint rolls back
  // before the denormalized loop runs.
  const updates: Record<string, unknown> = { updatedAt: new Date(), ...args.updates, siteId: toSiteId };
  let updated: typeof devices.$inferSelect | undefined;
  try {
    await db.transaction(async (tx) => {
      // Same connection as the savepoint, so a GuardedUpdateConflict below rolls these back too.
      if (customFieldWrites.length > 0) {
        await persistDeviceCustomFieldValues(deviceId, device.orgId, customFieldWrites, 'manual');
      }
      const [row] = await tx
        .update(devices)
        .set(updates)
        .where(and(eq(devices.id, deviceId), eq(devices.siteId, device.siteId)))
        .returning();
      if (!row) throw new GuardedUpdateConflict();
      updated = row;

      await rewriteDeviceSiteDenormalizedTables(tx, deviceId, toSiteId);
    });
  } catch (error) {
    if (!(error instanceof GuardedUpdateConflict)) throw error;
    const [current] = await db.select({ siteId: devices.siteId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
    return conflict(permissions, current?.siteId);
  }
  const moved = updated!;

  // Dynamic groups store membership, so a rule on any field this move wrote is stale until a
  // re-evaluation runs (#8832). Registered after the state change is final (commit-only).
  requestDeviceGroupReevaluationAfterCommit({
    deviceId,
    orgId: device.orgId,
    eventType: 'device.updated',
    changedFields: [...(args.groupFilterFields ?? []), 'siteId'],
    reason: args.reevaluationReason,
  });

  if ((args.peripheralReconciliation ?? 'inline') === 'inline') {
    await schedulePeripheralPolicyDevice(deviceId, 'device_site_changed').catch((error) => {
      console.error(`[devices] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
    });
  }

  const resourceName = moved.hostname ?? moved.displayName ?? device.hostname;
  args.audit({
    orgId: device.orgId,
    action: 'device.update',
    resourceType: 'device',
    resourceId: moved.id ?? deviceId,
    resourceName,
    details: { changedFields: args.changedFields },
  });
  // The semantic move audit (S§12.4). Handed to the caller's sink, which decides WHEN it is
  // persisted: PATCH writes it during the request, as it always has; the bulk route buffers both
  // entries and writes them only after that device's own transaction has committed.
  args.audit({
    orgId: device.orgId,
    action: 'device.site_move',
    resourceType: 'device',
    resourceId: moved.id ?? deviceId,
    resourceName,
    details: siteMoveAuditDetails({ from: device.siteId, fromName: sourceSiteName, to: toSiteId, toName: args.targetSiteName,
      expectedSiteId: args.expectedSiteId ?? null, trigger: args.trigger, suggestion }),
  });

  return { outcome: 'moved', fromSiteId: device.siteId, device: moved };
}

/**
 * Prepare + execute for a plain site move (no other columns, no custom fields) — the bulk route's
 * per-device call. Run it inside the caller's own DB access context, after the caller authorized
 * `device` through getDeviceWithOrgAndSiteCheck in that same context.
 */
export async function moveDeviceToSite(args: {
  device: SiteMoveDevice;
  permissions: UserPermissions | undefined;
  toSiteId: string;
  expectedSiteId: string | null | undefined;
  trigger: SiteMoveTrigger;
  reevaluationReason: string;
  audit: SiteMoveAuditSink;
  peripheralReconciliation?: 'inline' | 'caller';
}): Promise<SiteMoveResult> {
  const prepared = await prepareDeviceSiteMove(args);
  if (prepared.outcome !== 'ready') return prepared;
  return executeDeviceSiteMove({ ...args, targetSiteName: prepared.targetSiteName, changedFields: ['siteId'] });
}
