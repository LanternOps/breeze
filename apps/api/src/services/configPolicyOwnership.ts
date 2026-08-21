import { sql, type SQL } from 'drizzle-orm';
import { configurationPolicies } from '../db/schema';
import {
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { captureException } from './sentry';

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

/** Minimal shape of a drizzle executor this module needs: `db` or an open `tx`. */
export interface PartnerVisibilityExecutor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * The SAME-CONNECTION variant of {@link withPartnerWideVisibility}, for resolvers
 * that must run their policy join through a CALLER-SUPPLIED executor (#3493).
 *
 * `withPartnerWideVisibility` escapes by opening a fresh system context, which
 * means a fresh transaction on a SECOND pooled connection. That is fine when the
 * read runs on the ambient `db`, but it is wrong — silently, in the worst
 * direction — when the caller passed an open `tx`:
 *
 *  - the second connection cannot see the tx's UNCOMMITTED rows, so a
 *    preview/diff that inserted proposed assignments would resolve as if they
 *    did not exist; and
 *  - wrapping `withPartnerWideVisibility(() => tx.select()...)` does not even
 *    retarget the query — `tx` is bound to its own connection, so the escape
 *    becomes a no-op that merely double-holds a connection.
 *
 * So instead of switching connections, this widens visibility IN PLACE on the
 * caller's own transaction, and by the smallest possible amount: it appends
 * exactly ONE partner id to `breeze.accessible_partner_ids` for the duration of
 * `fn`, then restores the previous value. `breeze.scope` is never touched, so
 * this is strictly narrower than a system escape — every other RLS axis
 * (org access, user id, per-table policies) keeps evaluating unchanged, and the
 * only rows that become legible are those owned by that one partner.
 *
 * CALLER CONTRACT: `partnerId` MUST have been read from a row the caller already
 * resolved under its OWN RLS context (e.g. `organizations.partner_id` for a
 * device the caller could see). Never pass a client-supplied partner id — that
 * would turn this into a cross-tenant read.
 *
 * The widening is skipped entirely — `fn` runs untouched — when it cannot help
 * or cannot work:
 *  - no partner (`null`): nothing to widen to;
 *  - no ambient DB context: there is no guaranteed open transaction, so
 *    `SET LOCAL` would land on an arbitrary pooled connection and silently do
 *    nothing. A contextless connection is already system-scoped, so the rows
 *    are visible anyway;
 *  - `scope === 'system'`: `breeze_has_partner_access` short-circuits true;
 *  - the partner is ALREADY in the context's allowlist (the partner-scoped
 *    caller's normal case) — `getCurrentDbAccessContext()` mirrors exactly what
 *    was `SET LOCAL`, so an allowlist hit means RLS already passes.
 */
export async function withDevicePartnerPolicyVisibility<T, E extends PartnerVisibilityExecutor>(
  executor: E,
  partnerId: string | null,
  fn: (executor: E) => Promise<T>,
): Promise<T> {
  if (!partnerId) return fn(executor);

  const ctx = getCurrentDbAccessContext();
  if (!ctx || ctx.scope === 'system') return fn(executor);

  const current = ctx.accessiblePartnerIds ?? [];
  if (current.includes(partnerId)) return fn(executor);

  // `''` is the fail-closed "no partners" form the SQL helper reads as
  // ARRAY[]::uuid[]; a non-empty list is comma-joined. Mirrors
  // serializeAccessibleIds() in db/index.ts for a non-system scope.
  const previous = current.join(',');
  const widened = [...current, partnerId].join(',');

  await executor.execute(sql`select set_config('breeze.accessible_partner_ids', ${widened}, true)`);
  try {
    return await fn(executor);
  } finally {
    try {
      await executor.execute(sql`select set_config('breeze.accessible_partner_ids', ${previous}, true)`);
    } catch (restoreErr) {
      // Expected only on an already-aborted transaction, where nothing further
      // will run on it and the SET LOCAL dies with the rollback anyway — and
      // the restore must never mask fn's real error. But that reasoning is an
      // assumption, not something this code enforces, and the failure mode it
      // assumes away (a widened partner allowlist outliving the resolve on a
      // still-usable connection) is security-relevant. Report it so the
      // assumption is falsifiable from production telemetry instead of resting
      // on a comment.
      console.error('[configPolicyOwnership] failed to restore breeze.accessible_partner_ids:', restoreErr);
      captureException(restoreErr);
    }
  }
}
