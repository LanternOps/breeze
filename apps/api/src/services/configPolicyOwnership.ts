import { sql, type SQL } from 'drizzle-orm';
import { configurationPolicies } from '../db/schema';
import {
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';

/**
 * The two halves of "a per-device resolver honours partner-wide policies".
 *
 * A `configuration_policies` row is either ORG-owned (`org_id` set,
 * `partner_id NULL`) or PARTNER-owned / "partner-wide" (`org_id NULL`,
 * `partner_id` set) — the XOR is enforced by `<table>_one_owner_chk`. Every
 * per-device resolver therefore needs BOTH of the following, and fixing only
 * one of them leaves the feature just as broken:
 *
 *  1. {@link policyOwnershipCondition} — the app-layer join predicate. A bare
 *     `eq(configurationPolicies.orgId, device.orgId)` never matches an
 *     `org_id NULL` row, so a partner-wide policy is authorable in the UI and
 *     silently never reaches an agent.
 *  2. {@link withPartnerWideVisibility} — the RLS context. Partner-owned rows
 *     are gated by `breeze_has_partner_access`, and every agent-facing context
 *     (agentAuth, org-scoped user tokens, portal, org-scoped OAuth bearers)
 *     carries `accessiblePartnerIds: []`. Under those the read returns ZERO
 *     ROWS — it does not raise — so a correct predicate still resolves nothing.
 *
 * Extracted here (issue #2930) because the predicate had been re-derived inline
 * in four places and three of the five agent resolvers had drifted back to the
 * org-only form. Siblings: `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts`)
 * does the same job for partner-AXIS tables; this module is the config-policy
 * partner-WIDE equivalent.
 */

/** The owning org + partner of the device a policy is being resolved for. */
export interface ConfigPolicyOwner {
  orgId: string;
  /** The device org's partner, or null when the org has no partner. */
  partnerId: string | null;
}

/**
 * Build the "does this policy apply to this device" ownership predicate.
 *
 * A policy resolves when it is owned by the device's own org (the original
 * org-scoped shape) OR owned by the device's partner (`org_id NULL`,
 * `partner_id` set — the partner-wide / "All orgs" shape, #1724). RLS
 * (`breeze_has_org_access` / `breeze_has_partner_access`) still gates
 * visibility on top of this; the predicate is never the tenancy boundary.
 *
 * Use this in place of a bare org-equality join on EVERY per-device resolver.
 */
export function policyOwnershipCondition(owner: ConfigPolicyOwner): SQL {
  if (owner.partnerId) {
    return sql`(${configurationPolicies.orgId} = ${owner.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${owner.partnerId}))`;
  }
  return sql`${configurationPolicies.orgId} = ${owner.orgId}`;
}

/**
 * Run a config-policy lookup where partner-wide rows must be visible.
 *
 * Wrap ONLY the policy join. Device/site/group reads belong in the caller's own
 * context so RLS keeps gating which devices a caller may see; the policy join
 * is self-tenanted by the device hierarchy already resolved there.
 *
 * AVAILABILITY: the escape is taken only when it is actually needed. A caller
 * that is already system-scoped gains nothing and would double-hold pooled
 * connections — `withDbAccessContext` pins one connection for its whole
 * callback, and the nested `withSystemDbAccessContext` opens a SECOND
 * transaction on a SECOND connection. Against the 25-connection US ceiling,
 * with no acquire timeout in postgres-js, that is the #1105 self-deadlock
 * shape. Hot paths (the agent heartbeat) should additionally hoist the whole
 * resolve out of the org transaction so this escape has nothing to double-hold;
 * it then degrades to the single system context it opens itself.
 *
 * The three `db` imports are NAMED on purpose: a unit suite whose
 * `vi.mock('../db')` factory omits one fails loudly with "No <name> export is
 * defined on the mock" rather than silently skipping the escape.
 */
export async function withPartnerWideVisibility<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}
