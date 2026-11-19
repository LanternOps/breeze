/**
 * GET /orgs/account-readiness — the Organizations account board's bulk read
 * (spec docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "API: GET /orgs/account-readiness"). Feature #5721, W01.
 *
 * Sibling router mounted under `/orgs` next to orgSummaryRoutes. The path is
 * deliberately NOT `/organizations/account-readiness`: orgRoutes is mounted
 * first and its `/organizations/:id` would capture that literal and answer
 * 404 from its UUID guard.
 *
 * The route validates and pins the partner; services/orgAccountReadinessResponse.ts
 * gates and shapes (shared with the `get_account_readiness` AI tool, W18 #6789)
 * and every query lives in services/orgAccountReadiness.ts. Each optional section is present ONLY
 * when the caller holds the matching `<resource>:read` grant — and, for
 * tickets and invoices, only when the partner runs the native service desk
 * (mirrors OrgOverviewTab's rule). `capabilities` tells the web which sections
 * were computed so it hides those columns rather than rendering zeros.
 * `policies` and `contacts` ride on the `organizations:read` grant the whole
 * route is gated on, so they are always present.
 */
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { buildAccountReadinessResponse } from '../services/orgAccountReadinessResponse';
import { PG_UUID_REGEX } from '../utils/uuid';

/** The web batches by this many ids (spec "States": per 200-id batch). */
export const MAX_ACCOUNT_READINESS_ORG_IDS = 200;

// The response shapes live with the builder (full-control W18, #6789).
export type {
  AccountReadinessCapabilities,
  AccountReadinessOrg,
  AccountReadinessResponse,
} from '../services/orgAccountReadinessResponse';
export type {
  ConnectorSystem,
  ConnectorState,
  IntegrationSystem,
  IntegrationState,
  IntegrationReason,
  Connector as AccountReadinessConnector,
  OrgIntegration as AccountReadinessIntegration,
} from '../services/orgAccountReadinessIntegrations';

export type OrgIdsParse = { ok: true; orgIds: string[] } | { ok: false; error: string };

/**
 * `orgIds` = comma-separated UUIDs, 1–200. The cap counts entries as sent;
 * duplicates are then collapsed (first occurrence wins) and ids lower-cased so
 * they compare equal to the uuid column's text form.
 */
export function parseOrgIdsParam(raw: string | undefined): OrgIdsParse {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, error: 'orgIds is required' };
  if (parts.length > MAX_ACCOUNT_READINESS_ORG_IDS) {
    return { ok: false, error: `orgIds accepts at most ${MAX_ACCOUNT_READINESS_ORG_IDS} ids` };
  }
  if (parts.some((part) => !PG_UUID_REGEX.test(part))) {
    return { ok: false, error: 'orgIds must be comma-separated UUIDs' };
  }
  return { ok: true, orgIds: Array.from(new Set(parts.map((part) => part.toLowerCase()))) };
}

export const orgAccountReadinessRoutes = new Hono();

orgAccountReadinessRoutes.use('*', authMiddleware);

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

orgAccountReadinessRoutes.get(
  '/account-readiness',
  requireScope('partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    // Shape-check BEFORE any DB access (same rule as GET /organizations/:id):
    // a non-UUID reaching a uuid column raises Postgres 22P02, an uncaught 500.
    const parsed = parseOrgIdsParam(c.req.query('orgIds'));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // Whose orgs. Same contract as GET /orgs: a partner token is pinned to its
    // own partner (a `partnerId` query is ignored); system scope must name one.
    let partnerId: string;
    if (auth.scope === 'system') {
      const queryPartnerId = c.req.query('partnerId');
      if (!queryPartnerId) return c.json({ error: 'partnerId is required for system scope' }, 400);
      if (!PG_UUID_REGEX.test(queryPartnerId)) return c.json({ error: 'partnerId must be a UUID' }, 400);
      partnerId = queryPartnerId;
    } else {
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
      partnerId = auth.partnerId;
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const can = (grant: { resource: string; action: string }) =>
      Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));

    const response = await buildAccountReadinessResponse({
      partnerId,
      orgIds: parsed.orgIds,
      // A partner token whose list never resolved gets nothing, not everything.
      accessibleOrgIds: auth.scope === 'system' ? null : (auth.accessibleOrgIds ?? []),
      can,
    });
    return c.json(response);
  },
);
