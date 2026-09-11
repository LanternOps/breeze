import { eq, inArray } from 'drizzle-orm';
import { resolveInheritedAgentVersionPins } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { organizations, partners } from '../db/schema';

/**
 * Effective per-component update version pins (issue #2124). `null` means "no
 * pin" → track the globally promoted latest version. Same shape as the
 * `AgentVersionPins` interface in routes/agents/helpers.ts (the heartbeat's
 * per-org resolver) — deliberately a separate type rather than a shared
 * import so this file stays free of that file's much larger import graph
 * (routes/agents/helpers.ts pulls in most of the agent-route service layer;
 * importing ANY export from it into a route file drags all of that into the
 * importer's module graph, which broke unrelated route tests when tried).
 * The actual PRECEDENCE logic, however, is NOT duplicated — both this file
 * and helpers.ts call the shared `resolveInheritedAgentVersionPins`
 * (packages/shared/src/validators/agentVersionPins.ts) so the two can never
 * silently drift apart.
 */
export interface AgentVersionPins {
  agent: string | null;
  watchdog: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pull the `defaults` sub-object out of a settings JSONB blob (safe for null). */
function extractSettingsDefaults(settings: unknown): Record<string, unknown> {
  const root = isObject(settings) ? settings : {};
  return isObject(root.defaults) ? root.defaults : {};
}

/**
 * Batch resolver for the SAME inherit-with-override pin precedence as
 * `getOrgAgentUpdateConfig` in routes/agents/helpers.ts (issue #2124): an
 * org-set component wins for that org; where the org has NOT set a
 * component, the partner default is inherited; unset at both levels resolves
 * to `null` (track global latest).
 *
 * Built for read paths that need MANY orgs' effective pins at once — the
 * Devices list "Agent Version" badge (issue #5285), which resolves once per
 * page load across every visible org rather than once per device row. ONE
 * joined query for all requested orgs, instead of N calls to the per-org
 * heartbeat resolver (which stays as-is: it already fetches settings +
 * update-policy together for the ONE org a heartbeat request concerns).
 *
 * An orgId with no matching row (already deleted, or the caller passed a bad
 * id) is simply absent from the result rather than erroring — the caller
 * treats a missing entry the same as "no pin anywhere" (falls back to global
 * latest for display purposes).
 *
 * RLS: read in a SYSTEM context, exited from any ambient request context
 * first — same pattern, and the same underlying bug class, as
 * `getEnrollmentDefaultsForOrg` (services/enrollmentDefaults.ts, issue
 * #2776). `partners`' SELECT policy is `breeze_has_partner_access(id)`, and
 * `computeAccessiblePartnerIds` returns `[]` for an organization-scoped
 * caller (middleware/auth.ts) — exactly the scope `GET
 * /agent-versions/effective` runs under for an org token. Under that
 * request's own RLS context the `partners` leftJoin would silently return
 * `partnerSettings: null`, and any partner-inherited pin would evaporate
 * with no error — the opposite of "no pin" is what should render, but a
 * wrongly-empty partner default (never set at all) looks identical from
 * inside this function, so the caller could never tell the two apart.
 * `withSystemDbAccessContext` alone is not enough inside an active request
 * context (it is a no-op that inherits the caller's scope) —
 * `runOutsideDbContext` must exit that context first. The lookup stays keyed
 * on the caller-supplied `orgIds` alone (already auth-filtered by the route
 * before this call) — escaping RLS here widens visibility of settings
 * columns for those specific orgs, not which orgs can be queried.
 *
 * AVAILABILITY: only escalate when actually needed. `withDbAccessContext`
 * pins one pooled connection for its whole callback, and
 * `runOutsideDbContext` exits the AsyncLocalStorage store, so a nested
 * `withSystemDbAccessContext` does NOT nest — it opens a SECOND transaction
 * on a SECOND connection while the first is still held. A caller already
 * inside a system context pays that for no benefit (`partners` is already
 * fully visible), so the ambient scope is checked first and the escape is
 * skipped when it is already `'system'`.
 */
export async function getOrgAgentVersionPinsBatch(
  orgIds: string[],
): Promise<Record<string, AgentVersionPins>> {
  if (orgIds.length === 0) return {};

  const readJoin = () =>
    db
      .select({
        id: organizations.id,
        orgSettings: organizations.settings,
        partnerSettings: partners.settings,
      })
      .from(organizations)
      .leftJoin(partners, eq(partners.id, organizations.partnerId))
      .where(inArray(organizations.id, orgIds));

  const ambientScope = getCurrentDbAccessContext()?.scope;
  const rows =
    ambientScope === 'system'
      ? await readJoin()
      : await runOutsideDbContext(() => withSystemDbAccessContext(readJoin));

  const result: Record<string, AgentVersionPins> = {};
  for (const row of rows) {
    const orgDefaults = extractSettingsDefaults(row.orgSettings);
    const partnerDefaults = extractSettingsDefaults(row.partnerSettings);
    // The SAME shared resolver `getOrgAgentUpdateConfig`
    // (routes/agents/helpers.ts) calls — see this file's docstring above for
    // why the precedence lives there, not duplicated here.
    result[row.id as string] = resolveInheritedAgentVersionPins(orgDefaults, partnerDefaults);
  }
  return result;
}
