/**
 * Alert → PSA ticket configuration and human-action API (#10499).
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
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  alertTicketingSchemaFor,
  psaAlertTicketingPutSchema,
  psaProviderIdSchema,
  type ConnectwiseAlertTicketingStored,
} from '@breeze/shared';
import { zValidator, optionalJsonValidator } from '../lib/validation';
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
import { partners, psaConnections, psaTicketMappings } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { createPSAProvider, PsaAdapterError, supportsAlertTicketing } from '../services/psa';
import { PsaConfigError, decryptCredentials } from '../services/psa/credentials';
import {
  alertTicketingCredentialState,
  resolveAlertTicketingConfig,
  type AlertTicketingConnectionRow,
  type AlertTicketingCredentialState,
  type AlertTicketingPartnerBinding,
} from '../services/psaAlertTicketing/config';

import { wakeMapping } from '../services/psaAlertTicketing/queue';

export const psaAlertTicketingRoutes = new Hono();
/** Mounted at /psa, since these actions are keyed by mapping, not connection. */
export const psaTicketMappingActionRoutes = new Hono();
psaTicketMappingActionRoutes.use('*', authMiddleware);

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

function credentialStateFor(row: ConnectionRow): AlertTicketingCredentialState {
  return alertTicketingCredentialState(row.provider, decryptCredentials(row.credentials));
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

function serialize(row: ConnectionRow, binding: AlertTicketingPartnerBinding, credentials: AlertTicketingCredentialState, canManage: boolean) {
  const resolved = resolveAlertTicketingConfig(row, binding, credentials);
  const { instanceKey } = credentials;
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
    return c.json({ data: serialize(row, binding, credentialStateFor(row), canManagePartnerWidePolicies(auth)) });
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

    const credentialState = credentialStateFor(row);
    const { instanceKey } = credentialState;
    const previous = resolveAlertTicketingConfig(row, binding, credentialState).config;
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

    return c.json({ data: serialize(updated as ConnectionRow, binding, credentialState, true) });
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
        // Logged without the snippet: logs and Sentry never carry PSA bodies.
        console.warn('[psa-alert-ticketing] PSA picker listing failed', {
          connectionId: row.id,
          provider: row.provider,
          errorClass: error.errorClass,
          httpStatus: error.httpStatus,
        });
        if (error.retryAfterMs !== null) {
          c.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        }
        // `message` never carries the PSA body; `detail` is the scrubbed,
        // capped snippet, shown only to this partner admin.
        return c.json({ error: error.message, errorClass: error.errorClass, detail: error.bodySnippet }, 502);
      }
      throw error;
    }
  }
);

const redriveSchema = z.object({ states: z.array(z.enum(['failed', 'skipped_no_company'])).min(1).max(2) });
const handledSchema = z.object({ expectedState: z.enum(['failed', 'skipped_no_company', 'needs_attention']) });
const humanActionGates = () => [
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  requireOrgWideIntegrationAccess,
] as const;
const unleased = () => or(isNull(psaTicketMappings.leaseUntil), sql`${psaTicketMappings.leaseUntil} <= now()`);

function rearmValues() {
  return {
    createState: 'never_attempted' as const,
    nextAttemptAt: new Date(), deadlineAt: new Date(Date.now() + 24 * 3600000),
    leaseToken: null, leaseUntil: null, lastError: null, lastErrorClass: null,
    // Keep the permanent human-retry marker while starting a fresh retry window.
    createSnapshot: sql`coalesce(${psaTicketMappings.createSnapshot}, '{}'::jsonb) - 'operationAttempts' - 'unknownDeadline'`,
    updatedAt: new Date(),
  };
}

const WAKE_TIMEOUT_MS = 2_000;
const MAX_REQUEST_WAKES = 100;

/**
 * Best-effort, bounded worker wake after a committed human action. The ledger
 * is authoritative: the 2-minute reconciler (`dueMappings`) picks up any
 * unleased, due `never_attempted` row, so a lost, slow or skipped wake costs
 * at most one sweep. The BullMQ connection keeps an offline queue, so `add()`
 * can hang rather than reject while Redis is down; each wake is time-boxed and
 * a large re-drive wakes only the first MAX_REQUEST_WAKES rows.
 */
async function wakeHumanActions(ids: string[]) {
  const woken = ids.slice(0, MAX_REQUEST_WAKES);
  const results = await Promise.allSettled(woken.map(id => Promise.race([
    wakeMapping(id, 'create'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`wake timed out after ${WAKE_TIMEOUT_MS} ms`)), WAKE_TIMEOUT_MS).unref?.()),
  ])));
  const failed = woken.filter((_, i) => results[i]!.status === 'rejected');
  if (failed.length > 0) {
    const first = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    console.warn('[psa-ticketing] human action wake failed; the reconciler will pick these up', {
      mappingIds: failed, message: first.reason instanceof Error ? first.reason.message : String(first.reason),
    });
  }
}

psaAlertTicketingRoutes.post('/:id/alert-ticketing/redrive', ...humanActionGates(),
  zValidator('json', redriveSchema), async c => {
    const auth = c.get('auth') as AuthContext;
    const loaded = await loadTarget(c.req.param('id')!, auth);
    if (isFailure(loaded)) return c.json({ error: loaded.error }, loaded.status);
    if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const { states } = c.req.valid('json');
    const rows = await db.update(psaTicketMappings).set(rearmValues())
      .where(and(eq(psaTicketMappings.connectionId, loaded.row.id), inArray(psaTicketMappings.createState, states), unleased()))
      .returning({ id: psaTicketMappings.id });
    if (!rows.length) return c.json({ error: 'No alert tickets remain in the requested states. Reload and try again.' }, 409);
    writeRouteAudit(c, { orgId: null, action: 'psa.alert_ticketing.redrive', resourceType: 'psa_connection', resourceId: loaded.row.id,
      details: { states, count: rows.length, ...auditOwnerFields(loaded.row) } });
    await wakeHumanActions(rows.map(row => row.id));
    return c.json({ data: { count: rows.length } });
  });

for (const action of ['create-anyway', 'mark-handled'] as const) {
  psaTicketMappingActionRoutes.post(`/ticket-mappings/:id/${action}`, ...humanActionGates(),
    optionalJsonValidator(action === 'mark-handled' ? handledSchema : z.object({})), async c => {
      const auth = c.get('auth') as AuthContext;
      const id = c.req.param('id')!;
      if (!connectionIdSchema.safeParse(id).success) return c.json({ error: 'PSA ticket mapping not found' }, 404);
      const [mapping] = await db.select({ id: psaTicketMappings.id, connectionId: psaTicketMappings.connectionId,
        createState: psaTicketMappings.createState, createSnapshot: psaTicketMappings.createSnapshot })
        .from(psaTicketMappings).where(eq(psaTicketMappings.id, id)).limit(1);
      if (!mapping) return c.json({ error: 'PSA ticket mapping not found' }, 404);
      const loaded = await loadTarget(mapping.connectionId, auth);
      if (isFailure(loaded)) return c.json({ error: loaded.error }, loaded.status);
      if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      const body = c.req.valid('json');
      const expectedState = action === 'create-anyway' ? 'needs_attention' as const : handledSchema.parse(body).expectedState;
      if (mapping.createState !== expectedState || (action === 'create-anyway' && mapping.createSnapshot?.createAnywayUsed)) {
        return c.json({ error: 'This action is no longer available. Reload the alert tickets.' }, 409);
      }
      // No migration: create_snapshot carries a permanent retry-consumed marker.
      // The same state-and-marker CAS both consumes it and rearms the row, so
      // concurrent clicks and a later second needs_attention cannot authorize
      // another uncertain create. Worker refresh/reconciliation preserve it.
      const values = action === 'create-anyway' ? {
        ...rearmValues(),
        createSnapshot: sql`(coalesce(${psaTicketMappings.createSnapshot}, '{}'::jsonb) - 'operationAttempts' - 'unknownDeadline') || '{"createAnywayUsed":true}'::jsonb`,
      } : { createState: 'handled' as const, nextAttemptAt: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() };
      const [updated] = await db.update(psaTicketMappings).set(values)
        .where(and(eq(psaTicketMappings.id, id), eq(psaTicketMappings.connectionId, loaded.row.id),
          eq(psaTicketMappings.createState, expectedState), unleased(),
          action === 'create-anyway' ? sql`coalesce(${psaTicketMappings.createSnapshot}->>'createAnywayUsed', 'false') <> 'true'` : undefined))
        .returning({ id: psaTicketMappings.id, connectionId: psaTicketMappings.connectionId, createState: psaTicketMappings.createState });
      if (!updated) return c.json({ error: 'This action is no longer available. Reload the alert tickets.' }, 409);
      writeRouteAudit(c, { orgId: null, action: `psa.alert_ticketing.${action.replace('-', '_')}`, resourceType: 'psa_ticket_mapping', resourceId: id,
        details: { previousState: expectedState, connectionId: loaded.row.id, ...auditOwnerFields(loaded.row) } });
      if (action === 'create-anyway') await wakeHumanActions([id]);
      return c.json({ data: updated });
    });
}
