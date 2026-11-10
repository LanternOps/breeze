import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PortalSignInCapabilities } from '@breeze/shared';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { auditLogs, organizations } from '../db/schema';
import { writeAuditEventAsync, type AuthContext, type RouteAuditInput } from './auditEvents';
import {
  getPortalSignInCapabilities,
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
 *    and no newer `…password_fallback_dismissed` row exists. Proving the tenant
 *    again ends it, as does a dismissal; a later loss writes a newer fallback
 *    row and raises it again.
 *
 * Both rows are `resourceType: 'organization'` with `resourceId` = the org, so
 * the notice read is served by `audit_logs (resource_type, resource_id,
 * timestamp DESC)` and scans only the org's own organization-typed rows. The
 * notice lasts as long as audit retention keeps the fallback row.
 */

export const AUDIT_PORTAL_PASSWORD_FALLBACK = 'organization.portal_sign_in.password_fallback';
export const AUDIT_PORTAL_PASSWORD_FALLBACK_DISMISSED = 'organization.portal_sign_in.password_fallback_dismissed';

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
 */
export function passwordFallbackImpactFrom(
  rows: PortalAccessPolicyOwnerRows,
  caps: PortalSignInCapabilities,
): PortalPasswordFallbackImpact | null {
  const withProof = pickEffectivePortalAccessPolicy(rows.org, rows.partner, caps, { entraTenantProven: true });
  if (!withProof.effective.entraEnabled.value) return null;
  const withoutProof = pickEffectivePortalAccessPolicy(rows.org, rows.partner, caps, { entraTenantProven: false });
  return { passwordModeFallback: withoutProof.passwordModeFallback };
}

/**
 * {@link passwordFallbackImpactFrom} for one org, read under the held DB context
 * (RLS lets an org-reaching context read both policy rows, W3 D7), else under a
 * fresh system context. An org that cannot be read → null.
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
  return rows ? passwordFallbackImpactFrom(rows, getPortalSignInCapabilities()) : null;
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
 * on for the org). Awaited — the write commits on its own connection and never
 * rejects (a failed write goes to the audit retry queue) — so the notice is
 * there for the UI's next read. Call it only after the proof is gone.
 */
export async function auditPortalPasswordFallback(
  c: AuthContext,
  input: { orgId: string; tenantId: string; cause: PortalPasswordFallbackCause },
): Promise<void> {
  const impact = await getPortalPasswordFallbackImpact(input.orgId);
  if (!impact) return;
  const user = c.get('auth')?.user;
  await writeAuditEventAsync(c, {
    ...portalPasswordFallbackAuditEvent(input.orgId, input.tenantId, input.cause, impact),
    actorId: user?.id,
    actorEmail: user?.email,
  });
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
    const [latest] = await db.select({ action: auditLogs.action, timestamp: auditLogs.timestamp, details: auditLogs.details })
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
  const latest = hasDbAccessContext() ? await read() : await withSystemDbAccessContext(read, 'portalPasswordFallback.notice');
  const notice = passwordFallbackNoticeFrom(latest);
  if (!notice) return null;
  // Microsoft turned off for the org since: it is no longer falling back from anything.
  return (await getPortalPasswordFallbackImpact(orgId)) ? notice : null;
}
