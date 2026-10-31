/**
 * Alert → PSA ticket configuration API (#10499 W2-A). Dark: this only edits
 * and shows config; nothing creates tickets until W2-B.
 *
 * Mounted from routes/psa.ts at `/psa/connections`:
 *
 * - GET  /:id/alert-ticketing          config + resolver status for the card
 * - PUT  /:id/alert-ticketing          { config, expectedRev, confirmCompanyLinks? }
 *                                      CAS on alert_ticketing_rev (409 on mismatch)
 * - GET  /:id/alert-ticketing/options  board / status / priority pickers, live
 *                                      from the PSA (self-managed DB context)
 *
 * Settings rule 9: home = Integrations → PSA → bound connection → "Alert
 * tickets"; level = partner, no org override; resolver =
 * resolveAlertTicketingConfig.
 *
 * Access: partner/system scope only (org sessions 403). Only a partner-owned
 * connection can auto-ticket. Reads need orgs:read and the connection's
 * partner; writes and the live PSA listing additionally need orgs:write, MFA,
 * an unrestricted site ceiling and canManagePartnerWidePolicies — the same bar
 * as every other partner-wide PSA connection write (routes/psa.ts).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import {
  alertTicketingSchemaFor,
  psaAlertTicketingPutSchema,
  psaProviderIdSchema,
  type ConnectwiseAlertTicketingStored,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
  type AuthContext,
} from '../middleware/auth';
import { requireOrgWideIntegrationAccess } from '../middleware/integrationConnectionScope';
import { userRateLimit } from '../middleware/userRateLimit';
import { db } from '../db';
import { partners, psaConnections } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { createPSAProvider, PsaAdapterError, supportsAlertTicketing } from '../services/psa';
import { PsaConfigError, decryptCredentials } from '../services/psa/credentials';
import {
  psaInstanceKey,
  resolveAlertTicketingConfig,
  type AlertTicketingConnectionRow,
  type AlertTicketingPartnerBinding,
} from '../services/psaAlertTicketing/config';

export const psaAlertTicketingRoutes = new Hono();

// Re-entrant: a no-op when psaRoutes' own authMiddleware already ran.
psaAlertTicketingRoutes.use('*', authMiddleware);

const connectionIdSchema = z.string().uuid();
const optionsQuerySchema = z.object({
  boardId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
});

type ConnectionRow = AlertTicketingConnectionRow & {
  orgId: string | null;
  name: string;
  credentials: unknown;
  alertTicketingEnabledAt: Date | null;
  alertTicketingPausedAt: Date | null;
};

const connectionColumns = {
  id: psaConnections.id,
  orgId: psaConnections.orgId,
  partnerId: psaConnections.partnerId,
  provider: psaConnections.provider,
  name: psaConnections.name,
  credentials: psaConnections.credentials,
  alertTicketing: psaConnections.alertTicketing,
  alertTicketingRev: psaConnections.alertTicketingRev,
  alertTicketingEnabledAt: psaConnections.alertTicketingEnabledAt,
  alertTicketingPausedReason: psaConnections.alertTicketingPausedReason,
  alertTicketingPausedAt: psaConnections.alertTicketingPausedAt,
};

type Loaded = { row: ConnectionRow; binding: AlertTicketingPartnerBinding };
type LoadFailure = { status: 403 | 404; error: string };

/**
 * Load the connection and its owning partner's service-management binding.
 * Invisible rows are 404 (RLS already hides most; this also hides another
 * partner's row from a system-adjacent read path). An org-owned connection the
 * caller can see is 403: it can never auto-ticket.
 */
async function loadTarget(id: string, auth: AuthContext): Promise<Loaded | LoadFailure> {
  if (!connectionIdSchema.safeParse(id).success) return { status: 404, error: 'PSA connection not found' };
  const [row] = await db.select(connectionColumns).from(psaConnections).where(eq(psaConnections.id, id)).limit(1);
  if (!row) return { status: 404, error: 'PSA connection not found' };

  const visible = auth.scope === 'system'
    || (row.partnerId !== null && auth.scope === 'partner' && auth.partnerId === row.partnerId)
    || (row.partnerId === null && row.orgId !== null && auth.canAccessOrg(row.orgId));
  if (!visible) return { status: 404, error: 'PSA connection not found' };
  if (row.partnerId === null) {
    return { status: 403, error: 'Alert tickets can only be configured on a partner-wide PSA connection' };
  }

  const [binding] = await db
    .select({
      serviceManagementMode: partners.serviceManagementMode,
      serviceManagementPsaConnectionId: partners.serviceManagementPsaConnectionId,
    })
    .from(partners)
    .where(eq(partners.id, row.partnerId))
    .limit(1);

  return {
    row: row as ConnectionRow,
    binding: binding ?? { serviceManagementMode: 'native', serviceManagementPsaConnectionId: null },
  };
}

function isFailure(value: Loaded | LoadFailure): value is LoadFailure {
  return 'status' in value;
}

function instanceKeyFor(row: ConnectionRow): string | null {
  return psaInstanceKey(row.provider, decryptCredentials(row.credentials));
}

function auditOwnerFields(row: ConnectionRow) {
  return { orgId: null, ownerScope: 'partner' as const, partnerId: row.partnerId };
}

/** The stored config minus the server-written fingerprint. */
function publicConfig(config: ConnectwiseAlertTicketingStored | null) {
  if (!config) return null;
  const { companyLinksConfirmedFor: _fingerprint, ...rest } = config;
  return rest;
}

function serialize(row: ConnectionRow, binding: AlertTicketingPartnerBinding, instanceKey: string | null, canManage: boolean) {
  const resolved = resolveAlertTicketingConfig(row, binding, instanceKey);
  const provider = psaProviderIdSchema.safeParse(row.provider);
  const capable = provider.success && alertTicketingSchemaFor(provider.data) !== null;
  return {
    connectionId: row.id,
    provider: row.provider,
    capable,
    rev: row.alertTicketingRev,
    config: publicConfig(resolved.config),
    configInvalid: capable && row.alertTicketing !== null && row.alertTicketing !== undefined && resolved.config === null,
    enabledAt: row.alertTicketingEnabledAt,
    paused: row.alertTicketingPausedReason
      ? { reason: row.alertTicketingPausedReason, at: row.alertTicketingPausedAt }
      : null,
    status: resolved.active ? { active: true as const } : { active: false as const, reason: resolved.reason },
    bound: binding.serviceManagementPsaConnectionId === row.id,
    serviceManagementMode: binding.serviceManagementMode,
    companyLinksConfirmed: instanceKey !== null && resolved.config?.companyLinksConfirmedFor === instanceKey,
    canManage,
  };
}

function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key])).sort();
}

psaAlertTicketingRoutes.get(
  '/:id/alert-ticketing',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const loaded = await loadTarget(c.req.param('id')!, auth);
    if (isFailure(loaded)) return c.json({ error: loaded.error }, loaded.status);
    const { row, binding } = loaded;
    return c.json({ data: serialize(row, binding, instanceKeyFor(row), canManagePartnerWidePolicies(auth)) });
  }
);

psaAlertTicketingRoutes.put(
  '/:id/alert-ticketing',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  requireOrgWideIntegrationAccess,
  zValidator('json', psaAlertTicketingPutSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const loaded = await loadTarget(c.req.param('id')!, auth);
    if (isFailure(loaded)) return c.json({ error: loaded.error }, loaded.status);
    const { row, binding } = loaded;

    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const provider = psaProviderIdSchema.safeParse(row.provider);
    const inputSchema = provider.success ? alertTicketingSchemaFor(provider.data) : null;
    if (!inputSchema) {
      return c.json({ error: `Alert tickets are not supported for the ${row.provider} provider` }, 400);
    }
    const parsed = inputSchema.safeParse(body.config);
    if (!parsed.success) {
      return c.json({ error: 'Invalid alert ticketing configuration', issues: parsed.error.issues }, 400);
    }

    if (body.expectedRev !== row.alertTicketingRev) {
      return c.json({
        error: 'Alert ticket settings were changed by someone else. Reload and try again.',
        code: 'alert_ticketing_rev_conflict',
        currentRev: row.alertTicketingRev,
      }, 409);
    }

    const instanceKey = instanceKeyFor(row);
    const previous = resolveAlertTicketingConfig(row, binding, instanceKey).config;
    const previousRaw = (row.alertTicketing && typeof row.alertTicketing === 'object')
      ? row.alertTicketing as Record<string, unknown>
      : null;
    // Keep a prior confirmation even if the rest of the stored blob no longer
    // parses: it is the server's own record, not user input.
    const previousConfirmation = previous?.companyLinksConfirmedFor
      ?? (typeof previousRaw?.companyLinksConfirmedFor === 'string' ? previousRaw.companyLinksConfirmedFor : undefined);

    let companyLinksConfirmedFor = previousConfirmation;
    if (body.confirmCompanyLinks) {
      if (instanceKey === null) {
        return c.json({ error: 'This connection has no usable base URL, so its company links cannot be confirmed' }, 400);
      }
      companyLinksConfirmedFor = instanceKey;
    }
    if (parsed.data.enabled && (instanceKey === null || companyLinksConfirmedFor !== instanceKey)) {
      return c.json({
        error: 'Confirm that the organization company links match this PSA instance before enabling alert tickets.',
        code: 'company_links_confirmation_required',
      }, 422);
    }

    const next: ConnectwiseAlertTicketingStored = {
      ...parsed.data,
      ...(companyLinksConfirmedFor ? { companyLinksConfirmedFor } : {}),
    };
    const previousEnabled = previous?.enabled === true;
    const enabledAt = parsed.data.enabled
      ? (previousEnabled ? row.alertTicketingEnabledAt : new Date())
      : null;

    const [updated] = await db
      .update(psaConnections)
      .set({
        alertTicketing: next,
        alertTicketingRev: sql`${psaConnections.alertTicketingRev} + 1`,
        alertTicketingEnabledAt: enabledAt,
        updatedAt: new Date(),
      })
      .where(and(eq(psaConnections.id, row.id), eq(psaConnections.alertTicketingRev, body.expectedRev)))
      .returning(connectionColumns);

    if (!updated) {
      const [current] = await db
        .select({ rev: psaConnections.alertTicketingRev })
        .from(psaConnections)
        .where(eq(psaConnections.id, row.id))
        .limit(1);
      return c.json({
        error: 'Alert ticket settings were changed by someone else. Reload and try again.',
        code: 'alert_ticketing_rev_conflict',
        currentRev: current?.rev ?? null,
      }, 409);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'psa.alert_ticketing.update',
      resourceType: 'psa_connection',
      resourceId: row.id,
      resourceName: row.name,
      details: {
        enabled: parsed.data.enabled,
        previousEnabled,
        rev: (updated as ConnectionRow).alertTicketingRev,
        confirmCompanyLinks: body.confirmCompanyLinks === true,
        changedKeys: changedKeys(publicConfig(previous), publicConfig(next) ?? {}),
        ...auditOwnerFields(row),
      },
    });

    return c.json({ data: serialize(updated as ConnectionRow, binding, instanceKey, true) });
  }
);

/**
 * Registered in SELF_MANAGED_DB_CONTEXT_ROUTES: it calls the PSA (psaFetch,
 * 20 s timeout, tenant-controlled base URL), so the read runs in a short
 * explicit context and the network calls run outside any transaction (#1105).
 */
psaAlertTicketingRoutes.get(
  '/:id/alert-ticketing/options',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  requireOrgWideIntegrationAccess,
  zValidator('query', optionsQuerySchema),
  // Each call is up to three outbound PSA requests on the partner's behalf.
  userRateLimit('psa-alert-ticketing-options', 120, 3600),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { boardId } = c.req.valid('query');
    const loaded = await withAuthDbAccessContext(auth, () => loadTarget(c.req.param('id')!, auth));
    if (isFailure(loaded)) return c.json({ error: loaded.error }, loaded.status);
    const { row } = loaded;

    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const credentials = decryptCredentials(row.credentials);
    if (!credentials) {
      return c.json({ error: 'PSA connection has no usable credentials' }, 400);
    }

    let client;
    try {
      client = createPSAProvider(row.provider, credentials, {});
    } catch (error) {
      if (error instanceof PsaConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
    if (!supportsAlertTicketing(client)) {
      return c.json({ error: `Alert tickets are not supported for the ${row.provider} provider` }, 400);
    }

    try {
      const [boards, priorities, statuses] = await Promise.all([
        client.listBoards(),
        client.listPriorities(),
        boardId !== undefined ? client.listStatuses(boardId) : Promise.resolve(null),
      ]);
      return c.json({ data: { boards, priorities, statuses } });
    } catch (error) {
      if (error instanceof PsaAdapterError) {
        // `message` never carries the PSA body; `detail` is the scrubbed,
        // capped snippet, shown only to this partner admin.
        return c.json({ error: error.message, errorClass: error.errorClass, detail: error.bodySnippet }, 502);
      }
      throw error;
    }
  }
);
