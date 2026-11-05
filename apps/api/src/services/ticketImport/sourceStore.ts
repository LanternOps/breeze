import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  organizations,
  partnerServicePrincipalKeys,
  partnerServicePrincipals,
  ticketCategories,
  ticketImportCategoryMaps,
  ticketImportOrgMaps,
  ticketImportRuns,
  ticketImportSources,
  TICKET_IMPORT_ACTIVE_RUN_STATES,
} from '../../db/schema';
import { isPgUniqueViolation, pgErrorConstraint } from '../../utils/pgErrors';
import { notHiddenOrgType } from '../unassignedPool/visibility';
import { TicketImportError } from './importErrors';

/**
 * Sources and their maps (#8313 W4; spec 2026-10-19 §5.5–§5.7). Every
 * function runs in the caller's DB context: the partner-scoped context of a
 * route, so RLS bounds each statement to the caller's partner, and each also
 * names the partner in its predicate. Called only from the gated routes
 * (routes/ticketImports/*), which check canManagePartnerWidePolicies and, for
 * create, edit and mappings, that the caller owns the source's principal.
 *
 * Reads never select `credentials_encrypted` except `readSourceForUse`, whose
 * callers decrypt it with sourceCredentials.ts and never return it.
 */

const TICKETS_WRITE_SCOPE = 'tickets:write';
const PRINCIPAL_UNIQUE = 'ticket_import_sources_principal_uq';
export const TICKET_IMPORT_MAX_MAPPED_ORGS = 1000;
export const TICKET_IMPORT_MAX_MAPPED_GROUPS = 1000;

export type TicketImportSourceView = {
  id: string;
  partnerId: string;
  module: string;
  label: string;
  baseUrl: string;
  principalId: string;
  /** The principal's owner: the only user who may edit the source, its maps and open its windows. */
  ownerUserId: string | null;
  options: Record<string, unknown>;
  hasCredentials: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  activeRunId: string | null;
};

export type TicketImportMappings = {
  orgs: Array<{ sourceOrgKey: string | null; sourceOrgName: string | null; orgId: string }>;
  categories: Array<{ sourceGroupKey: string; sourceGroupName: string | null; categoryId: string }>;
};

const viewColumns = {
  id: ticketImportSources.id,
  partnerId: ticketImportSources.partnerId,
  module: ticketImportSources.module,
  label: ticketImportSources.label,
  baseUrl: ticketImportSources.baseUrl,
  principalId: ticketImportSources.partnerServicePrincipalId,
  ownerUserId: partnerServicePrincipals.createdBy,
  options: ticketImportSources.options,
  hasCredentials: sql<boolean>`${ticketImportSources.credentialsEncrypted} IS NOT NULL`,
  revokedAt: ticketImportSources.revokedAt,
  revokedBy: ticketImportSources.revokedBy,
  createdBy: ticketImportSources.createdBy,
  createdAt: ticketImportSources.createdAt,
  updatedAt: ticketImportSources.updatedAt,
  activeRunId: sql<string | null>`(
    SELECT r.id FROM ticket_import_runs r
     WHERE r.source_id = ${ticketImportSources.id} AND r.state IN ('queued', 'running')
     LIMIT 1)`,
};

type ViewRow = {
  [K in keyof typeof viewColumns]: unknown;
};

function iso(d: unknown): string | null {
  if (d === null || d === undefined) return null;
  return d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString();
}

function toView(row: ViewRow): TicketImportSourceView {
  return {
    id: row.id as string,
    partnerId: row.partnerId as string,
    module: row.module as string,
    label: row.label as string,
    baseUrl: row.baseUrl as string,
    principalId: row.principalId as string,
    ownerUserId: (row.ownerUserId as string | null) ?? null,
    options: (row.options as Record<string, unknown>) ?? {},
    hasCredentials: row.hasCredentials === true,
    revokedAt: iso(row.revokedAt),
    revokedBy: (row.revokedBy as string | null) ?? null,
    createdBy: (row.createdBy as string | null) ?? null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    activeRunId: (row.activeRunId as string | null) ?? null,
  };
}

function notFound(): TicketImportError {
  return new TicketImportError('TICKET_IMPORT_SOURCE_NOT_FOUND', 'Ticket import source not found', 404);
}

function baseQuery() {
  return db
    .select(viewColumns)
    .from(ticketImportSources)
    .leftJoin(partnerServicePrincipals, and(
      eq(partnerServicePrincipals.id, ticketImportSources.partnerServicePrincipalId),
      eq(partnerServicePrincipals.partnerId, ticketImportSources.partnerId),
    ));
}

export async function listSources(partnerId: string): Promise<TicketImportSourceView[]> {
  const rows = await baseQuery()
    .where(eq(ticketImportSources.partnerId, partnerId))
    .orderBy(desc(ticketImportSources.createdAt))
    .limit(200);
  return rows.map((r) => toView(r as ViewRow));
}

export async function getSource(partnerId: string, sourceId: string): Promise<TicketImportSourceView | null> {
  const [row] = await baseQuery()
    .where(and(eq(ticketImportSources.id, sourceId), eq(ticketImportSources.partnerId, partnerId)))
    .limit(1);
  return row ? toView(row as ViewRow) : null;
}

export async function getMappings(partnerId: string, sourceId: string): Promise<TicketImportMappings> {
  const orgs = await db
    .select({
      sourceOrgKey: ticketImportOrgMaps.sourceOrgKey,
      sourceOrgName: ticketImportOrgMaps.sourceOrgName,
      orgId: ticketImportOrgMaps.orgId,
    })
    .from(ticketImportOrgMaps)
    .where(and(eq(ticketImportOrgMaps.sourceId, sourceId), eq(ticketImportOrgMaps.partnerId, partnerId)))
    .orderBy(asc(ticketImportOrgMaps.sourceOrgKey));
  const categories = await db
    .select({
      sourceGroupKey: ticketImportCategoryMaps.sourceGroupKey,
      sourceGroupName: ticketImportCategoryMaps.sourceGroupName,
      categoryId: ticketImportCategoryMaps.categoryId,
    })
    .from(ticketImportCategoryMaps)
    .where(and(eq(ticketImportCategoryMaps.sourceId, sourceId), eq(ticketImportCategoryMaps.partnerId, partnerId)))
    .orderBy(asc(ticketImportCategoryMaps.sourceGroupKey));
  return { orgs, categories };
}

/** The source with its sealed credential, for a connect, a preflight or a run. Never returned to a caller. */
export async function readSourceForUse(
  partnerId: string,
  sourceId: string,
): Promise<{ view: TicketImportSourceView; credentialsEncrypted: string | null } | null> {
  const [row] = await db
    .select({ ...viewColumns, credentialsEncrypted: ticketImportSources.credentialsEncrypted })
    .from(ticketImportSources)
    .leftJoin(partnerServicePrincipals, and(
      eq(partnerServicePrincipals.id, ticketImportSources.partnerServicePrincipalId),
      eq(partnerServicePrincipals.partnerId, ticketImportSources.partnerId),
    ))
    .where(and(eq(ticketImportSources.id, sourceId), eq(ticketImportSources.partnerId, partnerId)))
    .limit(1);
  if (!row) return null;
  const { credentialsEncrypted, ...view } = row;
  return { view: toView(view as ViewRow), credentialsEncrypted: credentialsEncrypted ?? null };
}

/**
 * The checks a source's principal must pass at create (spec §5.7): the
 * caller's own (only its owner can open a window for it, F27), active and
 * unexpired, holding tickets:write, with no active key and no other source.
 * Locks the principal FOR UPDATE, as opening a window does, so a key cannot
 * be minted between this check and the insert (key issue locks the same row).
 * Must run inside the transaction that inserts the source.
 */
export async function lockPrincipalForSource(input: {
  partnerId: string;
  principalId: string;
  ownerUserId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const [principal] = await db
    .select({
      id: partnerServicePrincipals.id,
      status: partnerServicePrincipals.status,
      expiresAt: partnerServicePrincipals.expiresAt,
      scopes: partnerServicePrincipals.scopes,
      createdBy: partnerServicePrincipals.createdBy,
    })
    .from(partnerServicePrincipals)
    .where(and(eq(partnerServicePrincipals.id, input.principalId), eq(partnerServicePrincipals.partnerId, input.partnerId)))
    .limit(1)
    .for('update');
  if (!principal) {
    throw new TicketImportError('TICKET_IMPORT_PRINCIPAL_NOT_FOUND', 'Service principal not found', 404);
  }
  if (principal.createdBy !== input.ownerUserId) {
    throw new TicketImportError(
      'TICKET_IMPORT_OWNER_REQUIRED',
      'Only the service principal owner can connect a ticket import source to it',
      403,
    );
  }
  if (principal.status !== 'active' || (principal.expiresAt && principal.expiresAt.getTime() <= now.getTime())) {
    throw new TicketImportError('TICKET_IMPORT_PRINCIPAL_INACTIVE', 'Service principal is disabled or expired', 409);
  }
  if (!principal.scopes.includes(TICKETS_WRITE_SCOPE)) {
    throw new TicketImportError('TICKET_IMPORT_PRINCIPAL_SCOPE_MISSING', 'Service principal must hold tickets:write', 409);
  }
  const [activeKey] = await db
    .select({ id: partnerServicePrincipalKeys.id })
    .from(partnerServicePrincipalKeys)
    .where(and(
      eq(partnerServicePrincipalKeys.partnerServicePrincipalId, input.principalId),
      eq(partnerServicePrincipalKeys.partnerId, input.partnerId),
      eq(partnerServicePrincipalKeys.status, 'active'),
      or(isNull(partnerServicePrincipalKeys.expiresAt), gt(partnerServicePrincipalKeys.expiresAt, now)),
    ))
    .limit(1);
  if (activeKey) {
    throw new TicketImportError(
      'TICKET_IMPORT_PRINCIPAL_HAS_KEY',
      'An import principal must have no active key; revoke its keys first',
      409,
    );
  }
  const [existing] = await db
    .select({ id: ticketImportSources.id })
    .from(ticketImportSources)
    .where(eq(ticketImportSources.partnerServicePrincipalId, input.principalId))
    .limit(1);
  if (existing) throw principalInUse(existing.id);
}

function principalInUse(sourceId?: string): TicketImportError {
  return new TicketImportError(
    'TICKET_IMPORT_PRINCIPAL_IN_USE',
    'This service principal already has a ticket import source',
    409,
    sourceId ? { sourceId } : undefined,
  );
}

export type InsertSourceInput = {
  id: string;
  partnerId: string;
  module: string;
  label: string;
  baseUrl: string;
  credentialsEncrypted: string;
  principalId: string;
  createdBy: string;
  options: Record<string, unknown>;
};

export async function insertSource(input: InsertSourceInput): Promise<void> {
  try {
    await db.insert(ticketImportSources).values({
      id: input.id,
      partnerId: input.partnerId,
      module: input.module,
      label: input.label,
      baseUrl: input.baseUrl,
      credentialsEncrypted: input.credentialsEncrypted,
      partnerServicePrincipalId: input.principalId,
      options: input.options,
      createdBy: input.createdBy,
    });
  } catch (error) {
    if (isPgUniqueViolation(error) && pgErrorConstraint(error) === PRINCIPAL_UNIQUE) throw principalInUse();
    throw error;
  }
}

/**
 * Locks the source row FOR UPDATE: every change of a source, its maps or its
 * revocation, and the start of a run, serialize on it, so "no active run" and
 * the change cannot race.
 */
export async function lockSource(partnerId: string, sourceId: string): Promise<{
  id: string;
  module: string;
  baseUrl: string;
  principalId: string;
  ownerUserId: string | null;
  revoked: boolean;
  options: Record<string, unknown>;
}> {
  const [row] = await db
    .select({
      id: ticketImportSources.id,
      module: ticketImportSources.module,
      baseUrl: ticketImportSources.baseUrl,
      principalId: ticketImportSources.partnerServicePrincipalId,
      revokedAt: ticketImportSources.revokedAt,
      options: ticketImportSources.options,
    })
    .from(ticketImportSources)
    .where(and(eq(ticketImportSources.id, sourceId), eq(ticketImportSources.partnerId, partnerId)))
    .limit(1)
    .for('update');
  if (!row) throw notFound();
  const [principal] = await db
    .select({ createdBy: partnerServicePrincipals.createdBy })
    .from(partnerServicePrincipals)
    .where(and(eq(partnerServicePrincipals.id, row.principalId), eq(partnerServicePrincipals.partnerId, partnerId)))
    .limit(1);
  return {
    id: row.id,
    module: row.module,
    baseUrl: row.baseUrl,
    principalId: row.principalId,
    ownerUserId: principal?.createdBy ?? null,
    revoked: row.revokedAt !== null,
    options: row.options ?? {},
  };
}

/** The id of the source's queued or running run, if any. */
export async function activeRunOf(sourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: ticketImportRuns.id })
    .from(ticketImportRuns)
    .where(and(eq(ticketImportRuns.sourceId, sourceId), inArray(ticketImportRuns.state, [...TICKET_IMPORT_ACTIVE_RUN_STATES])))
    .limit(1);
  return row?.id ?? null;
}

export function runActive(runId: string): TicketImportError {
  return new TicketImportError('TICKET_IMPORT_RUN_ACTIVE', 'A run of this source is queued or running', 409, { runId });
}

export function ownerRequired(): TicketImportError {
  return new TicketImportError(
    'TICKET_IMPORT_OWNER_REQUIRED',
    'Only the owner of the source\'s service principal can change it',
    403,
  );
}

/**
 * Applies an edit (spec §5.7 PATCH). The route decided the new values and,
 * for new credentials, sealed them under the same id; new credentials on a
 * revoked source clear the revocation.
 */
export async function updateSource(input: {
  partnerId: string;
  sourceId: string;
  label?: string;
  baseUrl?: string;
  credentialsEncrypted?: string;
}): Promise<void> {
  const set: Partial<typeof ticketImportSources.$inferInsert> = { updatedAt: new Date() };
  if (input.label !== undefined) set.label = input.label;
  if (input.baseUrl !== undefined) set.baseUrl = input.baseUrl;
  if (input.credentialsEncrypted !== undefined) {
    set.credentialsEncrypted = input.credentialsEncrypted;
    set.revokedAt = null;
    set.revokedBy = null;
  }
  await db
    .update(ticketImportSources)
    .set(set)
    .where(and(eq(ticketImportSources.id, input.sourceId), eq(ticketImportSources.partnerId, input.partnerId)));
}

/**
 * Revoke (#8313 answer 1): clears the credential and stamps who revoked it.
 * The row, its principal, maps and run history stay, so a later re-import
 * reconnects with a new token and resumes. Refused while a run is active.
 */
export async function revokeSource(partnerId: string, sourceId: string, userId: string): Promise<{ alreadyRevoked: boolean }> {
  const source = await lockSource(partnerId, sourceId);
  const active = await activeRunOf(sourceId);
  if (active) throw runActive(active);
  if (source.revoked) return { alreadyRevoked: true };
  await db
    .update(ticketImportSources)
    .set({ credentialsEncrypted: null, revokedAt: new Date(), revokedBy: userId, updatedAt: new Date() })
    .where(and(eq(ticketImportSources.id, sourceId), eq(ticketImportSources.partnerId, partnerId)));
  return { alreadyRevoked: false };
}

/**
 * Delete: the source with its maps, runs, ledger and issues (FK cascade).
 * Imported tickets and the principal stay. Refused while a run is active.
 */
export async function deleteSource(partnerId: string, sourceId: string): Promise<void> {
  await lockSource(partnerId, sourceId);
  const active = await activeRunOf(sourceId);
  if (active) throw runActive(active);
  await db
    .delete(ticketImportSources)
    .where(and(eq(ticketImportSources.id, sourceId), eq(ticketImportSources.partnerId, partnerId)));
}

function mappingInvalid(message: string, details?: Record<string, unknown>): TicketImportError {
  return new TicketImportError('TICKET_IMPORT_MAPPING_INVALID', message, 400, details);
}

/**
 * Replaces a source's org and category maps and its module options in one
 * transaction (spec §5.7 PUT mappings). Every org must be an active, visible
 * org of the partner and every category one of the partner's. Refused while a
 * run is active (409 TICKET_IMPORT_MAPPING_LOCKED), since a slice reads the
 * maps live.
 */
export async function replaceMappings(input: {
  partnerId: string;
  sourceId: string;
  mappings: TicketImportMappings;
  options: Record<string, unknown>;
}): Promise<void> {
  const { partnerId, sourceId, mappings } = input;
  const active = await activeRunOf(sourceId);
  if (active) {
    throw new TicketImportError('TICKET_IMPORT_MAPPING_LOCKED', 'Mappings cannot change while a run is queued or running', 409, { runId: active });
  }
  if (mappings.orgs.length > TICKET_IMPORT_MAX_MAPPED_ORGS || mappings.categories.length > TICKET_IMPORT_MAX_MAPPED_GROUPS) {
    throw mappingInvalid('Too many mapped organizations or groups');
  }
  const orgKeys = new Set<string | null>();
  for (const map of mappings.orgs) {
    if (orgKeys.has(map.sourceOrgKey)) {
      throw mappingInvalid(map.sourceOrgKey === null ? 'Only one fallback organization is allowed' : 'A source organization is mapped twice', {
        sourceOrgKey: map.sourceOrgKey,
      });
    }
    orgKeys.add(map.sourceOrgKey);
  }
  const groupKeys = new Set<string>();
  for (const map of mappings.categories) {
    if (groupKeys.has(map.sourceGroupKey)) throw mappingInvalid('A source group is mapped twice', { sourceGroupKey: map.sourceGroupKey });
    groupKeys.add(map.sourceGroupKey);
  }

  const orgIds = [...new Set(mappings.orgs.map((m) => m.orgId))];
  if (orgIds.length > 0) {
    const allowed = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(
        inArray(organizations.id, orgIds),
        eq(organizations.partnerId, partnerId),
        eq(organizations.status, 'active'),
        isNull(organizations.deletedAt),
        notHiddenOrgType(),
      ));
    if (allowed.length !== orgIds.length) {
      const ok = new Set(allowed.map((o) => o.id));
      throw mappingInvalid('Every organization must be an active organization of the partner', { orgIds: orgIds.filter((id) => !ok.has(id)) });
    }
  }
  const categoryIds = [...new Set(mappings.categories.map((m) => m.categoryId))];
  if (categoryIds.length > 0) {
    const allowed = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(and(inArray(ticketCategories.id, categoryIds), eq(ticketCategories.partnerId, partnerId)));
    if (allowed.length !== categoryIds.length) {
      const ok = new Set(allowed.map((c) => c.id));
      throw mappingInvalid('Every category must be a ticket category of the partner', { categoryIds: categoryIds.filter((id) => !ok.has(id)) });
    }
  }

  await db.delete(ticketImportOrgMaps).where(and(eq(ticketImportOrgMaps.sourceId, sourceId), eq(ticketImportOrgMaps.partnerId, partnerId)));
  await db.delete(ticketImportCategoryMaps).where(and(eq(ticketImportCategoryMaps.sourceId, sourceId), eq(ticketImportCategoryMaps.partnerId, partnerId)));
  if (mappings.orgs.length > 0) {
    await db.insert(ticketImportOrgMaps).values(mappings.orgs.map((m) => ({
      sourceId,
      partnerId,
      sourceOrgKey: m.sourceOrgKey,
      sourceOrgName: m.sourceOrgName,
      orgId: m.orgId,
    })));
  }
  if (mappings.categories.length > 0) {
    await db.insert(ticketImportCategoryMaps).values(mappings.categories.map((m) => ({
      sourceId,
      partnerId,
      sourceGroupKey: m.sourceGroupKey,
      sourceGroupName: m.sourceGroupName,
      categoryId: m.categoryId,
    })));
  }
  await db
    .update(ticketImportSources)
    .set({ options: input.options, updatedAt: new Date() })
    .where(and(eq(ticketImportSources.id, sourceId), eq(ticketImportSources.partnerId, partnerId)));
}
