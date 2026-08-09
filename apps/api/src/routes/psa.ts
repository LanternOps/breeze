import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { psaProviderIdSchema, type PsaProviderId } from '@breeze/shared';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
  type AuthContext
} from '../middleware/auth';
import { db } from '../db';
import { devices, organizations, psaConnections as psaConnectionsTable, psaTicketMappings } from '../db/schema';
import { userRateLimit } from '../middleware/userRateLimit';
import { writeRouteAudit } from '../services/auditEvents';
import { MAX_IMPORT_ROWS, commitOrgImport, previewOrgImport } from '../services/orgImport';
import { writeOrgImportAudits } from '../services/orgImport/audit';
import { commitImportRowSchema } from '../services/orgImport/schemas';
import {
  createPsaCompanyImportSource,
  type PsaCompanyImportSource
} from '../services/psa/companyImport';
import { PsaCursorOriginError } from '../services/psa/pagination';
import {
  PsaCapabilityError,
  isOrgImportCapableProvider,
  type OrgImportCapablePsaProvider
} from '../services/psa/types';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../services/permissions';
import {
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  canManagePartnerWidePolicies
} from '../services/partnerWideAccess';
import { createPSAProvider } from '../services/psa';
import { psaTicketMappingOrgCondition } from '../services/psa/ticketScope';
import {
  PsaConfigError,
  decryptCredentials,
  encryptCredentials,
  mergeProviderCredentials,
  validateProviderCredentials,
  validatePsaCredentialBaseUrl
} from '../services/psa/credentials';

export const psaRoutes = new Hono();

type PsaProvider = PsaProviderId;

// Single-source provider list — @breeze/shared PSA_PROVIDERS. The DB enum is
// intentionally wider (halo/syncro/kaseya/other are dead values); this schema
// is the gate.
const providerSchema = psaProviderIdSchema;

const listConnectionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  provider: providerSchema.optional()
});

const createConnectionSchema = z.object({
  // Ownership axis (epic #2135). Absent => 'organization', preserving the
  // pre-#2135 behaviour for every existing API client. The WEB form defaults
  // its selector to 'partner' (an MSP's PSA is normally partner-wide), but the
  // wire default stays org-scoped so an unaware caller can never accidentally
  // publish a credential to every org under the partner.
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  provider: providerSchema,
  name: z.string().min(1).max(255),
  credentials: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ),
  settings: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional().default({})
});

// Ownership is immutable after create — there is deliberately no `ownerScope`
// (nor `orgId`/`partnerId`) here. Re-homing a connection would silently move
// every psa_ticket_mappings child across a tenant boundary, and this schema is
// hand-written rather than derived via `.partial()`, so there is nothing to
// `.omit({ ownerScope: true })` from.
const updateConnectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  credentials: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional(),
  settings: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional()
});

const listTicketsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// `partnerId`/`orgId` are nullable in Postgres; accept `undefined` too so a
// partially-selected row can never be misread as partner-owned.
type ConnectionOwner = { orgId?: string | null; partnerId?: string | null };

/** The partner that owns this row, or null when it is org-owned. */
function ownerPartnerId(connection: ConnectionOwner): string | null {
  return connection.partnerId ?? null;
}

type OrgAccessAuth = Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>;

async function ensureOrgAccess(orgId: string, auth: OrgAccessAuth) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  return true;
}

/**
 * Dual-axis access check for one connection row (epic #2135). Replaces the
 * org-only `ensureOrgAccess(connection.orgId, ...)` — a partner-owned row has
 * `orgId === null`, which the org check can only ever reject.
 *
 * The partner arm is gated on `auth.scope === 'partner'`. An ORG-scope token
 * carries a partnerId but never passes `breeze_has_partner_access`, so allowing
 * it here would let the app layer approve a read that RLS then returns empty
 * for — a confusing 200-with-no-rows instead of an honest 403. RLS is strictly
 * stricter than this check; the two are NOT at parity and this function must
 * never be described as enforcing isolation on its own.
 */
async function ensureConnectionAccess(
  connection: ConnectionOwner,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg' | 'partnerId'>
) {
  if (auth.scope === 'system') return true;

  const partnerId = ownerPartnerId(connection);
  if (partnerId !== null) {
    return auth.scope === 'partner' && auth.partnerId === partnerId;
  }

  if (!connection.orgId) return false;
  return ensureOrgAccess(connection.orgId, auth);
}

/**
 * WHERE fragment restricting a psa_connections query to what `auth` may see:
 * the caller's own orgs, OR (partner scope only) the partner's partner-wide
 * rows. `undefined` means system scope — no filter.
 *
 * Mirrors `softwarePolicyAccessCondition` in routes/softwarePolicies.ts.
 */
function psaConnectionAccessCondition(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgCondition'>
): SQL | undefined {
  const orgCond = auth.orgCondition(psaConnectionsTable.orgId);
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${psaConnectionsTable.orgId} IS NULL AND ${psaConnectionsTable.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/** 'partner' when the row is partner-wide ("All orgs"), else 'organization'. */
function ownerScopeOf(connection: ConnectionOwner): 'organization' | 'partner' {
  return ownerPartnerId(connection) !== null ? 'partner' : 'organization';
}

/**
 * True when the caller may SEE this connection but must not MUTATE it because
 * it is partner-wide and they lack full partner org access (epic #2135).
 *
 * Applied to update, delete, status AND test. Status is an update by another
 * name — pausing a partner-wide connection pauses it for every org — and test
 * both writes `syncSettings.lastTestedAt/status` and exercises the MSP's own
 * PSA credentials, so a 'selected'-access partner user is held to the same bar.
 */
function partnerWideWriteBlocked(
  connection: ConnectionOwner,
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess'>
): boolean {
  return ownerPartnerId(connection) !== null && !canManagePartnerWidePolicies(auth);
}

/**
 * Audit anchor for a connection. A partner-wide row has no org, so the audit
 * row carries org_id NULL (RouteAuditInput allows it) and the partner id lands
 * in `details` — otherwise the erasure/forensic trail loses the owner entirely.
 */
function auditOwnerFields(connection: ConnectionOwner) {
  return {
    orgId: connection.orgId ?? null,
    ownerScope: ownerScopeOf(connection),
    partnerId: ownerPartnerId(connection)
  };
}

function extractLastTestedAt(syncSettings: unknown): Date | null {
  if (!syncSettings || typeof syncSettings !== 'object' || Array.isArray(syncSettings)) {
    return null;
  }

  const value = (syncSettings as Record<string, unknown>).lastTestedAt;
  if (typeof value !== 'string') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mergeObjectState(
  source: unknown,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const base = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {};

  return {
    ...base,
    ...patch
  };
}

// Round-trip contract with the web form (PsaConnectionsPage/PsaConnectionForm):
// non-secret credential fields are returned for edit prefill; secrets are NEVER
// returned — only per-field presence flags (`credentialFields`) so the form can
// show "keep existing". BOTH are gated on orgs:write — see GET /connections/:id.
const PSA_PUBLIC_CREDENTIAL_KEYS = [
  'baseUrl',
  'username',
  'email',
  'clientId',
  'companyId',
  'publicKey'
] as const;
const PSA_SECRET_CREDENTIAL_KEYS = [
  'password',
  'apiToken',
  'clientSecret',
  'privateKey',
  'secret',
  'integrationCode',
  'apiKey',
  'personalAccessToken'
] as const;

/**
 * Is the stored credential blob non-empty? Deliberately does NOT decrypt — the
 * list endpoint serializes up to 100 rows and only needs the boolean.
 */
function hasStoredCredentials(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.encrypted === 'string') return record.encrypted.length > 0;
    return Object.keys(record).length > 0;
  }
  return false;
}

function deriveConnectionStatus(settings: unknown): 'active' | 'paused' | 'error' {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const status = (settings as Record<string, unknown>).status;
    if (status === 'paused' || status === 'error') return status;
  }
  return 'active';
}

function serializeConnection(
  connection: {
    id: string;
    orgId: string | null;
    partnerId: string | null;
    provider: string;
    name: string;
    credentials: unknown;
    settings: unknown;
    syncSettings: unknown;
    createdAt: Date;
    updatedAt: Date;
    lastSyncAt: Date | null;
  },
  includeCredentialInfo: boolean
) {
  const settings = (connection.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings))
    ? connection.settings as Record<string, unknown>
    : {};

  const response = {
    id: connection.id,
    // NULL for a partner-wide connection (epic #2135). Kept in the response —
    // removing a field is a breaking public-API change — but consumers should
    // branch on `ownerScope`, not on `orgId == null`.
    orgId: connection.orgId,
    ownerScope: ownerScopeOf(connection),
    provider: connection.provider,
    name: connection.name,
    status: deriveConnectionStatus(settings),
    settings,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastTestedAt: extractLastTestedAt(connection.syncSettings),
    // Whether ANY credential material is stored. Part of the pre-existing
    // public shape — every list/detail consumer sees it, no permission gate.
    hasCredentials: hasStoredCredentials(connection.credentials),
    // DEPRECATED and frozen: nothing writes psa_connections.last_sync_at any
    // more (POST /connections/:id/sync returns 501 — there is no sync worker),
    // so this is null on every connection created since. Kept because removing
    // a response field is a breaking public-API change.
    lastSyncedAt: connection.lastSyncAt ?? null
  };

  if (!includeCredentialInfo) {
    return response;
  }

  const decrypted = decryptCredentials(connection.credentials) ?? {};
  const credentials: Record<string, string> = {};
  for (const key of PSA_PUBLIC_CREDENTIAL_KEYS) {
    const value = decrypted[key];
    if (typeof value === 'string' && value.length > 0) {
      credentials[key] = value;
    }
  }

  // Per-field presence of the SECRET keys — named `credentialFields` to keep it
  // distinct from the `hasCredentials` boolean above, which is a different
  // question with a different audience.
  const credentialFields = Object.fromEntries(
    PSA_SECRET_CREDENTIAL_KEYS.map((key) => {
      const value = decrypted[key];
      return [key, typeof value === 'string' ? value.length > 0 : Boolean(value)];
    })
  ) as Record<(typeof PSA_SECRET_CREDENTIAL_KEYS)[number], boolean>;

  return {
    ...response,
    credentials,
    credentialFields
  };
}

function mapTicketRow(row: {
  id: string;
  connectionId: string;
  externalTicketId: string | null;
  externalTicketUrl: string | null;
  status: string | null;
  alertId: string | null;
  deviceId: string | null;
  lastSyncAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}) {
  const syncedAt = row.lastSyncAt ?? row.updatedAt ?? row.createdAt;

  return {
    id: row.id,
    psaId: row.connectionId,
    title: row.externalTicketId ? `Ticket ${row.externalTicketId}` : `Ticket ${row.id.slice(0, 8)}`,
    status: row.status ?? undefined,
    syncedAt,
    raw: {
      externalTicketId: row.externalTicketId,
      externalTicketUrl: row.externalTicketUrl,
      alertId: row.alertId,
      deviceId: row.deviceId
    }
  };
}

// `resolveOrgIds` used to live here. It returned a flat org-id list and every
// caller turned that into `inArray(psa_connections.org_id, ids)` — the exact
// org-only shape that made partner-wide connections invisible. Both call sites
// now use psaConnectionAccessCondition (config visibility) or
// psaTicketMappingOrgCondition (ticket data), so the helper is deleted rather
// than left around for the next endpoint to copy.

async function getConnectionById(id: string) {
  const [connection] = await db
    .select({
      id: psaConnectionsTable.id,
      orgId: psaConnectionsTable.orgId,
      partnerId: psaConnectionsTable.partnerId,
      provider: psaConnectionsTable.provider,
      name: psaConnectionsTable.name,
      credentials: psaConnectionsTable.credentials,
      settings: psaConnectionsTable.settings,
      syncSettings: psaConnectionsTable.syncSettings,
      createdAt: psaConnectionsTable.createdAt,
      updatedAt: psaConnectionsTable.updatedAt,
      lastSyncAt: psaConnectionsTable.lastSyncAt
    })
    .from(psaConnectionsTable)
    .where(eq(psaConnectionsTable.id, id))
    .limit(1);

  return connection ?? null;
}

psaRoutes.use('*', authMiddleware);

psaRoutes.get(
  '/connections',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listConnectionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    const conditions: SQL[] = [];

    if (query.orgId) {
      // Explicit org filter. A partner-wide connection genuinely serves this
      // org, so it stays in the result — dropping it here would recreate the
      // exact "partner-wide row is invisible to the partner that made it" bug
      // this change exists to fix. Partner arm gated on partner scope.
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      const orgFilter = eq(psaConnectionsTable.orgId, query.orgId);
      conditions.push(
        auth.scope === 'partner' && auth.partnerId
          ? sql`(${orgFilter} OR (${psaConnectionsTable.orgId} IS NULL AND ${psaConnectionsTable.partnerId} = ${auth.partnerId}))`
          : orgFilter
      );
    } else {
      // No explicit filter: everything the caller may see on EITHER axis.
      const accessCondition = psaConnectionAccessCondition(auth);
      if (accessCondition) conditions.push(accessCondition);
    }

    if (query.provider) {
      conditions.push(eq(psaConnectionsTable.provider, query.provider as any));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: psaConnectionsTable.id,
        orgId: psaConnectionsTable.orgId,
        partnerId: psaConnectionsTable.partnerId,
        provider: psaConnectionsTable.provider,
        name: psaConnectionsTable.name,
        credentials: psaConnectionsTable.credentials,
        settings: psaConnectionsTable.settings,
        syncSettings: psaConnectionsTable.syncSettings,
        createdAt: psaConnectionsTable.createdAt,
        updatedAt: psaConnectionsTable.updatedAt,
        lastSyncAt: psaConnectionsTable.lastSyncAt
      })
      .from(psaConnectionsTable)
      .where(whereClause)
      .orderBy(desc(psaConnectionsTable.updatedAt))
      .limit(limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(psaConnectionsTable)
      .where(whereClause);

    return c.json({
      data: rows.map((row) => serializeConnection(row, false)),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);

psaRoutes.post(
  '/connections',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Ownership axis (epic #2135). A partner-wide connection publishes ONE set
    // of PSA credentials to every org under the partner — including orgs
    // created later — so creating one is gated on the partner-wide capability.
    // The partner is ALWAYS derived from the caller's own token, never from the
    // request body.
    let owner: ConnectionOwner;

    if (data.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide PSA connections require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      let orgId = data.orgId;

      if (auth.scope === 'organization') {
        if (!auth.orgId) {
          return c.json({ error: 'Organization context required' }, 403);
        }
        orgId = auth.orgId;
      } else if (auth.scope === 'partner') {
        if (!orgId) {
          const singleOrg = auth.accessibleOrgIds?.[0];
          if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
            orgId = singleOrg;
          } else {
            return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
          }
        }
        const hasAccess = await ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
      } else if (auth.scope === 'system' && !orgId) {
        return c.json({ error: 'orgId is required for system scope' }, 400);
      }

      if (!orgId) {
        return c.json({ error: 'orgId is required for an organization-owned connection' }, 400);
      }
      owner = { orgId, partnerId: null };
    }

    const baseUrlError = validatePsaCredentialBaseUrl(data.credentials);
    if (baseUrlError) {
      return c.json({ error: baseUrlError }, 400);
    }

    // Validate at SAVE time, not just at adapter-construction (test) time —
    // otherwise a misconfigured blob persists happily and only surfaces as a
    // 400 the first time someone presses Test. Create always has the full set
    // of credentials in hand, so it always validates. The stored blob stays the
    // raw payload: normalization (jira `type` inference, alias backfill) is
    // derived per use, never frozen into the row.
    try {
      validateProviderCredentials(data.provider, data.credentials);
    } catch (error) {
      if (error instanceof PsaConfigError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    const credentialsEncrypted = encryptCredentials(data.credentials);
    if (!credentialsEncrypted) {
      return c.json({ error: 'Failed to encrypt credentials' }, 500);
    }

    const [connection] = await db
      .insert(psaConnectionsTable)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        provider: data.provider as PsaProvider,
        name: data.name,
        credentials: credentialsEncrypted,
        settings: data.settings ?? {},
        syncSettings: {},
        createdBy: auth.user.id,
        updatedAt: new Date()
      })
      .returning({
        id: psaConnectionsTable.id,
        orgId: psaConnectionsTable.orgId,
        partnerId: psaConnectionsTable.partnerId,
        provider: psaConnectionsTable.provider,
        name: psaConnectionsTable.name,
        credentials: psaConnectionsTable.credentials,
        settings: psaConnectionsTable.settings,
        syncSettings: psaConnectionsTable.syncSettings,
        createdAt: psaConnectionsTable.createdAt,
        updatedAt: psaConnectionsTable.updatedAt,
        lastSyncAt: psaConnectionsTable.lastSyncAt
      });

    if (!connection) {
      return c.json({ error: 'Failed to create PSA connection' }, 500);
    }

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.create',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name,
      details: { provider: connection.provider, ...auditOwnerFields(connection) }
    });

    return c.json(serializeConnection(connection, false), 201);
  }
);

psaRoutes.get(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

    const connection = await getConnectionById(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureConnectionAccess(connection, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // The credential prefill block (non-secret fields) and the per-field
    // `credentialFields` presence map exist to drive the EDIT form, so they are
    // gated on orgs:write. A caller holding only orgs:read never sees decrypted
    // material or which auth mode a connection is configured with (#3291
    // review) — `requirePermission(ORGS_READ)` above has already resolved and
    // cached the permission set on the context.
    //
    // orgs:write is necessary but NOT sufficient (epic #2135): a partner user
    // without full partner org access is refused every mutation on a
    // partner-wide connection, so handing them the edit-form prefill would
    // leak exactly the material #3291 gated to someone who cannot use it. The
    // prefill gate must therefore mirror the write gate, not just the
    // permission.
    const perms = c.get('permissions') as UserPermissions | undefined;
    const canManage = (perms
      ? hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)
      : false) && !partnerWideWriteBlocked(connection, auth);

    return c.json({ data: serializeConnection(connection, canManage) });
  }
);

psaRoutes.patch(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', updateConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureConnectionAccess(existing, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (partnerWideWriteBlocked(existing, auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date()
    };

    if (data.name !== undefined) {
      updates.name = data.name;
    }

    if (data.credentials !== undefined) {
      // Merge-with-existing semantics: keys present in the patch overwrite,
      // `null` deletes a key, absent keys keep their stored value. This lets
      // the edit form omit untouched secrets without wiping them.
      //
      // The merge is AUTH-GROUP AWARE (see CREDENTIAL_AUTH_GROUPS in
      // services/psa/credentials.ts): supplying any key of one mutually
      // exclusive auth group clears the others. A plain merge trapped stale
      // material — rotating a Jira connection from a personal access token to
      // username/password kept the PAT, which the adapter keeps preferring, so
      // the rotation silently did nothing (#3291 review).
      const existingCredentials = decryptCredentials(existing.credentials) ?? {};
      const merged = mergeProviderCredentials(existing.provider, existingCredentials, data.credentials);

      const baseUrlError = validatePsaCredentialBaseUrl(merged);
      if (baseUrlError) {
        return c.json({ error: baseUrlError }, 400);
      }

      // Validate the POST-MERGE blob — only reachable when this PATCH actually
      // writes credentials. A rename-only PATCH deliberately skips validation
      // so legacy-shaped stored blobs stay editable.
      try {
        validateProviderCredentials(existing.provider, merged);
      } catch (error) {
        if (error instanceof PsaConfigError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }

      const encrypted = encryptCredentials(merged);
      if (!encrypted) {
        return c.json({ error: 'Failed to encrypt credentials' }, 500);
      }
      updates.credentials = encrypted;
    }

    if (data.settings !== undefined) {
      // Shallow MERGE, not replace — same semantics as the credentials merge
      // above. `settings.status` is written by POST /connections/:id/status and
      // is NOT part of the edit form's payload, so a wholesale replace silently
      // reactivated a paused connection on any rename (#3291 review).
      updates.settings = mergeObjectState(existing.settings, data.settings);
    }

    const [updated] = await db
      .update(psaConnectionsTable)
      .set(updates)
      .where(eq(psaConnectionsTable.id, connectionId))
      .returning({
        id: psaConnectionsTable.id,
        orgId: psaConnectionsTable.orgId,
        partnerId: psaConnectionsTable.partnerId,
        provider: psaConnectionsTable.provider,
        name: psaConnectionsTable.name,
        credentials: psaConnectionsTable.credentials,
        settings: psaConnectionsTable.settings,
        syncSettings: psaConnectionsTable.syncSettings,
        createdAt: psaConnectionsTable.createdAt,
        updatedAt: psaConnectionsTable.updatedAt,
        lastSyncAt: psaConnectionsTable.lastSyncAt
      });

    if (!updated) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'psa.connection.update',
      resourceType: 'psa_connection',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(data), ...auditOwnerFields(updated) }
    });

    return c.json(serializeConnection(updated, false));
  }
);

psaRoutes.delete(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureConnectionAccess(existing, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (partnerWideWriteBlocked(existing, auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    await db.delete(psaTicketMappings).where(eq(psaTicketMappings.connectionId, connectionId));
    await db.delete(psaConnectionsTable).where(eq(psaConnectionsTable.id, connectionId));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.delete',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name,
      details: { ...auditOwnerFields(existing) }
    });

    return c.json({ success: true });
  }
);

/**
 * POST /connections/:id/test is registered in SELF_MANAGED_DB_CONTEXT_ROUTES
 * (#1448 / #1105 class) — it makes a REAL outbound HTTP call to the PSA
 * (psaFetch, 20s timeout, tenant-controlled baseUrl), so the auth middleware
 * does NOT wrap this route in the usual request transaction. Reads/writes run
 * in short explicit contexts (`withAuthDbAccessContext`) built from the same
 * fields the middleware would have used, with the network call between them.
 */
psaRoutes.post(
  '/connections/:id/test',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

    // Short, explicit DB context — no ambient request transaction here (#1448).
    const existing = await withAuthDbAccessContext(auth, () => getConnectionById(connectionId));
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureConnectionAccess(existing, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (partnerWideWriteBlocked(existing, auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const credentials = decryptCredentials(existing.credentials);
    if (!credentials) {
      return c.json({ error: 'PSA connection has no usable credentials' }, 400);
    }

    const settings = (existing.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings))
      ? existing.settings as Record<string, unknown>
      : {};

    let providerClient;
    try {
      providerClient = createPSAProvider(existing.provider, credentials, settings);
    } catch (error) {
      if (error instanceof PsaConfigError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    // Real connectivity test — runs OUTSIDE any DB context (adapters return
    // {success, message} instead of throwing, but guard anyway).
    let result: { success: boolean; message?: string };
    try {
      result = await providerClient.testConnection();
    } catch (error) {
      result = {
        success: false,
        message: error instanceof Error ? error.message : 'Connection test failed'
      };
    }

    // Persist the outcome in a second short context. Best-effort: a DB hiccup
    // here must not mask the actual test result.
    try {
      await withAuthDbAccessContext(auth, () =>
        db
          .update(psaConnectionsTable)
          .set({
            syncSettings: mergeObjectState(existing.syncSettings, {
              lastTestedAt: new Date().toISOString(),
              status: result.success ? 'verified' : 'failed'
            }),
            updatedAt: new Date()
          })
          .where(eq(psaConnectionsTable.id, existing.id))
      );
    } catch (persistError) {
      console.error('[psa] Failed to persist connection test outcome', { connectionId: existing.id, persistError });
    }

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.test',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name,
      details: { success: result.success, ...auditOwnerFields(existing) },
      result: result.success ? 'success' : 'failure'
    });

    if (!result.success) {
      // HTTP 200 with success:false — the web page's TestResult consumer keys
      // off the body, and runAction-style callers treat {success:false} as failure.
      return c.json({
        success: false,
        error: result.message || 'Connection test failed'
      });
    }

    return c.json({
      success: true,
      message: result.message || 'Credentials verified'
    });
  }
);

psaRoutes.post(
  '/connections/:id/sync',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    // Honest 501: no PSA sync worker exists. The previous implementation wrote
    // lastSyncStatus='queued' that nothing ever consumed. The route stays
    // registered so clients get a clear "not implemented" instead of a 404.
    return c.json({ error: 'PSA ticket sync is not implemented yet' }, 501);
  }
);

psaRoutes.post(
  '/connections/:id/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureConnectionAccess(existing, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (partnerWideWriteBlocked(existing, auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const body = await c.req.json<{ status: string }>();

    await db
      .update(psaConnectionsTable)
      .set({
        settings: mergeObjectState(existing.settings, { status: body.status }),
        syncSettings: mergeObjectState(existing.syncSettings, { status: body.status }),
        updatedAt: new Date()
      })
      .where(eq(psaConnectionsTable.id, existing.id));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.status.update',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name,
      details: { status: body.status, ...auditOwnerFields(existing) }
    });

    return c.json({ success: true, status: body.status });
  }
);

psaRoutes.get(
  '/tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listTicketsSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: SQL[] = [];
    // Tenancy comes from the MAPPING's own org anchors, not from the connection.
    //
    // There is deliberately NO innerJoin on psa_connections any more. That join
    // could not coexist with correct org-scope behaviour: psa_connections RLS
    // (rightly) hides partner-wide rows from org tokens, so the join silently
    // dropped every ticket about an org's OWN device whenever the MSP's PSA was
    // partner-wide — the connection was invisible, so the ticket vanished with
    // it. Scoping the mapping rows directly fixes that and is also what closes
    // the cross-org leak, since the connection arm alone cannot express
    // org_access='selected'. psa_ticket_mappings RLS still bounds the partner.
    const ticketOrgCondition = psaTicketMappingOrgCondition(auth.accessibleOrgIds);
    if (ticketOrgCondition) conditions.push(ticketOrgCondition);
    if (perms?.allowedSiteIds) {
      conditions.push(or(
        isNull(psaTicketMappings.deviceId),
        inArray(devices.siteId, perms.allowedSiteIds)
      )!);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rowsQuery = db
      .select({
        id: psaTicketMappings.id,
        connectionId: psaTicketMappings.connectionId,
        externalTicketId: psaTicketMappings.externalTicketId,
        externalTicketUrl: psaTicketMappings.externalTicketUrl,
        status: psaTicketMappings.status,
        alertId: psaTicketMappings.alertId,
        deviceId: psaTicketMappings.deviceId,
        lastSyncAt: psaTicketMappings.lastSyncAt,
        updatedAt: psaTicketMappings.updatedAt,
        createdAt: psaTicketMappings.createdAt
      })
      .from(psaTicketMappings);
    const rows = await (perms?.allowedSiteIds
      ? rowsQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : rowsQuery.where(whereClause))
      .orderBy(desc(psaTicketMappings.updatedAt))
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(psaTicketMappings);
    const countRows = await (perms?.allowedSiteIds
      ? countQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : countQuery.where(whereClause));

    return c.json({
      data: rows.map(mapTicketRow),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);

psaRoutes.get(
  '/connections/:id/tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listTicketsSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const connectionId = c.req.param('id')!;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const connection = await getConnectionById(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureConnectionAccess(connection, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const conditions: SQL[] = [eq(psaTicketMappings.connectionId, connectionId)];
    // `ensureConnectionAccess` above proves the caller may see the CONNECTION.
    // It says nothing about which orgs' ticket DATA they may read: for a
    // partner-wide connection it passes for every partner-scope caller,
    // including an org_access='selected' user. Without this the route returned
    // every org's external ticket ids and URLs under that connection.
    const ticketOrgCondition = psaTicketMappingOrgCondition(auth.accessibleOrgIds);
    if (ticketOrgCondition) conditions.push(ticketOrgCondition);
    if (perms?.allowedSiteIds) {
      conditions.push(or(
        isNull(psaTicketMappings.deviceId),
        inArray(devices.siteId, perms.allowedSiteIds)
      )!);
    }
    const whereClause = and(...conditions);

    const rowsQuery = db
      .select({
        id: psaTicketMappings.id,
        connectionId: psaTicketMappings.connectionId,
        externalTicketId: psaTicketMappings.externalTicketId,
        externalTicketUrl: psaTicketMappings.externalTicketUrl,
        status: psaTicketMappings.status,
        alertId: psaTicketMappings.alertId,
        deviceId: psaTicketMappings.deviceId,
        lastSyncAt: psaTicketMappings.lastSyncAt,
        updatedAt: psaTicketMappings.updatedAt,
        createdAt: psaTicketMappings.createdAt
      })
      .from(psaTicketMappings);
    const rows = await (perms?.allowedSiteIds
      ? rowsQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : rowsQuery.where(whereClause))
      .orderBy(desc(psaTicketMappings.updatedAt))
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(psaTicketMappings);
    const countRows = await (perms?.allowedSiteIds
      ? countQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : countQuery.where(whereClause));

    return c.json({
      data: rows.map(mapTicketRow),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PSA company import (#3246)
//
// Pulls the connection's companies through the org-import seam, so a PSA becomes
// just another source alongside CSV and QuickBooks. The row contract is shared
// verbatim with POST /orgs/import (services/orgImport/schemas.ts) — the same web
// preview table drives both.
//
// BOTH routes are registered in SELF_MANAGED_DB_CONTEXT_ROUTES (#1448 / #1105
// class), so neither runs inside the auth middleware's ambient request
// transaction:
//   • preview makes up to a dozen outbound PSA requests at 20s each; pinning a
//     pooled connection idle-in-transaction across that is the pool-poison bug.
//   • commit runs `commitOrgImport`, which opens its OWN transaction per row
//     group in a system DB context; an ambient tx wrapped around hundreds of
//     those holds one connection for the entire import.
// Every DB touch below is therefore an explicit short `withAuthDbAccessContext`,
// with the network call outside all of them — the pattern the /test route uses.
// ─────────────────────────────────────────────────────────────────────────────

const psaCommitImportSchema = z.object({
  rows: z.array(commitImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
  mode: z.enum(['skip', 'update']).default('skip')
});

/**
 * The partner whose tenant tree the import writes into: always the partner that
 * OWNS the connection, never a value the caller supplies.
 *
 * Partner-owned rows carry it directly; an org-owned connection inherits it from
 * its organization. Returns null when the owning partner cannot be resolved,
 * which the caller turns into a 404 rather than guessing.
 */
async function resolveConnectionPartnerId(
  connection: ConnectionOwner
): Promise<string | null> {
  if (connection.partnerId) return connection.partnerId;
  if (!connection.orgId) return null;

  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, connection.orgId))
    .limit(1);

  return org?.partnerId ?? null;
}

type PsaConnectionRow = NonNullable<Awaited<ReturnType<typeof getConnectionById>>>;

interface ResolvedImportConnection {
  connection: PsaConnectionRow;
  partnerId: string;
  provider: OrgImportCapablePsaProvider;
}

type ImportResolution =
  | { ok: true; value: ResolvedImportConnection }
  | { ok: false; error: string; status: 400 | 403 | 404 };

/**
 * Shared front half of both import routes: load the connection, prove access,
 * prove capability, and resolve the owning partner.
 *
 * Returns either the resolved bundle or a ready-to-send error, so the two
 * handlers cannot drift on any of the gates.
 *
 * Deliberately does NOT touch credentials. Commit makes no outbound call, so
 * decrypting there would both do needless secret handling and let a connection
 * with rotated credentials 400 a commit that never needed them — see
 * `buildImportSource`, which preview alone calls.
 */
async function resolveImportConnection(
  auth: AuthContext,
  connectionId: string
): Promise<ImportResolution> {
  // Short, explicit DB context — no ambient request transaction here (#1448).
  const connection = await withAuthDbAccessContext(auth, () => getConnectionById(connectionId));
  if (!connection) {
    return { ok: false, error: 'PSA connection not found', status: 404 };
  }

  const hasAccess = await ensureConnectionAccess(connection, auth);
  if (!hasAccess) {
    return { ok: false, error: 'Access denied', status: 403 };
  }

  // Same bar as "Test connection": importing exercises the MSP's own PSA
  // credentials and, for a partner-wide connection, writes organizations across
  // the whole partner. A 'selected'-access partner user must not do that.
  if (partnerWideWriteBlocked(connection, auth)) {
    return { ok: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 };
  }

  if (!isOrgImportCapableProvider(connection.provider)) {
    // 400, not 501: the provider is a property of the caller's own connection.
    return {
      ok: false,
      error: new PsaCapabilityError(connection.provider, 'organization import').message,
      status: 400
    };
  }
  const provider: OrgImportCapablePsaProvider = connection.provider;

  const partnerId = await withAuthDbAccessContext(auth, () => resolveConnectionPartnerId(connection));
  if (!partnerId) {
    return { ok: false, error: 'PSA connection has no owning partner', status: 404 };
  }

  // Defense in depth: ensureConnectionAccess already implies this for partner
  // scope, but an explicit equality check means a future change to that helper
  // cannot silently let one partner import into another's tenant tree.
  if (auth.scope === 'partner' && auth.partnerId !== partnerId) {
    return { ok: false, error: 'Access denied', status: 403 };
  }

  return { ok: true, value: { connection, partnerId, provider } };
}

/**
 * Decrypt credentials and build the company-import source. PREVIEW ONLY — the
 * only half of the feature that talks to the PSA.
 */
function buildImportSource(
  connection: PsaConnectionRow,
  provider: OrgImportCapablePsaProvider
): { ok: true; source: PsaCompanyImportSource } | { ok: false; error: string; status: 400 } {
  const credentials = decryptCredentials(connection.credentials);
  if (!credentials) {
    return { ok: false, error: 'PSA connection has no usable credentials', status: 400 };
  }

  const settings = (connection.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings))
    ? connection.settings as Record<string, unknown>
    : {};

  let client;
  try {
    client = createPSAProvider(provider, credentials, settings);
  } catch (error) {
    if (error instanceof PsaConfigError) {
      return { ok: false, error: error.message, status: 400 };
    }
    throw error;
  }

  return { ok: true, source: createPsaCompanyImportSource({ provider, client }) };
}

/** Map an outbound-listing failure onto an honest status. */
function companyListingError(error: unknown): { error: string; status: 400 | 502 } {
  if (error instanceof PsaCapabilityError) {
    return { error: error.message, status: 400 };
  }
  if (error instanceof PsaCursorOriginError) {
    // The PSA steered pagination off its own host. Refused before dialing, so
    // no credentials left the process.
    //
    // The overwhelmingly likely CAUSE is benign, so the message has to be
    // actionable rather than just accusatory: Autotask assigns each customer a
    // zone host and returns `nextPageUrl` on that zone, so a connection saved
    // with the generic entry-point URL trips this on page 2 every time. The
    // remedy is to correct the connection's base URL.
    return {
      error:
        `${error.message}. If this is Autotask, set the connection's base URL to your ` +
        `assigned zone URL (the host Autotask returns from zoneInformation), not the generic entry point.`,
      status: 502
    };
  }
  return {
    error: error instanceof Error
      ? `PSA returned an error while listing companies: ${error.message}`
      : 'PSA returned an error while listing companies',
    status: 502
  };
}

psaRoutes.post(
  '/connections/:id/import/preview',
  // Import creates ORGS and SITES, so it carries both write gates plus MFA —
  // identical to POST /orgs/import. Org-scope tokens are excluded: the seam
  // imports into a PARTNER's tenant tree.
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requirePermission(PERMISSIONS.SITES_WRITE.resource, PERMISSIONS.SITES_WRITE.action),
  requireMfa(),
  // Each call is potentially a dozen 20s outbound requests on the partner's
  // behalf. Placed AFTER the gates so a 403 never consumes the caller's budget —
  // the bucket should count real PSA traffic, not rejected attempts.
  userRateLimit('psa-company-import-preview', 10, 3600),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

    const resolved = await resolveImportConnection(auth, connectionId);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { connection, partnerId, provider } = resolved.value;

    const built = buildImportSource(connection, provider);
    if (!built.ok) {
      return c.json({ error: built.error }, built.status);
    }

    // Outbound HTTP — deliberately outside every DB context above.
    let listing;
    try {
      listing = await built.source.listCompanies({ partnerId });
    } catch (error) {
      const mapped = companyListingError(error);
      return c.json({ error: mapped.error }, mapped.status);
    }

    // previewOrgImport manages its own short system contexts internally
    // (runOutsideDbContext + withSystemDbAccessContext), so it is called bare.
    const rows = await previewOrgImport(listing.rows, partnerId);

    return c.json({ rows, truncated: listing.truncated });
  }
);

psaRoutes.post(
  '/connections/:id/import',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requirePermission(PERMISSIONS.SITES_WRITE.resource, PERMISSIONS.SITES_WRITE.action),
  requireMfa(),
  zValidator('json', psaCommitImportSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;
    const { rows: submitted, mode } = c.req.valid('json');

    const resolved = await resolveImportConnection(auth, connectionId);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { connection, partnerId, provider } = resolved.value;

    // `externalSystem` is FORCED to this connection's provider, overwriting
    // whatever the client sent. Trusting the client here would let a caller
    // write link rows into another system's namespace — e.g. claim
    // system='quickbooks' for a ConnectWise company and hijack the dedupe key
    // a later QuickBooks import matches on.
    const rows = submitted.map((row) => ({ ...row, externalSystem: provider }));

    const summary = await commitOrgImport(rows, partnerId, { userId: auth.user?.id ?? null }, mode);

    // commitOrgImport writes NO audit events (no Hono context, system DB
    // context) — the route owns the trail. Shared with POST /orgs/import.
    writeOrgImportAudits(c, { summary, rows, partnerId, source: 'psa_import' });

    // Plus one event on the connection itself, so the PSA's own audit view shows
    // that an import ran and how much it moved.
    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.import',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name,
      details: {
        ...auditOwnerFields(connection),
        provider,
        mode,
        requested: rows.length,
        imported: summary.imported.length,
        updated: summary.updated.length,
        skipped: summary.skipped.length,
        errors: summary.errors.length
      }
    });

    return c.json(summary);
  }
);
