import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { contracts, deviceGroups, devices, invoices, quotes, securityThreats, tickets } from '../db/schema';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';

/**
 * Org resolution for the generic audit fallback in index.ts — the row written
 * for a mutating request whose handler recorded no audit event of its own.
 *
 * The fallback runs AFTER the route returned, so it can only see the request:
 * the caller's auth and the URL. It resolves, in order:
 *
 *   1. The caller's own org — an organization-scope token, or a caller with
 *      exactly one accessible org.
 *   2. An org the path names: `/orgs/:orgId/...` or `/orgs/organizations/:id`.
 *   3. The org owning a resource the path names (a device, ticket, quote, …),
 *      looked up inside the caller's own DB access context. The request
 *      transaction has closed by now; a lookup outside any context runs with
 *      no tenant scope and RLS returns no rows.
 *
 * Every candidate from (2) and (3) must pass `auth.canAccessOrg`: the URL is
 * supplied by the caller, and a row is only ever filed under an org the caller
 * can already reach.
 *
 * An `?orgId=` query parameter is deliberately NOT used. The web client adds
 * the org switcher's current org to nearly every request, mutations included,
 * so on a partner-wide or body-targeted route it names whichever org the user
 * happened to have selected, not the org the request acted on.
 *
 * Returns null when nothing resolves — never a guessed org. Not resolved here:
 *   - requests without a user `auth` context (agent-authenticated calls and
 *     unauthenticated ones) — the fallback writes no row for these;
 *   - routes whose org arrives only in the request body or query string, and
 *     partner-wide writes that have no org at all. For a signed-in user the
 *     fallback still records these as a partner-level row (org_id NULL,
 *     attributed to the caller's partner when partner-scoped), so no write is
 *     silent. A route acting on an org-owned record should still write a
 *     semantic audit (`writeRouteAudit`) with the record's org so the org's own
 *     users see it; quote/invoice/contract create and delete are the model.
 */
export async function resolveFallbackOrgId(c: Context, path: string): Promise<string | null> {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) {
    return null;
  }

  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  const segments = path.split('/').filter(Boolean);

  const pathOrgId = orgIdInPath(segments);
  if (pathOrgId) {
    return accessibleOrNull(auth, pathOrgId);
  }

  const lookup = resourceOrgLookup(segments);
  if (!lookup) {
    return null;
  }

  try {
    const ownerOrgId = await withAuthDbAccessContext(auth, lookup);
    return ownerOrgId ? accessibleOrNull(auth, ownerOrgId) : null;
  } catch (err) {
    console.error('[audit] Failed to resolve orgId from path:', err);
    return null;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | undefined): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

function accessibleOrNull(auth: AuthContext, orgId: string): string | null {
  // Fail closed for a hand-built context that carries no access check.
  return typeof auth.canAccessOrg === 'function' && auth.canAccessOrg(orgId) ? orgId : null;
}

/**
 * The org id the path names. `segments` is the full path split on `/`, so
 * `segments[2]` is the first segment after `/api/v1`. The segment after
 * `/orgs/` is an org id only when it is a UUID: `/orgs/sites/:id`,
 * `/orgs/partners/:id` and `/orgs/import` share the prefix.
 */
function orgIdInPath(segments: string[]): string | null {
  if (segments[2] !== 'orgs') {
    return null;
  }
  return uuidOrNull(segments[3])
    ?? (segments[3] === 'organizations' ? uuidOrNull(segments[4]) : null);
}

type OrgLookup = () => Promise<string | null>;

type OrgOwnedTable = typeof devices | typeof deviceGroups | typeof tickets | typeof quotes | typeof invoices | typeof contracts;

function orgOf(table: OrgOwnedTable, id: string): OrgLookup {
  return async () => {
    const [row] = await db
      .select({ orgId: table.orgId })
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return row?.orgId ?? null;
  };
}

function threatOrg(threatId: string): OrgLookup {
  return async () => {
    const [row] = await db
      .select({ orgId: devices.orgId })
      .from(securityThreats)
      .innerJoin(devices, eq(securityThreats.deviceId, devices.id))
      .where(eq(securityThreats.id, threatId))
      .limit(1);
    return row?.orgId ?? null;
  };
}

/**
 * Resources whose id sits directly after a top-level mount, e.g.
 * `/tickets/:id/...`. A non-UUID segment in that position is a literal route
 * (`/quotes/bulk-delete`, `/contracts/templates`) and resolves nothing.
 */
const TOP_LEVEL_RESOURCES: Record<string, OrgOwnedTable> = {
  devices,
  tickets,
  quotes,
  invoices,
  contracts,
};

/** A lookup for the org owning the resource the URL names, or null when the URL names none. */
function resourceOrgLookup(segments: string[]): OrgLookup | null {
  const [, , root, second, third] = segments;
  if (!root) return null;

  if (root === 'devices' && second === 'groups') {
    const groupId = uuidOrNull(third);
    return groupId ? orgOf(deviceGroups, groupId) : null;
  }

  if ((root === 'security' && second === 'scan') || (root === 'system-tools' && second === 'devices')) {
    const deviceId = uuidOrNull(third);
    return deviceId ? orgOf(devices, deviceId) : null;
  }

  if (root === 'security' && second === 'threats') {
    const threatId = uuidOrNull(third);
    return threatId ? threatOrg(threatId) : null;
  }

  const table = Object.hasOwn(TOP_LEVEL_RESOURCES, root) ? TOP_LEVEL_RESOURCES[root] : undefined;
  const id = uuidOrNull(second);
  return table && id ? orgOf(table, id) : null;
}
