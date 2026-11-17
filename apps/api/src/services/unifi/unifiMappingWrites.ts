import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { sites } from '../../db/schema';
import { writeRouteAudit, type AuthContext as RouteAuditCtx } from '../auditEvents';
import type { AuthContext as RequestAuth } from '../../middleware/auth';
import type { OrgMatchTier } from '../externalTenantMapping';
import type { UnifiCollectorAuthority, UnifiMappingSnapshot } from '../topology/unifiAuthority';
import { isHoldingOrg } from '../unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from '../unassignedPool/orgType';

// Shared write-side helpers for the UniFi mapping and controller routes:
// target authorization (one place, so the bulk accept route of W03 runs the same
// gate as PUT /unifi/mappings) and the audit trail of every mapping change.

export type UnifiMappingTargetError = { status: 400 | 403 | 409; message: string; code?: string };

/**
 * Resolve and authorize EVERY target Breeze site before any write. Doing this
 * per write would leave earlier mappings persisted when a later cross-org entry
 * hits the 403, so the client would see a failure on a partially-applied batch.
 * Targets come back in item order.
 */
export async function resolveUnifiMappingTargets(
  auth: Pick<RequestAuth, 'canAccessOrg'>,
  partnerId: string,
  items: ReadonlyArray<{ siteId: string }>,
): Promise<{ ok: true; targets: Array<{ orgId: string; siteId: string }> } | { ok: false; error: UnifiMappingTargetError }> {
  const targets: Array<{ orgId: string; siteId: string }> = [];
  for (const item of items) {
    const [site] = await db
      .select({
        id: sites.id,
        orgId: sites.orgId,
        partnerId: sql<string | null>`(SELECT o.partner_id FROM organizations o WHERE o.id = ${sites.orgId})`,
      })
      .from(sites)
      .where(eq(sites.id, item.siteId))
      .limit(1);
    if (!site) return { ok: false, error: { status: 400, message: `Unknown Breeze site: ${item.siteId}` } };
    if (!auth.canAccessOrg(site.orgId)) {
      return { ok: false, error: { status: 403, message: 'Access to target organization denied' } };
    }
    // The site must belong to the connection's own partner. canAccessOrg is
    // true for system scope, so without this a platform admin acting for one
    // partner could map another partner's site.
    if (site.partnerId !== partnerId) {
      return { ok: false, error: { status: 403, message: 'Target site does not belong to this partner' } };
    }
    // canAccessOrg is true for system scope: the holding org is never a target.
    if (await isHoldingOrg(site.orgId)) {
      return { ok: false, error: { status: 409, message: PROTECTED_ORG_ERROR.error, code: PROTECTED_ORG_ERROR.code } };
    }
    targets.push({ orgId: site.orgId, siteId: site.id });
  }
  return { ok: true, targets };
}

export interface UnifiMappingChange {
  action: 'unifi.site.map' | 'unifi.site.unmap';
  unifiHostId: string;
  unifiSiteId: string;
  /** The org the audit row is filed under: the new org for a map, the previous org for an unmap. */
  orgId: string;
  /** The new Breeze site; null for an unmap. */
  siteId: string | null;
  previousOrgId: string | null;
  previousSiteId: string | null;
}

export interface UnifiMappingAuditMeta {
  source: 'manual' | 'suggestion' | 'bulk_suggestion';
  sourceVerified: boolean;
  matchTier: OrgMatchTier | null;
  matchKey: string | null;
}

const mappingKey = (m: { unifiHostId: string; unifiSiteId: string }) => JSON.stringify([m.unifiHostId, m.unifiSiteId]);

/**
 * Keyed by host and site (a UniFi site id is only unique within its host). A new
 * row, or one whose org or site changed, is a map; a removed row is an unmap.
 * Maps come first, in `after` order, then unmaps in `before` order.
 */
export function diffUnifiMappings(before: UnifiMappingSnapshot[], after: UnifiMappingSnapshot[]): UnifiMappingChange[] {
  const beforeByKey = new Map(before.map((m) => [mappingKey(m), m]));
  const afterKeys = new Set(after.map(mappingKey));
  const changes: UnifiMappingChange[] = [];
  for (const now of after) {
    const old = beforeByKey.get(mappingKey(now));
    if (old && old.orgId === now.orgId && old.siteId === now.siteId) continue;
    changes.push({
      action: 'unifi.site.map',
      unifiHostId: now.unifiHostId,
      unifiSiteId: now.unifiSiteId,
      orgId: now.orgId,
      siteId: now.siteId,
      previousOrgId: old?.orgId ?? null,
      previousSiteId: old?.siteId ?? null,
    });
  }
  for (const old of before) {
    if (afterKeys.has(mappingKey(old))) continue;
    changes.push({
      action: 'unifi.site.unmap',
      unifiHostId: old.unifiHostId,
      unifiSiteId: old.unifiSiteId,
      orgId: old.orgId,
      siteId: null,
      previousOrgId: old.orgId,
      previousSiteId: old.siteId,
    });
  }
  return changes;
}

/** One audit row per changed mapping, filed under the org that gained (map) or lost (unmap) the site. */
export function writeUnifiMappingAudits(
  c: RouteAuditCtx,
  integrationId: string,
  changes: UnifiMappingChange[],
  meta: (change: UnifiMappingChange) => UnifiMappingAuditMeta,
): void {
  for (const change of changes) {
    writeRouteAudit(c, {
      orgId: change.orgId,
      action: change.action,
      resourceType: 'unifi_site_mapping',
      resourceName: `${change.unifiHostId}/${change.unifiSiteId}`,
      details: {
        integrationId,
        unifiHostId: change.unifiHostId,
        unifiSiteId: change.unifiSiteId,
        orgId: change.orgId,
        siteId: change.siteId,
        previousOrgId: change.previousOrgId,
        previousSiteId: change.previousSiteId,
        ...meta(change),
      },
    });
  }
}

export interface UnifiCollectorChange {
  action: 'unifi.controller.register' | 'unifi.controller.remove';
  /** The row after a register, the row before a remove. */
  collector: UnifiCollectorAuthority;
}

const collectorChanged = (a: UnifiCollectorAuthority, b: UnifiCollectorAuthority) =>
  a.orgId !== b.orgId || a.siteId !== b.siteId || a.unifiHostId !== b.unifiHostId
  || a.collectorDeviceId !== b.collectorDeviceId || a.controllerUrl !== b.controllerUrl;

/** New or re-pointed collectors are registers (in `after` order), then removed ones (in `before` order). */
export function diffUnifiCollectors(before: UnifiCollectorAuthority[], after: UnifiCollectorAuthority[]): UnifiCollectorChange[] {
  const beforeById = new Map(before.map((row) => [row.id, row]));
  const afterIds = new Set(after.map((row) => row.id));
  const changes: UnifiCollectorChange[] = [];
  for (const now of after) {
    const old = beforeById.get(now.id);
    if (!old || collectorChanged(old, now)) changes.push({ action: 'unifi.controller.register', collector: now });
  }
  for (const old of before) {
    if (!afterIds.has(old.id)) changes.push({ action: 'unifi.controller.remove', collector: old });
  }
  return changes;
}

// The audit names the controller by host only: the path and query of a stored
// URL are not needed to identify it, and the API key never enters the audit.
function controllerHost(controllerUrl: string): string | null {
  try {
    return new URL(controllerUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * Audit controller register and remove. `rewrittenCollectorId` names the
 * collector a register PUT just upserted: every such PUT re-encrypts the
 * submitted API key, so it is audited even when no snapshot column changed.
 */
export function writeUnifiControllerAudits(
  c: RouteAuditCtx,
  integrationId: string,
  before: UnifiCollectorAuthority[],
  after: UnifiCollectorAuthority[],
  rewrittenCollectorId?: string,
): void {
  const changes = diffUnifiCollectors(before, after);
  if (rewrittenCollectorId && !changes.some((ch) => ch.collector.id === rewrittenCollectorId)) {
    const rewritten = after.find((row) => row.id === rewrittenCollectorId);
    if (rewritten) changes.push({ action: 'unifi.controller.register', collector: rewritten });
  }
  for (const { action, collector } of changes) {
    const host = controllerHost(collector.controllerUrl);
    writeRouteAudit(c, {
      orgId: collector.orgId,
      action,
      resourceType: 'unifi_collector',
      resourceId: collector.id,
      resourceName: host,
      details: {
        integrationId,
        collectorId: collector.id,
        transport: 'agent',
        controllerHost: host,
        siteId: collector.siteId,
        collectorDeviceId: collector.collectorDeviceId,
        unifiHostId: collector.unifiHostId,
      },
    });
  }
}
