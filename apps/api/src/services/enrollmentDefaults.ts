import { eq } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { organizations, partners } from '../db/schema/orgs';
import { resolveEnrollmentDefaults, type ResolvedEnrollmentDefaults } from '@breeze/shared';

/** Pulls `settings.defaults` out of a JSONB settings blob, tolerating any shape. */
function extractSettingsDefaults(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {};
  const defaults = (settings as Record<string, unknown>).defaults;
  return defaults && typeof defaults === 'object' ? (defaults as Record<string, unknown>) : {};
}

/**
 * Resolve the effective enrollment link defaults (TTL, device count, TTL cap)
 * for an org, joined against its partner in a single query.
 *
 * Deliberately does NOT go through getEffectiveOrgSettings: that service's
 * mergeCategory makes partner fields win unconditionally and locks them, which
 * is the correct model for most settings but wrong for these two
 * inherit-with-override values (org wins when set, partner fills the gap) plus
 * one partner-only cap. Same reason getOrgAgentUpdateConfig
 * (apps/api/src/routes/agents/helpers.ts) exists as its own resolver instead of
 * routing through the generic merge.
 *
 * Read in a SYSTEM context, exited from any ambient request context first
 * (fix round 1, #2776): `partners`' SELECT policy is
 * `breeze_has_partner_access(id)`, and `computeAccessiblePartnerIds` returns
 * `[]` for an org-scoped caller (apps/api/src/middleware/auth.ts) — the exact
 * scope every route calling this (via assertTtlWithinCap) runs under. Under
 * the request's own RLS context the `partners` leftJoin would silently return
 * null, `maxTtlMinutes` would fall back to the permissive global default, and
 * the cap would be inert for precisely the population it exists to bind.
 * `withSystemDbAccessContext` alone is not enough here: inside an active
 * request context it is a no-op that inherits the caller's scope, so
 * `runOutsideDbContext` must exit that context first (same pattern as
 * `resolveQuoteTaxRate` in quoteService.ts and `readPartnerAllowlist`'s
 * caller in ipAllowlist.ts). The lookup stays keyed on the caller-supplied
 * `orgId` alone — escaping RLS here widens visibility of settings columns,
 * not which org's row can be selected.
 *
 * AVAILABILITY (fix round 4, #2776): that escape is taken ONLY when it is
 * actually needed. `withDbAccessContext` opens a real `baseDb.transaction`
 * (db/index.ts), so it pins one pooled connection for the whole callback, and
 * `runOutsideDbContext` exits the AsyncLocalStorage store — meaning the nested
 * `withSystemDbAccessContext` does NOT nest, it opens a SECOND transaction on a
 * SECOND pooled connection while the first is still held. Every caller that is
 * already inside a system context (POST /installer/bootstrap, GET /s/:code,
 * GET /public-download/:platform, every redemption path) would therefore
 * double-hold connections for no benefit: `partners` is fully visible in a
 * system context already. At N concurrent enrollments >= DB_POOL_MAX every
 * connection ends up held by a request queued for a connection only a peer can
 * release, and postgres-js has no acquire timeout (`connect_timeout` governs TCP
 * connect, not queue wait) — so the API stalls indefinitely, not just slowly. A
 * few hundred agents deployed from one installer link reaches that trivially.
 * When the ambient context is already system-scoped we therefore read in it;
 * only org/partner-scoped (and contextless) callers pay the extra connection,
 * and for them it is mandatory, not optional.
 */
export async function getEnrollmentDefaultsForOrg(orgId: string): Promise<ResolvedEnrollmentDefaults> {
  // LEFT JOIN so a missing partner (shouldn't happen) still returns the org row
  // and falls back to org-local settings rather than dropping the whole lookup.
  const readJoin = () =>
    db
      .select({ orgSettings: organizations.settings, partnerSettings: partners.settings })
      .from(organizations)
      .leftJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(organizations.id, orgId))
      .limit(1);

  // `getCurrentDbAccessContext()` reflects the GUCs actually SET LOCAL on the
  // held transaction: withDbAccessContext is a no-op when a context is already
  // active (it neither reopens a transaction nor re-sets the metadata), so a
  // reported scope of 'system' means the session really is running with
  // breeze.scope = 'system' and `breeze_has_partner_access` short-circuits true.
  // Anything else — including no context at all — takes the escape.
  const ambientScope = getCurrentDbAccessContext()?.scope;
  const rows = ambientScope === 'system'
    ? await readJoin()
    : await runOutsideDbContext(() => withSystemDbAccessContext(readJoin));
  const [row] = rows;

  const orgDefaults = extractSettingsDefaults(row?.orgSettings);
  const partnerDefaults = extractSettingsDefaults(row?.partnerSettings);

  return resolveEnrollmentDefaults(partnerDefaults, orgDefaults);
}

/**
 * Reject — never clamp — an explicitly-requested TTL above the partner
 * ceiling. Silently reducing a chosen expiry is precisely the failure mode
 * of #2775; a 400 that names the cap is the only honest response.
 *
 * Returns null (no violation) when `ttlMinutes` is undefined: an omitted TTL
 * falls back to the resolved default, and `resolveEnrollmentDefaults` already
 * clamps that default to the cap, so there is nothing to reject here — that
 * case is a different bypass (a stale/lock-exempt org default landing above
 * the cap), closed at the resolver, not at this gate.
 *
 * Shared across every route that mints an enrollment link / bootstrap token
 * with a caller-supplied ttlMinutes (enrollmentKeys.ts, devices/core.ts) so
 * the cap can't be bypassed by a route that forgets to call it independently.
 */
export async function assertTtlWithinCap(
  orgId: string,
  ttlMinutes: number | undefined,
): Promise<string | null> {
  if (ttlMinutes === undefined) return null;
  const { maxTtlMinutes } = await getEnrollmentDefaultsForOrg(orgId);
  if (ttlMinutes > maxTtlMinutes) {
    return `ttlMinutes exceeds the partner maximum of ${maxTtlMinutes} minutes`;
  }
  return null;
}

/**
 * Clamp — never reject — a TTL to the partner ceiling.
 *
 * Fix round 3 ruling (#2776): `maxEnrollmentLinkTtlMinutes` is a ceiling on
 * KEY LIFETIME, not merely on interactively-chosen caller input. A partner
 * setting a 60-minute cap means nothing minted under them should be usable
 * longer than 60 minutes — including redemption/download/background paths
 * whose TTL comes from a server constant (e.g. `CHILD_ENROLLMENT_KEY_TTL_MINUTES`,
 * `bootstrapTokenExpiresAt()`'s 24h base) rather than a value a human typed
 * into a form for this specific request.
 *
 * Use this — not `assertTtlWithinCap` — on exactly those paths: there is no
 * interactive caller to show a 400 to (public/unauthenticated downloads,
 * device-enrollment redemption, internal helper defaults), and silently
 * reducing a value NOBODY chose for this request is not the silent-discard
 * defect `assertTtlWithinCap` guards against — that defect is specifically
 * about overriding an admin's explicit choice.
 *
 * Same system-context read as `getEnrollmentDefaultsForOrg` — every caller
 * of this function is reachable from an org-scoped or fully unauthenticated
 * route, so the partner-axis RLS gap fixed in round 1 applies identically
 * here. Costs one DB round trip (the org⋈partner settings join) per call;
 * callers on hot/unauthenticated paths should call this at most once per
 * request rather than combined with a separate `assertTtlWithinCap` check.
 */
export async function clampTtlToCap(orgId: string, ttlMinutes: number): Promise<number> {
  const { maxTtlMinutes } = await getEnrollmentDefaultsForOrg(orgId);
  return Math.min(ttlMinutes, maxTtlMinutes);
}
