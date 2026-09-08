import { eq, inArray } from 'drizzle-orm';
import { normalizeVersionPin } from '@breeze/shared';
import { db } from '../db';
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
 */
export async function getOrgAgentVersionPinsBatch(
  orgIds: string[],
): Promise<Record<string, AgentVersionPins>> {
  if (orgIds.length === 0) return {};

  const rows = await db
    .select({
      id: organizations.id,
      orgSettings: organizations.settings,
      partnerSettings: partners.settings,
    })
    .from(organizations)
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .where(inArray(organizations.id, orgIds));

  const result: Record<string, AgentVersionPins> = {};
  for (const row of rows) {
    const orgDefaults = extractSettingsDefaults(row.orgSettings);
    const partnerDefaults = extractSettingsDefaults(row.partnerSettings);
    const orgPins = isObject(orgDefaults.agentVersionPins) ? orgDefaults.agentVersionPins : {};
    const partnerPins = isObject(partnerDefaults.agentVersionPins)
      ? partnerDefaults.agentVersionPins
      : {};
    result[row.id as string] = {
      agent: normalizeVersionPin('agent' in orgPins ? orgPins.agent : partnerPins.agent),
      watchdog: normalizeVersionPin('watchdog' in orgPins ? orgPins.watchdog : partnerPins.watchdog),
    };
  }
  return result;
}
