import { and, eq, gt, isNull, or, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  topologyConfigurationSchema,
  topologyStableKeySchema,
  type TopologyTemplateVersion,
} from '@breeze/shared';
import {
  canonicalizeArguments,
  computeArgumentDigest,
} from '@breeze/shared/canonicalize';
import { db, withDbTransaction } from '../../db';
import {
  topologyConfigTemplates,
  topologyConfigTemplateVersions,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  canAccessOrg,
  hasPermission,
  type UserPermissions,
} from '../permissions';
import {
  canManagePartnerWidePolicies,
  canReadPartnerWideRows,
} from '../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../siteCeilingAccess';
import { createAuditLog } from '../auditService';
import {
  requireTopologySiteAccess,
  type TopologyRequestContext,
} from './access';
import { TopologyOperationError } from './operationErrors';

const revision = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(19);
export const createTopologyTemplateSchema = z
  .object({
    ownerScope: z.enum(['partner', 'organization']),
    orgId: z.uuid().optional(),
    key: topologyStableKeySchema,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2048).optional(),
  })
  .strict();
export const updateTopologyTemplateSchema = z
  .object({
    expectedRevision: revision,
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2048).nullable().optional(),
    lifecycle: z.enum(['active', 'archived', 'revoked']).optional(),
  })
  .strict();
export const createTopologyTemplateVersionSchema = z
  .object({
    expectedRevision: revision,
    payload: topologyConfigurationSchema,
    schemaVersion: z.literal(1),
    defaultsVersion: z.literal(1),
    resolverVersion: z.literal(1),
  })
  .strict();
export const publishTopologyTemplateVersionSchema = z
  .object({
    expectedTemplateRevision: revision,
    expectedVersionRevision: revision,
  })
  .strict();
type Template = typeof topologyConfigTemplates.$inferSelect;
type Version = typeof topologyConfigTemplateVersions.$inferSelect;
export function assertTopologyTemplateAccess(
  auth: AuthContext,
  permissions: UserPermissions,
  owner: { orgId: string | null; partnerId: string | null },
  write: boolean,
): void {
  if (
    !hasPermission(permissions, 'topology', write ? 'write' : 'read') ||
    !hasPermission(permissions, 'devices', write ? 'write' : 'read')
  )
    throw new TopologyOperationError('topology_permission_denied', 403);
  if (owner.partnerId) {
    if (
      !canReadPartnerWideRows(auth, owner.partnerId) ||
      (write && !canManagePartnerWidePolicies(auth))
    )
      throw new TopologyOperationError('topology_permission_denied', 403);
  } else if (
    !owner.orgId ||
    !auth.canAccessOrg(owner.orgId) ||
    !canAccessOrg(permissions, owner.orgId) ||
    !canMutateOrgWideGovernance(auth)
  )
    throw new TopologyOperationError('topology_template_not_found', 404);
}
function assertRevision(actual: bigint, expected: string) {
  if (actual !== BigInt(expected))
    throw new TopologyOperationError('revision_conflict', 409);
}
function versionDto(row: Version, template: Template): TopologyTemplateVersion {
  return {
    id: row.id,
    templateId: row.templateId,
    ownerScope: row.partnerId ? 'partner' : 'organization',
    key: template.key,
    name: template.name,
    version: row.version,
    revision: row.revision.toString(),
    state: row.state as 'draft' | 'published',
    schemaVersion: 1,
    defaultsVersion: row.defaultsVersion,
    resolverVersion: row.resolverVersion,
    payload: topologyConfigurationSchema.parse(row.payload),
    contentDigest: row.contentDigest,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}
async function loadTemplate(
  auth: AuthContext,
  permissions: UserPermissions,
  id: string,
  write: boolean,
) {
  const [row] = await db
    .select()
    .from(topologyConfigTemplates)
    .where(eq(topologyConfigTemplates.id, z.uuid().parse(id)))
    .limit(1);
  if (!row)
    throw new TopologyOperationError('topology_template_not_found', 404);
  assertTopologyTemplateAccess(auth, permissions, row, write);
  return row;
}
async function audit(
  auth: AuthContext,
  row: Template,
  action: string,
  resourceId: string,
) {
  await createAuditLog({
    orgId: row.orgId,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: `topology.template.${action}`,
    resourceType: 'topology_template',
    resourceId,
    result: 'success',
    details: { templateId: row.id, ownerPartnerId: row.partnerId },
  });
}
export async function listTopologyTemplates(
  auth: AuthContext,
  permissions: UserPermissions,
  input: {
    ownerScope: 'partner' | 'organization';
    orgId?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const owner =
    input.ownerScope === 'partner'
      ? { partnerId: auth.partnerId, orgId: null }
      : { partnerId: null, orgId: input.orgId ?? auth.orgId };
  assertTopologyTemplateAccess(auth, permissions, owner, false);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(input.limit ?? 100);
  const rows = await db
    .select()
    .from(topologyConfigTemplates)
    .where(
      and(
        owner.partnerId
          ? eq(topologyConfigTemplates.partnerId, owner.partnerId)
          : eq(topologyConfigTemplates.orgId, owner.orgId!),
        input.cursor
          ? gt(topologyConfigTemplates.id, z.uuid().parse(input.cursor))
          : undefined,
      ),
    )
    .orderBy(asc(topologyConfigTemplates.id))
    .limit(limit + 1);
  const items = rows
    .slice(0, limit)
    .map((row) => ({
      ...row,
      revision: row.revision.toString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
export async function createTopologyTemplate(
  auth: AuthContext,
  permissions: UserPermissions,
  input: z.input<typeof createTopologyTemplateSchema>,
) {
  const value = createTopologyTemplateSchema.parse(input);
  const owner =
    value.ownerScope === 'partner'
      ? { partnerId: auth.partnerId, orgId: null }
      : { partnerId: null, orgId: value.orgId ?? auth.orgId };
  assertTopologyTemplateAccess(auth, permissions, owner, true);
  if (!owner.orgId && !owner.partnerId)
    throw new TopologyOperationError('owner_required', 400);
  const [row] = await db
    .insert(topologyConfigTemplates)
    .values({
      ...owner,
      key: value.key,
      name: value.name,
      description: value.description,
      createdBy: auth.user.id,
      updatedBy: auth.user.id,
    })
    .returning();
  if (!row) throw new TopologyOperationError('template_create_failed', 503);
  await audit(auth, row, 'created', row.id);
  return { ...row, revision: row.revision.toString() };
}
export async function updateTopologyTemplate(
  auth: AuthContext,
  permissions: UserPermissions,
  id: string,
  input: z.input<typeof updateTopologyTemplateSchema>,
) {
  const value = updateTopologyTemplateSchema.parse(input);
  const row = await loadTemplate(auth, permissions, id, true);
  assertRevision(row.revision, value.expectedRevision);
  const [updated] = await db
    .update(topologyConfigTemplates)
    .set({
      name: value.name,
      description: value.description,
      lifecycle: value.lifecycle,
      revision: row.revision + 1n,
      updatedBy: auth.user.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(topologyConfigTemplates.id, id),
        eq(topologyConfigTemplates.revision, row.revision),
      ),
    )
    .returning();
  if (!updated) throw new TopologyOperationError('revision_conflict', 409);
  if (value.lifecycle === 'revoked') {
    // Scope comes from rows referencing this authorized version, never user-supplied site IDs.
    // RLS may hide partner-wide dependents: dispatch also checks revocation live.
    await db.execute(sql`UPDATE topology_monitoring_policies SET enabled=false,authority_digest=NULL,authority_generation=authority_generation+1,blocked_reason='template_revoked',updated_at=now()
   WHERE partner_version_id IN(SELECT id FROM topology_config_template_versions WHERE template_id=${id}::uuid) OR org_version_id IN(SELECT id FROM topology_config_template_versions WHERE template_id=${id}::uuid)`);
  }
  await audit(
    auth,
    updated,
    value.lifecycle === 'revoked' ? 'revoked' : 'updated',
    id,
  );
  return { ...updated, revision: updated.revision.toString() };
}
export async function listTopologyTemplateVersions(
  auth: AuthContext,
  permissions: UserPermissions,
  id: string,
  input: { cursor?: string; limit?: number } = {},
) {
  const template = await loadTemplate(auth, permissions, id, false);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(input.limit ?? 100);
  const rows = await db
    .select()
    .from(topologyConfigTemplateVersions)
    .where(
      and(
        eq(topologyConfigTemplateVersions.templateId, id),
        input.cursor
          ? gt(topologyConfigTemplateVersions.id, z.uuid().parse(input.cursor))
          : undefined,
      ),
    )
    .orderBy(asc(topologyConfigTemplateVersions.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map((row) => versionDto(row, template)),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}
export async function createTopologyTemplateVersion(
  auth: AuthContext,
  permissions: UserPermissions,
  id: string,
  input: z.input<typeof createTopologyTemplateVersionSchema>,
) {
  const value = createTopologyTemplateVersionSchema.parse(input);
  await loadTemplate(auth, permissions, id, true);
  return withDbTransaction(async () => {
    const [template] = await db
      .select()
      .from(topologyConfigTemplates)
      .where(eq(topologyConfigTemplates.id, id))
      .for('update');
    if (!template)
      throw new TopologyOperationError('topology_template_not_found', 404);
    assertRevision(template.revision, value.expectedRevision);
    if (template.lifecycle !== 'active')
      throw new TopologyOperationError('template_unavailable', 409);
    const [maximum] = await db.execute(
      sql`SELECT coalesce(max(version),0)+1 AS next_version FROM topology_config_template_versions WHERE template_id=${id}::uuid`,
    );
    const { expectedRevision: _, ...content } = value;
    const contentDigest = computeArgumentDigest(canonicalizeArguments(content));
    const [row] = await db
      .insert(topologyConfigTemplateVersions)
      .values({
        ...content,
        templateId: id,
        orgId: template.orgId,
        partnerId: template.partnerId,
        version: Number(maximum!.next_version),
        contentDigest,
      })
      .returning();
    if (!row) throw new TopologyOperationError('version_create_failed', 503);
    await db
      .update(topologyConfigTemplates)
      .set({ revision: template.revision + 1n, updatedAt: new Date() })
      .where(eq(topologyConfigTemplates.id, id));
    await audit(auth, template, 'version_created', row.id);
    return versionDto(row, template);
  });
}
export async function publishTopologyTemplateVersion(
  auth: AuthContext,
  permissions: UserPermissions,
  id: string,
  versionId: string,
  input: z.input<typeof publishTopologyTemplateVersionSchema>,
) {
  const value = publishTopologyTemplateVersionSchema.parse(input);
  await loadTemplate(auth, permissions, id, true);
  return withDbTransaction(async () => {
    const [template] = await db
      .select()
      .from(topologyConfigTemplates)
      .where(eq(topologyConfigTemplates.id, id))
      .for('update');
    if (!template)
      throw new TopologyOperationError('topology_template_not_found', 404);
    assertRevision(template.revision, value.expectedTemplateRevision);
    if (template.lifecycle !== 'active')
      throw new TopologyOperationError('template_unavailable', 409);
    const [version] = await db
      .select()
      .from(topologyConfigTemplateVersions)
      .where(
        and(
          eq(topologyConfigTemplateVersions.id, z.uuid().parse(versionId)),
          eq(topologyConfigTemplateVersions.templateId, id),
        ),
      )
      .for('update');
    if (!version)
      throw new TopologyOperationError('topology_version_not_found', 404);
    assertRevision(version.revision, value.expectedVersionRevision);
    if (version.state === 'published') return versionDto(version, template);
    const payload = topologyConfigurationSchema.parse(version.payload);
    const [published] = await db
      .update(topologyConfigTemplateVersions)
      .set({
        payload,
        state: 'published',
        publishedAt: new Date(),
        publishedBy: auth.user.id,
        revision: version.revision + 1n,
        updatedAt: new Date(),
      })
      .where(eq(topologyConfigTemplateVersions.id, versionId))
      .returning();
    await db
      .update(topologyConfigTemplates)
      .set({ revision: template.revision + 1n, updatedAt: new Date() })
      .where(eq(topologyConfigTemplates.id, id));
    await audit(auth, template, 'published', versionId);
    return versionDto(published!, template);
  });
}
export async function listEligibleTopologyVersions(
  ctx: TopologyRequestContext,
  page: { cursor?: string; limit?: number } = {},
): Promise<{ items: TopologyTemplateVersion[]; nextCursor: string | null }> {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(page.limit ?? 100);
  const current = await requireTopologySiteAccess(
    ctx.auth,
    ctx.permissions,
    ctx.scope.siteId,
    'read',
  );
  if (current.scope.orgId !== ctx.scope.orgId)
    throw new TopologyOperationError('topology_site_not_found', 404);
  const owner = or(
    and(
      eq(topologyConfigTemplates.orgId, ctx.scope.orgId),
      isNull(topologyConfigTemplates.partnerId),
    ),
    ctx.auth.partnerId
      ? and(
          eq(topologyConfigTemplates.partnerId, ctx.auth.partnerId),
          isNull(topologyConfigTemplates.orgId),
        )
      : undefined,
  );
  const rows = await db
    .select({
      version: topologyConfigTemplateVersions,
      template: topologyConfigTemplates,
    })
    .from(topologyConfigTemplateVersions)
    .innerJoin(
      topologyConfigTemplates,
      eq(topologyConfigTemplateVersions.templateId, topologyConfigTemplates.id),
    )
    .where(
      and(
        owner,
        eq(topologyConfigTemplateVersions.state, 'published'),
        eq(topologyConfigTemplates.lifecycle, 'active'),
        page.cursor
          ? gt(topologyConfigTemplateVersions.id, z.uuid().parse(page.cursor))
          : undefined,
      ),
    )
    .orderBy(asc(topologyConfigTemplateVersions.id))
    .limit(limit + 1);
  return {
    items: rows
      .slice(0, limit)
      .map((row) => versionDto(row.version, row.template)),
    nextCursor: rows.length > limit ? rows[limit - 1]!.version.id : null,
  };
}
