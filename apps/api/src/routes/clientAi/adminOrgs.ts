import { Hono } from 'hono';
import { and, asc, count, eq, sum } from 'drizzle-orm';
import { db } from '../../db';
import {
  clientAiOrgPolicies,
  clientAiTenantMappings,
  clientAiUsage,
} from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { portalUsers } from '../../db/schema/portal';
import { m365Connections } from '../../db/schema/m365';
import { delegantM365Connections } from '../../db/schema/delegant';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import { resolveScopedOrgId } from '../c2c/helpers';
import { ENTRA_TENANT_GUID_REGEX } from './schemas';

/**
 * AI for Office — onboarding/status endpoints for the dashboard OrgsTab
 * (spec §9.1). Mounted onto clientAiAdminRoutes (admin.ts), so the Plan-1
 * group authMiddleware + CLIENT_AI_ENTRA_CLIENT_ID dark-gate already apply.
 *
 * consentStatus derivation (Plan-4 decision 1): the /auth/exchange route
 * (Plan 1) auto-provisions portal_users rows with auth_method='entra' on the
 * first successful token exchange, so
 *   no mapping                       → 'unknown'
 *   mapping, no entra users in org   → 'pending'
 *   mapping + ≥1 entra user          → 'granted'
 */

export const clientAiAdminOrgRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);

export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Mirrors services/c2cM365.ts getCallbackUri() — same env fallbacks. */
export function getClientAiConsentRedirectUri(): string {
  const base = (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/api/v1/client-ai/consent/callback`;
}

/**
 * Mirrors services/c2cM365.ts buildAdminConsentUrl(), but with the tenant
 * segment pinned by the spec: the mapped tenant GUID when known, otherwise
 * the 'organizations' multi-tenant endpoint.
 */
export function buildClientAiConsentUrl(params: {
  clientId: string;
  entraTenantId: string | null;
}): string {
  const segment = params.entraTenantId ?? 'organizations';
  const url = new URL(`https://login.microsoftonline.com/${segment}/adminconsent`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', getClientAiConsentRedirectUri());
  return url.toString();
}

// ── GET /orgs — per-org status list ──────────────────────────────────────────
// Seven sequential selects, merged in JS (no N+1; each is one indexed scan).
// Order matters — the unit test mocks them positionally:
//   1 organizations  2 tenant mappings  3 policies  4 entra-user counts
//   5 current-month usage  6 m365 connections  7 delegant connections
clientAiAdminOrgRoutes.get('/orgs', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgFilter = c.req.query('orgId') || null;

  // Defense-in-depth: scope the org list to the caller's accessible orgs at the
  // app layer so it agrees with forced RLS (and survives any future RLS regression,
  // or this pattern being copied to a not-yet-RLS'd table), matching the
  // resolveScopedOrgId convention the sibling :orgId routes already use. For
  // system scope orgCondition returns undefined → unfiltered (correct).
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(auth.orgCondition?.(organizations.id))
    .orderBy(asc(organizations.name));

  const mappings = await db
    .select({
      orgId: clientAiTenantMappings.orgId,
      entraTenantId: clientAiTenantMappings.entraTenantId,
    })
    .from(clientAiTenantMappings);

  const policies = await db
    .select({ orgId: clientAiOrgPolicies.orgId, enabled: clientAiOrgPolicies.enabled })
    .from(clientAiOrgPolicies);

  const entraUsers = await db
    .select({ orgId: portalUsers.orgId, n: count() })
    .from(portalUsers)
    .where(eq(portalUsers.authMethod, 'entra'))
    .groupBy(portalUsers.orgId);

  const usage = await db
    .select({
      orgId: clientAiUsage.orgId,
      costCents: sum(clientAiUsage.totalCostCents),
      messages: sum(clientAiUsage.messageCount),
    })
    .from(clientAiUsage)
    .where(
      and(eq(clientAiUsage.period, 'monthly'), eq(clientAiUsage.periodKey, currentMonthKey()))
    )
    .groupBy(clientAiUsage.orgId);

  const m365 = await db
    .select({ orgId: m365Connections.orgId, tenantId: m365Connections.tenantId })
    .from(m365Connections);

  const delegant = await db
    .select({
      orgId: delegantM365Connections.orgId,
      tenantId: delegantM365Connections.m365TenantId,
    })
    .from(delegantM365Connections);

  const mappingByOrg = new Map(mappings.map((m) => [m.orgId, m.entraTenantId]));
  const policyByOrg = new Map(policies.map((p) => [p.orgId, p.enabled === true]));
  const entraCountByOrg = new Map(entraUsers.map((u) => [u.orgId, Number(u.n ?? 0)]));
  const usageByOrg = new Map(
    usage.map((u) => [
      u.orgId,
      {
        costCents: Math.round(Number(u.costCents ?? 0) * 100) / 100,
        messages: Number(u.messages ?? 0),
      },
    ])
  );
  // Pre-fill preference per the Plan-1 Task-1 M365 reuse audit:
  // m365_connections.tenant_id first (one per org), then the first GUID-shaped
  // delegant_m365_connections.m365_tenant_id. Non-GUID values never suggested.
  const suggestedByOrg = new Map<string, string>();
  for (const row of delegant) {
    if (!suggestedByOrg.has(row.orgId) && ENTRA_TENANT_GUID_REGEX.test(row.tenantId)) {
      suggestedByOrg.set(row.orgId, row.tenantId.toLowerCase());
    }
  }
  for (const row of m365) {
    if (ENTRA_TENANT_GUID_REGEX.test(row.tenantId)) {
      suggestedByOrg.set(row.orgId, row.tenantId.toLowerCase());
    }
  }

  const data = orgs
    .filter((org) => !orgFilter || org.id === orgFilter)
    .map((org) => {
      const entraTenantId = mappingByOrg.get(org.id) ?? null;
      const mapped = entraTenantId !== null;
      const granted = mapped && (entraCountByOrg.get(org.id) ?? 0) > 0;
      const orgUsage = usageByOrg.get(org.id);
      return {
        orgId: org.id,
        orgName: org.name,
        mapped,
        entraTenantId,
        suggestedEntraTenantId: suggestedByOrg.get(org.id) ?? null,
        consentStatus: !mapped ? ('unknown' as const) : granted ? ('granted' as const) : ('pending' as const),
        policyEnabled: policyByOrg.get(org.id) ?? false,
        currentMonthCostCents: orgUsage?.costCents ?? 0,
        currentMonthMessages: orgUsage?.messages ?? 0,
      };
    });

  return c.json({ data });
});

// ── GET /orgs/:orgId/consent-url ──────────────────────────────────────────────
clientAiAdminOrgRoutes.get('/orgs/:orgId/consent-url', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const [mapping] = await db
    .select({ entraTenantId: clientAiTenantMappings.entraTenantId })
    .from(clientAiTenantMappings)
    .where(eq(clientAiTenantMappings.orgId, orgId))
    .limit(1);

  const entraTenantId = mapping?.entraTenantId ?? null;
  return c.json({
    url: buildClientAiConsentUrl({ clientId: CLIENT_AI_ENTRA_CLIENT_ID, entraTenantId }),
    tenantSegment: entraTenantId ?? 'organizations',
    redirectUri: getClientAiConsentRedirectUri(),
  });
});

// ── GET /orgs/:orgId/users — entra portal users (policy-editor picker) ───────
clientAiAdminOrgRoutes.get('/orgs/:orgId/users', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const data = await db
    .select({
      id: portalUsers.id,
      email: portalUsers.email,
      name: portalUsers.name,
      lastLoginAt: portalUsers.lastLoginAt,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.authMethod, 'entra')))
    .orderBy(asc(portalUsers.email));

  return c.json({ data });
});

// ── Public consent-callback landing page ─────────────────────────────────────
// Registered Redirect URI of the add-in app registration. Mutates NOTHING
// (decision 7): consent state is derived from token exchanges, so unlike the
// C2C callback (routes/c2c/m365Auth.ts:154) there is no cookie/state binding,
// no token exchange, no DB write — just a human-readable confirmation.
export const clientAiConsentCallbackRoute = new Hono();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

clientAiConsentCallbackRoute.get('/consent/callback', (c) => {
  const granted = (c.req.query('admin_consent') ?? '').toLowerCase() === 'true';
  const error = c.req.query('error') ?? '';
  const description = c.req.query('error_description') ?? '';
  const title = granted ? 'Consent granted' : 'Consent not granted';
  const detail = granted
    ? 'You can close this window, return to Breeze, and click “I’ve granted consent” in the setup wizard.'
    : escapeHtml(description || error || 'Microsoft did not report a granted consent. Close this window and retry from Breeze.');
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} — Breeze AI for Office</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0f17;color:#e5e7eb}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#9ca3af;font-size:.9rem;line-height:1.5}</style>
</head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body>
</html>`;
  return c.html(html, granted ? 200 : 400);
});
