import type { Context } from 'hono';
import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, lte, or, param, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { organizations, sites } from '../../db/schema';
import { requirePartnerApiScope, type PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';
import {
  decodePartnerExportCursor,
  encodePartnerExportCursor,
  PartnerExportCursorError,
  type PartnerExportCursor,
  type PartnerExportCursorFilters,
} from './cursor';
import {
  computePartnerExportRevision,
  safelyExportDefinition,
} from './exportSafety';
import {
  createPartnerExportTraversal,
  getPartnerExportFetchLimit,
  normalizePartnerExportLimit,
  paginatePartnerExportRows,
  PartnerExportPaginationError,
  type PartnerExportPageRow,
  type PartnerExportTraversal,
} from './pagination';
import {
  organizationExportEnvelopeSchema,
  partnerExportCursorTokenSchema,
  partnerExportTimestampSchema,
  siteExportEnvelopeSchema,
  type PartnerExportBlockedRecord,
  type PartnerExportResource,
} from './schemas';
import { acquirePartnerExportReadLocks } from './consistency';

const CURSOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
const UUID_SCHEMA = z.string().uuid();
const querySchema = z.object({
  orgId: UUID_SCHEMA.optional(),
  siteId: UUID_SCHEMA.optional(),
  updatedSince: partnerExportTimestampSchema.optional(),
  cursor: partnerExportCursorTokenSchema.optional(),
  limit: z.string().optional(),
}).strict();

export interface ExportQueryInput {
  orgId: string | null;
  siteId: string | null;
  filters: PartnerExportCursorFilters;
  updatedSince: string | null;
  limit: number;
  traversal: PartnerExportTraversal;
}

type ExportSourceRow = PartnerExportPageRow;

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PartnerExportPaginationError('Invalid source timestamp.');
  return date.toISOString();
}

export function normalizeSourceRow<T extends { id: string; orgId: string; createdAt: Date | string; updatedAt: Date | string }>(
  row: T,
): Omit<T, 'createdAt' | 'updatedAt'> & PartnerExportPageRow {
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

export function isKnownClientError(error: unknown): error is PartnerExportCursorError | PartnerExportPaginationError {
  return error instanceof PartnerExportCursorError || error instanceof PartnerExportPaginationError;
}

export function clientError(c: Context, error: PartnerExportCursorError | PartnerExportPaginationError) {
  return c.json({ error: error.message, code: error.code }, 400);
}

function invalidQuery(c: Context) {
  return c.json({ error: 'Invalid partner export query.', code: 'invalid_partner_export_query' }, 400);
}

export function parseExportQuery(
  c: Context,
  resource: PartnerExportResource,
  principal: PartnerApiPrincipalContext,
): ExportQueryInput | Response {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) return invalidQuery(c);
  const supportsSiteFilter = resource === 'devices'
    || resource === 'device-inventory'
    || resource === 'device-software'
    || resource === 'device-relationships';
  if (parsed.data.siteId && !supportsSiteFilter) return invalidQuery(c);
  if (parsed.data.orgId && !principal.accessibleOrgIds.includes(parsed.data.orgId)) {
    return c.json({ error: 'Organization not found.', code: 'partner_export_org_not_found' }, 404);
  }

  try {
    const updatedSince = parsed.data.updatedSince
      ? new Date(parsed.data.updatedSince).toISOString()
      : null;
    const filters = {
      orgId: parsed.data.orgId ?? null,
      siteId: supportsSiteFilter ? parsed.data.siteId ?? null : null,
    };
    const cursor = parsed.data.cursor
      ? decodePartnerExportCursor(parsed.data.cursor, {
        partnerId: principal.partnerId, resource, updatedSince, filters,
      })
      : null;
    return {
      orgId: parsed.data.orgId ?? null,
      siteId: filters.siteId,
      filters,
      updatedSince,
      limit: normalizePartnerExportLimit(parsed.data.limit),
      traversal: createPartnerExportTraversal({ updatedSince, cursor }),
    };
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    throw error;
  }
}

export function bindPartnerExportSnapshot(query: ExportQueryInput, snapshotAt: Date): void {
  if (query.traversal.after) return;
  if (
    query.updatedSince !== null
    && Date.parse(query.updatedSince) >= snapshotAt.getTime()
  ) {
    throw new PartnerExportPaginationError('Partner export updatedSince must precede the database snapshot.');
  }
  query.traversal.snapshotAt = snapshotAt.toISOString();
}

export function paginationConditions(
  columns: { id: any; orgId: any; createdAt: any; updatedAt: any; updatedAtParam?: any },
  traversal: PartnerExportTraversal,
): SQL[] {
  const snapshot = new Date(traversal.snapshotAt);
  const encodeUpdatedAt = columns.updatedAtParam ?? columns.updatedAt;
  const conditions: SQL[] = traversal.mode === 'incremental'
    ? [
      gt(columns.updatedAt, param(new Date(traversal.updatedSince!), encodeUpdatedAt)),
      lte(columns.updatedAt, param(snapshot, encodeUpdatedAt)),
    ]
    : [lte(columns.createdAt, snapshot)];
  if (!traversal.after) return conditions;

  const after = traversal.after;
  if (traversal.mode === 'incremental') {
    const lastUpdatedAt = new Date(after.lastUpdatedAt!);
    conditions.push(or(
      gt(columns.updatedAt, param(lastUpdatedAt, encodeUpdatedAt)),
      and(
        eq(columns.updatedAt, param(lastUpdatedAt, encodeUpdatedAt)),
        or(
          gt(columns.id, after.lastId),
          and(eq(columns.id, after.lastId), gt(columns.orgId, after.lastOrgId!)),
        ),
      ),
    )!);
  } else {
    conditions.push(or(
      gt(columns.id, after.lastId),
      and(eq(columns.id, after.lastId), gt(columns.orgId, after.lastOrgId!)),
    )!);
  }
  return conditions;
}

export function paginationOrder(
  columns: { id: any; orgId: any; updatedAt: any },
  traversal: PartnerExportTraversal,
) {
  return traversal.mode === 'incremental'
    ? [asc(columns.updatedAt), asc(columns.id), asc(columns.orgId)]
    : [asc(columns.id), asc(columns.orgId)];
}

export function buildEnvelope<T extends ExportSourceRow>(input: {
  resource: PartnerExportResource;
  partnerId: string;
  rows: readonly T[];
  query: ExportQueryInput;
  preflightBlock?: (row: T) => readonly string[] | null;
  makeRecord: (row: T) => Record<string, unknown>;
}) {
  const page = paginatePartnerExportRows(input.rows, { traversal: input.query.traversal, limit: input.query.limit });
  const data: Record<string, unknown>[] = [];
  const blocked: PartnerExportBlockedRecord[] = [];
  for (const row of page.data) {
    const preflightFieldPaths = input.preflightBlock?.(row) ?? null;
    if (preflightFieldPaths) {
      blocked.push({
        resource: input.resource,
        id: row.id,
        orgId: row.orgId!,
        reason: 'secret_detected',
        fieldPaths: [...preflightFieldPaths],
      });
      continue;
    }
    const withoutRevision = input.makeRecord(row);
    const definition = { ...withoutRevision, revision: computePartnerExportRevision(withoutRevision) };
    const inspected = safelyExportDefinition(
      { resource: input.resource, id: row.id, orgId: row.orgId! },
      definition,
    );
    if (inspected.safe) data.push(inspected.definition);
    else blocked.push(inspected.blocked);
  }

  let nextCursor: string | null = null;
  if (page.hasMore && page.lastKey) {
    const cursor: PartnerExportCursor = {
      v: 1,
      resource: input.resource,
      partnerId: input.partnerId,
      snapshotAt: input.query.traversal.snapshotAt,
      updatedSince: input.query.updatedSince,
      filters: input.query.filters,
      lastUpdatedAt: page.lastKey.lastUpdatedAt,
      lastId: page.lastKey.lastId,
      lastOrgId: page.lastKey.lastOrgId,
      expiresAt: new Date(Date.parse(input.query.traversal.snapshotAt) + CURSOR_LIFETIME_MS).toISOString(),
    };
    nextCursor = encodePartnerExportCursor(cursor);
  }
  return {
    schemaVersion: '1' as const,
    snapshotAt: input.query.traversal.snapshotAt,
    data,
    nextCursor,
    hasMore: page.hasMore,
    ...(blocked.length > 0 ? { blocked } : {}),
  };
}

function jsonField(record: unknown, names: string[]): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  for (const name of names) {
    const value = (record as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 1000);
  }
  return null;
}

export const partnerOrganizationRoutes = new Hono();

partnerOrganizationRoutes.get('/organizations', requirePartnerApiScope('organizations:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'organizations', principal);
  if (parsed instanceof Response) return parsed;
  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    const lockSnapshotAt = await acquirePartnerExportReadLocks(orgIds);
    bindPartnerExportSnapshot(parsed, lockSnapshotAt);
    if (orgIds.length === 0) return c.json(organizationExportEnvelopeSchema.parse(buildEnvelope({
      resource: 'organizations', partnerId: principal.partnerId, rows: [], query: parsed, makeRecord: () => ({}),
    })));
    const rows = await db.select({
      id: organizations.id,
      orgId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      type: organizations.type,
      createdAt: organizations.createdAt,
      updatedAt: organizations.partnerExportUpdatedAt,
    }).from(organizations).where(and(
      eq(organizations.partnerId, principal.partnerId),
      inArray(organizations.id, orgIds),
      ...paginationConditions({ id: organizations.id, orgId: organizations.id, createdAt: organizations.createdAt, updatedAt: organizations.partnerExportUpdatedAt }, parsed.traversal),
    )).orderBy(...paginationOrder({ id: organizations.id, orgId: organizations.id, updatedAt: organizations.partnerExportUpdatedAt }, parsed.traversal))
      .limit(getPartnerExportFetchLimit(parsed.limit));
    const normalized = rows.map((row) => normalizeSourceRow({ ...row, siteId: null }));
    const envelope = buildEnvelope({
      resource: 'organizations', partnerId: principal.partnerId, rows: normalized, query: parsed,
      makeRecord: (row) => ({
        id: row.id, orgId: row.orgId, siteId: null, sourceUpdatedAt: row.updatedAt,
        name: row.name, slug: row.slug, type: row.type,
      }),
    });
    return c.json(organizationExportEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    return c.json({ error: 'Partner organization export failed.', code: 'partner_export_failed' }, 500);
  }
});

partnerOrganizationRoutes.get('/sites', requirePartnerApiScope('sites:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'sites', principal);
  if (parsed instanceof Response) return parsed;
  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    const lockSnapshotAt = await acquirePartnerExportReadLocks(orgIds);
    bindPartnerExportSnapshot(parsed, lockSnapshotAt);
    if (orgIds.length === 0) return c.json(siteExportEnvelopeSchema.parse(buildEnvelope({
      resource: 'sites', partnerId: principal.partnerId, rows: [], query: parsed, makeRecord: () => ({}),
    })));
    const rows = await db.select({
      id: sites.id, orgId: sites.orgId, siteId: sites.id, name: sites.name,
      address: sites.address, timezone: sites.timezone, contact: sites.contact,
      createdAt: sites.createdAt, updatedAt: sites.partnerExportUpdatedAt,
    }).from(sites).where(and(
      inArray(sites.orgId, orgIds),
      ...paginationConditions({ id: sites.id, orgId: sites.orgId, createdAt: sites.createdAt, updatedAt: sites.partnerExportUpdatedAt }, parsed.traversal),
    )).orderBy(...paginationOrder({ id: sites.id, orgId: sites.orgId, updatedAt: sites.partnerExportUpdatedAt }, parsed.traversal))
      .limit(getPartnerExportFetchLimit(parsed.limit));
    const normalized = rows.map(normalizeSourceRow);
    const envelope = buildEnvelope({
      resource: 'sites', partnerId: principal.partnerId, rows: normalized, query: parsed,
      makeRecord: (row) => ({
        id: row.id, orgId: row.orgId, siteId: row.id, sourceUpdatedAt: row.updatedAt,
        name: row.name, timezone: row.timezone,
        address: row.address ? {
          line1: jsonField(row.address, ['line1', 'addressLine1', 'street1']),
          line2: jsonField(row.address, ['line2', 'addressLine2', 'street2']),
          city: jsonField(row.address, ['city']),
          region: jsonField(row.address, ['region', 'state']),
          postalCode: jsonField(row.address, ['postalCode', 'zip']),
          country: jsonField(row.address, ['country']),
        } : null,
        contact: row.contact ? {
          name: jsonField(row.contact, ['name']),
          email: jsonField(row.contact, ['email']),
          phone: jsonField(row.contact, ['phone']),
        } : null,
      }),
    });
    return c.json(siteExportEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    return c.json({ error: 'Partner site export failed.', code: 'partner_export_failed' }, 500);
  }
});
