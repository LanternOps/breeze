/**
 * SLA definition site/device-axis scoping — shared by the AI tool layer
 * (`query_analytics`) and the HTTP routes (`GET /analytics/sla`,
 * `GET /analytics/sla/:id/compliance`).
 *
 * An SLA definition is site-attributable: `sla_definitions.target_type` may be
 * `'site'` or `'device'` with `target_ids` naming the concrete targets
 * (`db/schema/analytics.ts`). Both surfaces filtered on `org_id` only, so a
 * site-restricted technician read compliance figures — and the target site /
 * device UUIDs themselves — for parts of the org they cannot reach. Site is an
 * app-layer axis; Postgres RLS does not defend it.
 *
 * Deliberately a dependency-free leaf module (types only), like
 * `siteCeilingAccess.ts`, so routes and services share ONE implementation
 * without either pulling in the other's module graph.
 */
import type { AuthContext } from '../middleware/auth';

export type SlaScopeAuth = Pick<AuthContext, 'canAccessSite'> &
  Partial<Pick<AuthContext, 'allowedSiteIds' | 'allowedDeviceIds'>>;

export interface SlaTargetShape {
  targetType: string | null;
  targetIds: string[] | null;
}

/**
 * True when a narrowed caller must not see this SLA definition (nor any
 * compliance row computed from it).
 *
 * - Org-wide definitions (no `targetType`, or one that is neither `site` nor
 *   `device`) stay visible: they are an org aggregate the caller already has
 *   org access to, and there is nothing site-specific to strip.
 * - A `site`/`device` definition is visible only when the caller can reach
 *   EVERY one of its targets — its figures aggregate across all of them, so a
 *   partial reach makes them unattributable (same rule as a deployment's
 *   member devices).
 * - A narrowed target with no `targetIds` is unattributable and fails closed.
 *
 * `allowedDeviceIds` is the caller's resolved device allowlist — the
 * intersection of both axes from `resolveSiteAllowedDeviceIds`. For a NARROWED
 * caller `null` means "could not be resolved" and denies; the two values are
 * never interchangeable and callers must pass `[]`, not `null`, when a narrowed
 * caller has no org to resolve devices against.
 */
export function slaDefinitionOutOfScope(
  auth: SlaScopeAuth,
  def: SlaTargetShape,
  allowedDeviceIds: string[] | null,
): boolean {
  const siteRestricted = auth.allowedSiteIds !== undefined;
  const deviceRestricted = auth.allowedDeviceIds !== undefined;
  if (!siteRestricted && !deviceRestricted) return false;

  const type = (def.targetType ?? '').toLowerCase();
  if (type !== 'site' && type !== 'device') return false;

  const ids = def.targetIds ?? [];
  if (ids.length === 0) return true;

  if (type === 'site') {
    // A device-bound run has no site axis to satisfy: a site-wide SLA reaches
    // siblings it may not see, so it fails closed rather than falling through.
    if (deviceRestricted) return true;
    if (!auth.canAccessSite) return true;
    return !ids.every((id) => auth.canAccessSite!(id));
  }

  // Reaching here means the caller IS narrowed (checked above) and the
  // definition names concrete devices. `null` says the caller's device set
  // could not be resolved — the callers pass it when they have no orgId to
  // resolve against — which is not attributable and must fail closed. Reading
  // it as "unrestricted" collapsed null and [] into the same answer and let a
  // narrowed caller read out-of-scope compliance figures (review #6110).
  if (allowedDeviceIds === null) return true;
  const allowed = new Set(allowedDeviceIds);
  return !ids.every((id) => allowed.has(id));
}

/** True when the caller carries either narrowing axis (and so needs the gate). */
export function slaScopeNarrowed(auth: SlaScopeAuth): boolean {
  return auth.allowedSiteIds !== undefined || auth.allowedDeviceIds !== undefined;
}
