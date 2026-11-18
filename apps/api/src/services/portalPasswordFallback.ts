import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { PortalSignInCapabilities } from '@breeze/shared';
import { db, hasDbAccessContext, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs, organizations } from '../db/schema';
import { writeAuditEventAsync, type AuthContext, type RouteAuditInput } from './auditEvents';
import { captureException } from './sentry';
import {
  getPortalSignInCapabilities,
  listOrgVerifiedDomains,
  pickedGoogleEnabled,
  pickEffectivePortalAccessPolicy,
  readPortalAccessPolicyRows,
  type PortalAccessPolicyOwnerRows,
} from './portalAccessPolicy';

/**
 * The portal password fallback, made visible (#11582, part of #11377).
 *
 * W4 D2 masks Microsoft sign-in off for an org whose Entra tenant is no longer
 * proven: Microsoft sessions die and an `sso_only` org falls back to password,
 * so nobody is locked out by an MSP-side mistake. That fallback is unchanged.
 * This module only makes it visible:
 *  - one `organization.portal_sign_in.password_fallback` audit row on the org
 *    when a PROVEN tenant is lost while Microsoft sign-in was on for it. Every
 *    path that loses a proof writes it: the MSP removal route, the AI for
 *    Office mapping delete and repoint, and displacement by another org's
 *    proof run (`recordEntraTenantProof`);
 *  - an admin notice derived from that row (no column of its own): it holds
 *    while the org's tenant is unproven, Microsoft is still on for the org,
 *    and neither a `…password_fallback_dismissed` row nor a tenant proof
 *    (`organization.portal_identity_proof.proven`) is newer than it. A later
 *    loss writes a newer fallback row and raises it again.
 *
 * Both rows are `resourceType: 'organization'` with `resourceId` = the org, so
 * the notice read is served by `audit_logs (resource_type, resource_id,
 * timestamp DESC)` and scans only the org's own organization-typed rows. The
 * notice lasts as long as audit retention keeps the fallback row.
 */

export const AUDIT_PORTAL_PASSWORD_FALLBACK = 'organization.portal_sign_in.password_fallback';
export const AUDIT_PORTAL_PASSWORD_FALLBACK_DISMISSED = 'organization.portal_sign_in.password_fallback_dismissed';
/** Written by recordEntraTenantProof (portalEntraTenantProof.ts) on every proof. */
const AUDIT_TENANT_PROVEN = 'organization.portal_identity_proof.proven';

export const PORTAL_PASSWORD_FALLBACK_CAUSES = [
  /** MSP › Sign-in & registration › Remove tenant link (`DELETE …/portal-entra-tenant`). */
  'tenant_removed',
  /** AI for Office `DELETE /client-ai/admin/orgs/:orgId/tenant-mapping` (the proof shares that row, D1). */
  'ai_for_office_mapping_removed',
  /** AI for Office `PUT …/tenant-mapping` to another tenant: the repoint trigger clears the proof (inv. 3). */
  'ai_for_office_mapping_changed',
  /** Another org's proof run took the tenant (D7). */
  'tenant_displaced',
] as const;
export type PortalPasswordFallbackCause = typeof PORTAL_PASSWORD_FALLBACK_CAUSES[number];

/** What losing the proof did to the org's portal sign-in. */
export interface PortalPasswordFallbackImpact {
  /** The org's picked password mode was `sso_only` and no SSO method is left, so password sign-in is back. */
  passwordModeFallback: boolean;
}

/** The admin notice on the org's Entra tenant status (`GET …/portal-entra-tenant` → `passwordFallback`). */
export interface PortalPasswordFallbackNotice {
  /** When the fallback took effect (the audit row's timestamp, ISO). */
  since: string;
  /** The tenant whose proof was lost, when the row names one. */
  tenantId: string | null;
  cause: PortalPasswordFallbackCause | null;
}

/**
 * Pure: whether losing the proof changes anything for the org. Microsoft must be
 * effectively on WITH a proof (picked on, and a capability of this deployment),
 * else there was no Microsoft sign-in to fall back from → null.
 *
 * W7 (#11384, plan D6): both picks carry the org's real Google fact, so only
 * the Entra proof differs between them. A fallback the Google domain mask
 * causes on its own (Microsoft off) is null here: it is never reported as a
 * lost Microsoft tenant.
 */
export function passwordFallbackImpactFrom(
  rows: PortalAccessPolicyOwnerRows,
  caps: PortalSignInCapabilities,
  facts: { googleDomainVerified: boolean },
): PortalPasswordFallbackImpact | null {
  const { googleDomainVerified } = facts;
  const withProof = pickEffectivePortalAccessPolicy(rows.org, rows.partner, caps, { entraTenantProven: true, googleDomainVerified });
  if (!withProof.effective.entraEnabled.value) return null;
  const withoutProof = pickEffectivePortalAccessPolicy(rows.org, rows.partner, caps, { entraTenantProven: false, googleDomainVerified });
  return { passwordModeFallback: withoutProof.passwordModeFallback };
}

/**
 * {@link passwordFallbackImpactFrom} for one org, read under the held DB context
 * (RLS lets an org-reaching context read both policy rows, W3 D7), else under a
 * fresh system context. An org that cannot be read → null.
 *
 * W7 D6: the org's Google fact comes from W5's read API, under the resolver's
 * guard (picked Google on and the deployment can run it) and context rule
 * (listOrgVerifiedDomains: direct with none or a system context held, else
 * through runOutsideDbContext). A W5 failure propagates.
 */
export async function getPortalPasswordFallbackImpact(orgId: string): Promise<PortalPasswordFallbackImpact | null> {
  const read = async () => {
    const [org] = await db.select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return null;
    return readPortalAccessPolicyRows({ orgId, partnerId: org.partnerId });
  };
  const rows = hasDbAccessContext() ? await read() : await withSystemDbAccessContext(read, 'portalPasswordFallback.impact');
  if (!rows) return null;
  const caps = getPortalSignInCapabilities();
  const googleDomainVerified = caps.google && pickedGoogleEnabled(rows.org, rows.partner)
    ? (await listOrgVerifiedDomains(orgId)).length > 0
    : false;
  return passwordFallbackImpactFrom(rows, caps, { googleDomainVerified });
}

/** The fallback audit row's fields (the caller adds the actor). */
export function portalPasswordFallbackAuditEvent(
  orgId: string,
  tenantId: string,
  cause: PortalPasswordFallbackCause,
  impact: PortalPasswordFallbackImpact,
): RouteAuditInput & { orgId: string; resourceId: string; details: Record<string, unknown> } {
  return {
    orgId,
    action: AUDIT_PORTAL_PASSWORD_FALLBACK,
    resourceType: 'organization',
    resourceId: orgId,
    resourceName: tenantId,
    // Not `passwordModeFallback`: the audit writer redacts any key containing "password".
    details: { tenantId, cause, ssoOnlyLifted: impact.passwordModeFallback },
  };
}

/**
 * Route sites: audits the fallback when the lost proof mattered (Microsoft was
 * on for the org). Call it only after the proof is gone. It never throws: the
 * row is advisory, so a failed policy read or write is logged and reported
 * rather than failing an admin action whose change already happened.
 *  - No DB context held (the MSP removal route, whose delete has committed on
 *    its own connection): awaited, so the notice is there for the UI's next read.
 *  - Inside a request transaction (the AI for Office routes): deferred until
 *    that transaction COMMITS, so a rolled-back change never leaves a row
 *    claiming the proof was lost.
 * The impact read always runs on its own system-scope connection, so a failure
 * there cannot poison a request transaction.
 */
export async function auditPortalPasswordFallback(
  c: AuthContext,
  input: { orgId: string; tenantId: string; cause: PortalPasswordFallbackCause },
): Promise<void> {
  const write = async () => {
    try {
      const impact = await runOutsideDbContext(() => getPortalPasswordFallbackImpact(input.orgId));
      if (!impact) return;
      const user = c.get('auth')?.user;
      // Never rejects: a failed insert goes to the audit retry queue (auditService).
      await writeAuditEventAsync(c, {
        ...portalPasswordFallbackAuditEvent(input.orgId, input.tenantId, input.cause, impact),
        actorId: user?.id,
        actorEmail: user?.email,
      });
    } catch (err) {
      console.error('[portalPasswordFallback] fallback audit failed', { orgId: input.orgId, cause: input.cause }, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  };
  if (hasDbAccessContext()) {
    runAfterDbContextCommit('portalPasswordFallback.audit', write);
    return;
  }
  await write();
}

function isCause(value: unknown): value is PortalPasswordFallbackCause {
  return typeof value === 'string' && (PORTAL_PASSWORD_FALLBACK_CAUSES as readonly string[]).includes(value);
}

/** Pure: the notice the org's newest fallback / dismissal row asks for. */
export function passwordFallbackNoticeFrom(
  latest: { action: string; timestamp: Date; details: unknown } | undefined,
): PortalPasswordFallbackNotice | null {
  if (!latest || latest.action !== AUDIT_PORTAL_PASSWORD_FALLBACK) return null;
  const details = latest.details && typeof latest.details === 'object' ? latest.details as Record<string, unknown> : {};
  return {
    since: latest.timestamp.toISOString(),
    tenantId: typeof details.tenantId === 'string' ? details.tenantId : null,
    cause: isCause(details.cause) ? details.cause : null,
  };
}

/**
 * The org's password-fallback notice, or null. `tenantProven` is the caller's
 * read of the tenant status: a proven tenant ends the notice without a query.
 * Reads under the held context, else system.
 */
export async function getPortalPasswordFallbackNotice(
  orgId: string,
  tenantProven: boolean,
): Promise<PortalPasswordFallbackNotice | null> {
  if (tenantProven) return null;
  const read = async () => {
    const [latest] = await db.select({ id: auditLogs.id, action: auditLogs.action, timestamp: auditLogs.timestamp, details: auditLogs.details })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.resourceType, 'organization'),
        eq(auditLogs.resourceId, orgId),
        eq(auditLogs.orgId, orgId),
        inArray(auditLogs.action, [AUDIT_PORTAL_PASSWORD_FALLBACK, AUDIT_PORTAL_PASSWORD_FALLBACK_DISMISSED]),
      ))
      .orderBy(desc(auditLogs.timestamp))
      .limit(1);
    return latest;
  };
  /**
   * A proof recorded after the fallback ended it, even if that proof was lost
   * again later with Microsoft off (no new fallback row): otherwise the old row
   * would resurface with a stale date and cause. Bounded by
   * `audit_logs (org_id, timestamp DESC)` to rows since the fallback. The
   * bound is the fallback row's own stored timestamp (a subquery), not a JS
   * Date, which would truncate the microseconds and misorder close rows.
   */
  const provenSince = async (fallbackId: string) => {
    const [row] = await db.select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.orgId, orgId),
        eq(auditLogs.action, AUDIT_TENANT_PROVEN),
        // Spelled as text: drizzle would qualify the inner columns as "audit_logs".x,
        // which reads like a reference to the outer row (#9692).
        gt(auditLogs.timestamp, sql`(select "fb"."timestamp" from "audit_logs" "fb" where "fb"."id" = ${fallbackId})`),
      ))
      .limit(1);
    return row !== undefined;
  };
  const inContext = <T>(label: string, work: () => Promise<T>) =>
    hasDbAccessContext() ? work() : withSystemDbAccessContext(work, label);
  const latest = await inContext('portalPasswordFallback.notice', read);
  const notice = passwordFallbackNoticeFrom(latest);
  if (!notice || !latest) return null;
  if (await inContext('portalPasswordFallback.noticeProven', () => provenSince(latest.id))) return null;
  // Microsoft turned off for the org since: it is no longer falling back from anything.
  return (await getPortalPasswordFallbackImpact(orgId)) ? notice : null;
}
