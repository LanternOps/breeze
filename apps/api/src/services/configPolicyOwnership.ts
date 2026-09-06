import { sql, type SQL } from 'drizzle-orm';
import { configurationPolicies } from '../db/schema';
import { getCurrentDbAccessContext } from '../db';
import { captureException } from './sentry';

/**
 * The app-layer half of "a per-device resolver honours partner-wide policies".
 *
 * A `configuration_policies` row is either ORG-owned (`org_id` set,
 * `partner_id NULL`) or PARTNER-owned / "partner-wide" (`org_id NULL`,
 * `partner_id` set) — the XOR is enforced by `<table>_one_owner_chk`. Every
 * per-device resolver needs {@link policyOwnershipCondition}: a bare
 * `eq(configurationPolicies.orgId, device.orgId)` never matches an
 * `org_id NULL` row, so a partner-wide policy is authorable in the UI and
 * silently never reaches an agent.
 *
 * The RLS half used to live here too, as `withPartnerWideVisibility` — a
 * nested `runOutsideDbContext(() => withSystemDbAccessContext(...))` escape
 * taken because partner-owned rows were gated only by
 * `breeze_has_partner_access`, which every org-scoped and agent context fails
 * (`accessiblePartnerIds: []`). **That escape is gone as of #4673 W03.** The
 * database now grants the read directly: `<table>_partner_wide_select`
 * (#4673 W01, `2026-10-05-110000-config-policy-partner-wide-select.sql`) adds a
 * SELECT-ONLY branch `org_id IS NULL AND partner_id =
 * public.breeze_current_partner_id()` across the whole configuration-policy
 * chain, and W02 populates `breeze.current_partner_id` on agent contexts as it
 * already was on every user/bearer/partner-API context. So a resolver running
 * in the CALLER'S OWN context now sees its own partner's partner-wide rows —
 * with no second pooled connection (the #1105 starvation shape) and no
 * RLS bypass (the #2417 cross-tenant shape).
 *
 * Consequence for new code: **do not reintroduce a system-context escape for
 * partner-wide config reads.** If a partner-wide row is invisible, the cause is
 * a missing `currentPartnerId` on the DbAccessContext or a table that never got
 * a `*_partner_wide_select` policy — fix that, not the caller.
 *
 * Extracted here (issue #2930) because the predicate had been re-derived inline
 * in four places and three of the five agent resolvers had drifted back to the
 * org-only form. Sibling: `readWithPartnerAxisVisibility`
 * (`db/partnerAxisRead.ts`) still escapes, but for partner-AXIS tables
 * (`partners`, `PARTNER_TENANT_TABLES`), which have no `org_id IS NULL` branch
 * to grant — a different problem, tracked by #2822.
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

/** Minimal shape of a drizzle executor this module needs: `db` or an open `tx`. */
export interface PartnerVisibilityExecutor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Widen partner visibility IN PLACE on a CALLER-SUPPLIED executor (#3493).
 *
 * Kept after #4673 W03 removed the system-context escapes, because this one is
 * a different mechanism solving a different problem. The removed escape opened
 * a fresh system context — a fresh transaction on a SECOND pooled connection —
 * which is wrong, silently and in the worst direction, when the caller passed
 * an open `tx`:
 *
 *  - the second connection cannot see the tx's UNCOMMITTED rows, so a
 *    preview/diff that inserted proposed assignments would resolve as if they
 *    did not exist; and
 *  - wrapping an escape around `tx.select()...` does not even retarget the
 *    query — `tx` is bound to its own connection, so the escape becomes a
 *    no-op that merely double-holds a connection.
 *
 * SCOPE NOTE (#4673): for the configuration-policy chain specifically, the
 * `*_partner_wide_select` RLS branch now makes partner-wide rows legible to the
 * caller's own context without any widening, so this helper is largely
 * redundant there. It is NOT redundant in general — it widens
 * `breeze.accessible_partner_ids`, which admits partner-AXIS rows the
 * SELECT-only branch never grants — so removing it is a separate, reviewable
 * change and deliberately out of W03's scope.
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
