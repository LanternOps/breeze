/**
 * AI Organization/Site Tools (issue #2366)
 *
 * Fills the MCP org-lifecycle gap so the new-customer intake workflow
 * (org → site → quote) is possible without touching the web UI:
 *  - `list_organizations` — read-only name-substring lookup of the caller's
 *    accessible orgs, each with its sites. This is how the model resolves the
 *    orgId/siteId that `manage_quotes.create_draft` and
 *    `manage_contracts.create_draft` require.
 *  - `manage_organizations` — write multiplexer: create_org / update_org /
 *    create_site (all approval-gated Tier 3 via TIER3_ACTIONS in
 *    aiGuardrails), plus add_contact which returns a structured
 *    "needs product decision" note (Breeze has no first-class org-contact
 *    entity — see the handler).
 *
 * Tenancy is enforced AT THE TOOL LAYER (the route site/org-scope scanner
 * cannot see this parallel path):
 *  - Cross-org listing narrows to `auth.accessibleOrgIds` for partner scope
 *    and pins org scope to `auth.orgId` with the same safe projection the
 *    GET /orgs/organizations route uses (no settings/ssoConfig/billing leak).
 *  - `create_org` is a PARTNER-scope operation: an organization-scoped caller
 *    gets a clean PARTNER_SCOPE_REQUIRED error. The insert mirrors the
 *    POST /orgs/organizations route + quickbooksCustomerImport service:
 *    tenant creation must escape the request RLS context
 *    (runOutsideDbContext → withSystemDbAccessContext) because the new org id
 *    cannot be in the caller's accessible set yet. Like the QB customer import
 *    and partnerCreate, a default "Main Office" site is created in the same
 *    transaction so the new org is immediately quotable (quotes need siteId).
 *  - `update_org` mirrors the PATCH /orgs/organizations/:id invariants,
 *    including severing/restoring agent tenant access on status transitions.
 *  - `create_site` allows org-scoped callers for their OWN org only (same as
 *    POST /orgs/sites) via the resolveWritableToolOrgId rules.
 */

import { and, eq, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, sites } from '../db/schema';
import { escapeLike } from '../utils/sql';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import {
  restoreOrganizationTenantAccess,
  revokeOrganizationTenantAccess,
} from './tenantLifecycle';

// Mirrors the org PATCH route's status set (schema orgStatusEnum). Kept as a
// literal array (not orgStatusEnum.enumValues) so schema mocks in tests don't
// break the zod/tool definitions.
const ORG_STATUSES = ['active', 'suspended', 'trial', 'churned'] as const;
type OrgStatus = (typeof ORG_STATUSES)[number];

// Local copy of the slug helpers from services/accounting/quickbooksCustomerImport.ts
// (duplicated rather than imported so this file doesn't drag the accounting
// provider stack into every consumer; keep the two in sync).
export function slugifyOrgName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, '');
  return slug || 'org';
}

export function generateUniqueOrgSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Local copy of the shared hub helper (same rules as resolveWritableToolOrgId
// in services/aiTools.ts, duplicated like aiToolsBrowser/aiToolsCompliance do
// so tests don't need to load the whole tool hub).
function resolveWritableOrgId(
  auth: AuthContext,
  inputOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this operation' };
}

function jsonError(message: string, code?: string): string {
  return JSON.stringify(code ? { error: message, code } : { error: message });
}

/** Best-effort audit write — never blocks the tool result (deleteTenant pattern). */
function auditOrgToolEvent(
  auth: AuthContext,
  entry: {
    orgId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
  }
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: entry.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
      result: 'success',
      details: { ...entry.details, tool_name: 'manage_organizations' },
    });
  } catch (err) {
    console.error('[manage_organizations] audit write failed', err);
  }
}

const SAFE_ORG_PROJECTION = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  status: organizations.status,
};

async function handleListOrganizations(
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
  const search = typeof input.search === 'string' ? input.search.trim() : '';
  const searchCondition = search
    ? ilike(organizations.name, `%${escapeLike(search)}%`)
    : undefined;

  const conditions: SQL[] = [isNull(organizations.deletedAt)];
  if (searchCondition) conditions.push(searchCondition);

  if (auth.scope === 'organization') {
    // Org-scoped callers see ONLY their own org.
    if (!auth.orgId) return JSON.stringify({ organizations: [], showing: 0 });
    conditions.push(eq(organizations.id, auth.orgId));
  } else if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) return JSON.stringify({ organizations: [], showing: 0 });
    conditions.push(inArray(organizations.id, orgIds));
  }
  // system scope: no extra org filter (mirrors GET /orgs/organizations).

  // Safe projection for every scope — an unprojected select would leak
  // settings/ssoConfig/billingContact into the model context.
  const orgs = await db
    .select(SAFE_ORG_PROJECTION)
    .from(organizations)
    .where(and(...conditions))
    .orderBy(organizations.name)
    .limit(limit);

  // Attach each org's sites (id + name — enough to feed manage_quotes'
  // siteId). Site-restricted callers only see their allowed sites, mirroring
  // the GET /orgs/sites confinement.
  const sitesByOrg = new Map<string, Array<{ id: string; name: string }>>();
  const orgIdsOnPage = orgs.map((o) => o.id);
  // Site-restricted caller with an empty allowlist sees no sites at all —
  // skip the query entirely rather than emit an empty IN ().
  const siteListDenied = auth.allowedSiteIds !== undefined && auth.allowedSiteIds.length === 0;
  if (orgIdsOnPage.length > 0 && !siteListDenied) {
    const siteConditions: SQL[] = [inArray(sites.orgId, orgIdsOnPage)];
    if (auth.allowedSiteIds && auth.allowedSiteIds.length > 0) {
      siteConditions.push(inArray(sites.id, auth.allowedSiteIds));
    }
    const siteRows = await db
      .select({ id: sites.id, name: sites.name, orgId: sites.orgId })
      .from(sites)
      .where(and(...siteConditions))
      .orderBy(sites.name);
    for (const row of siteRows) {
      const list = sitesByOrg.get(row.orgId) ?? [];
      list.push({ id: row.id, name: row.name });
      sitesByOrg.set(row.orgId, list);
    }
  }

  const data = orgs.map((org) => ({
    ...org,
    sites: sitesByOrg.get(org.id) ?? [],
  }));

  return JSON.stringify({ organizations: data, showing: data.length });
}

async function handleCreateOrg(
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  // Org creation is a PARTNER-scope operation: an org-scoped token must get a
  // clean authorization error (never a cross-tenant write).
  if (auth.scope !== 'partner' || !auth.partnerId) {
    return jsonError(
      'Creating organizations requires a partner-scoped session. Organization-scoped callers cannot create organizations.',
      'PARTNER_SCOPE_REQUIRED'
    );
  }
  const partnerId = auth.partnerId;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return jsonError('name is required for create_org');

  // Tenant creation must escape the request RLS context: the new org id cannot
  // be in the caller's accessible set yet (same rationale + pattern as
  // POST /orgs/organizations and quickbooksCustomerImport). Partner authority
  // was checked above. The slug read, org insert, and default-site insert share
  // one system-context transaction.
  const created = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const existing = await db
        .select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.partnerId, partnerId));
      const taken = new Set(existing.map((row) => row.slug));
      const slug = generateUniqueOrgSlug(slugifyOrgName(name), taken);

      const [org] = await db
        .insert(organizations)
        .values({
          partnerId,
          name: name.slice(0, 255),
          slug,
          type: 'customer' as const,
          status: 'active' as const,
        })
        .returning({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          status: organizations.status,
        });
      if (!org) throw new Error('Organization insert returned no row');

      // Default site, same invariant as partnerCreate + the QB customer
      // import — a brand-new org must be immediately usable for quoting
      // (quotes require a siteId).
      const [site] = await db
        .insert(sites)
        .values({ orgId: org.id, name: 'Main Office', timezone: 'UTC' })
        .returning({ id: sites.id, name: sites.name });
      if (!site) throw new Error('Default site insert returned no row');

      return { org, site };
    })
  );

  auditOrgToolEvent(auth, {
    orgId: created.org.id,
    action: 'organization.create',
    resourceType: 'organization',
    resourceId: created.org.id,
    resourceName: created.org.name,
    details: { partnerId, defaultSiteId: created.site.id },
  });
  auditOrgToolEvent(auth, {
    orgId: created.org.id,
    action: 'site.create',
    resourceType: 'site',
    resourceId: created.site.id,
    resourceName: created.site.name,
  });

  return JSON.stringify({
    organization: created.org,
    defaultSite: created.site,
    note: 'A default "Main Office" site was created with the organization; use create_site to add more locations.',
  });
}

async function handleUpdateOrg(
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  // Mirrors PATCH /orgs/organizations/:id — partner/system scope only.
  if (auth.scope === 'organization') {
    return jsonError(
      'Updating organizations requires a partner-scoped session.',
      'PARTNER_SCOPE_REQUIRED'
    );
  }
  const orgId = typeof input.orgId === 'string' ? input.orgId : '';
  if (!orgId) return jsonError('orgId is required for update_org');
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) {
    return jsonError('Organization not found or access denied');
  }

  const name = typeof input.name === 'string' ? input.name.trim() : undefined;
  const status = typeof input.status === 'string' ? input.status : undefined;
  if (name === '') return jsonError('name cannot be empty');
  if (status !== undefined && !ORG_STATUSES.includes(status as OrgStatus)) {
    return jsonError(`status must be one of: ${ORG_STATUSES.join(', ')}`);
  }
  if (name === undefined && status === undefined) {
    return jsonError('No updates provided — pass name and/or status');
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name.slice(0, 255);
  if (status !== undefined) updates.status = status;

  const [org] = await db
    .update(organizations)
    .set(updates)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .returning({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      status: organizations.status,
    });
  if (!org) return jsonError('Organization not found or access denied');

  // Status-transition invariants from the org PATCH route: suspending/churning
  // severs agent tenant access; re-activating restores it.
  if (status !== undefined && status !== 'active' && status !== 'trial') {
    await revokeOrganizationTenantAccess(org.id);
  } else if (status === 'active' || status === 'trial') {
    await restoreOrganizationTenantAccess(org.id);
  }

  auditOrgToolEvent(auth, {
    orgId: org.id,
    action: 'organization.update',
    resourceType: 'organization',
    resourceId: org.id,
    resourceName: org.name,
    details: {
      changedFields: [
        ...(name !== undefined ? ['name'] : []),
        ...(status !== undefined ? ['status'] : []),
      ],
    },
  });

  return JSON.stringify({ organization: org });
}

async function handleCreateSite(
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  const resolved = resolveWritableOrgId(
    auth,
    typeof input.orgId === 'string' ? input.orgId : undefined
  );
  if (resolved.error || !resolved.orgId) {
    return jsonError(resolved.error ?? 'orgId is required for create_site');
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return jsonError('name is required for create_site');

  const address =
    input.address && typeof input.address === 'object' && !Array.isArray(input.address)
      ? (input.address as Record<string, unknown>)
      : undefined;

  // Insert under the request context — RLS on `sites` (org axis) is the
  // defense-in-depth backstop behind the resolveWritableOrgId check above.
  const [site] = await db
    .insert(sites)
    .values({
      orgId: resolved.orgId,
      name: name.slice(0, 255),
      address,
    })
    .returning({ id: sites.id, name: sites.name, orgId: sites.orgId });
  // A 0-row insert means the RLS policy rejected it even though the app-layer
  // check passed — surface it instead of returning success with no site.
  if (!site) return jsonError('Failed to create site');

  auditOrgToolEvent(auth, {
    orgId: site.orgId,
    action: 'site.create',
    resourceType: 'site',
    resourceId: site.id,
    resourceName: site.name,
  });

  return JSON.stringify({ site });
}

function handleAddContact(): string {
  // Breeze has no first-class organization-contact entity: `sites.contact` and
  // `organizations.billingContact` are JSONB blobs, and portal users
  // (orgPortalUsers) carry user-invite semantics we must not trigger from an
  // AI tool. Surfacing a structured note (instead of inventing an invite flow)
  // is deliberate — see issue #2366.
  return JSON.stringify({
    status: 'not_supported',
    code: 'CONTACT_ENTITY_UNDEFINED',
    note:
      'Breeze has no standalone org-contact record yet, so add_contact needs a product decision before it can write anything. ' +
      'Available today: a site contact can be set on the site record (web UI Settings → Organizations → site), and the billing ' +
      'contact lives on the organization record. Portal users are invite-based and are not created by this tool.',
  });
}

export function registerOrgTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_organizations', {
    tier: 1 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_organizations',
      description:
        'List/search the organizations the caller can access (name substring match), each with id, name, slug, status, and ' +
        'its sites (id + name). Use this to resolve the orgId and siteId that manage_quotes, manage_contracts, and ' +
        'manage_invoices require. Partner-scoped callers see all their orgs; organization-scoped callers see only their own. ' +
        'Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Case-insensitive name substring filter' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: async (input, auth) => {
      try {
        return await handleListOrganizations(input, auth);
      } catch (err) {
        console.error('[list_organizations]', err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });

  aiTools.set('manage_organizations', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'manage_organizations',
      description:
        'Create and manage organizations and sites (new-customer intake). Actions: create_org (name required; creates the ' +
        'org under the caller\'s partner WITH a default "Main Office" site — partner scope only), update_org (name/status ' +
        'patch; suspending or churning an org severs its agents), create_site (orgId + name + optional address object), ' +
        'add_contact (not yet supported — returns guidance). create_org, update_org, and create_site require approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create_org', 'update_org', 'create_site', 'add_contact'],
          },
          orgId: { type: 'string', description: 'Organization UUID (update_org, create_site, add_contact)' },
          name: { type: 'string', description: 'Org name (create_org/update_org) or site name (create_site)' },
          status: { type: 'string', enum: [...ORG_STATUSES], description: 'New org status (update_org)' },
          address: { type: 'object', description: 'Site address object (create_site), e.g. {addressLine1, city, state, postalCode, country}' },
          email: { type: 'string', description: 'Contact email (add_contact — currently unsupported)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      try {
        switch (input.action) {
          case 'create_org':
            return await handleCreateOrg(input, auth);
          case 'update_org':
            return await handleUpdateOrg(input, auth);
          case 'create_site':
            return await handleCreateSite(input, auth);
          case 'add_contact':
            return handleAddContact();
          default:
            return jsonError(`Unknown action: ${String(input.action)}`);
        }
      } catch (err) {
        console.error('[manage_organizations]', input.action, err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });
}
