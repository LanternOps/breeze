import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import {
  createTopologyTemplate,
  createTopologyTemplateVersion,
  publishTopologyTemplateVersion,
  listTopologyTemplateVersions,
  listEligibleTopologyVersions,
  updateTopologyTemplate,
} from '../../services/topology/templateLibrary';
import { createTopologyTenant, orgContext } from './topology-fixtures';
const actor = '00000000-0000-4000-8000-000000000001';
function context(t: Awaited<ReturnType<typeof createTopologyTenant>>) {
  const auth = {
    user: { id: actor, email: 'topology@example.test' },
    scope: 'organization',
    orgId: t.orgId,
    partnerId: t.partnerId,
    canAccessOrg: (id: string) => id === t.orgId,
  } as AuthContext;
  const permissions = {
    permissions: [
      { resource: 'topology', action: 'read' },
      { resource: 'topology', action: 'write' },
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'write' },
    ],
    scope: 'organization',
    orgId: t.orgId,
    partnerId: t.partnerId,
    roleId: actor,
  } as UserPermissions;
  return { auth, permissions, scope: { orgId: t.orgId, siteId: t.siteId } };
}
describe('template library persistence', () => {
  it('publishes immutable content without applying it and pages own published versions', async () => {
    const t = await createTopologyTenant(),
      ctx = context(t);
    await withDbAccessContext(
      { ...orgContext(t.orgId), currentPartnerId: t.partnerId },
      async () => {
        const template = await createTopologyTemplate(
          ctx.auth,
          ctx.permissions,
          { ownerScope: 'organization', key: 'office', name: 'Office' },
        );
        const input = {
          expectedRevision: '1',
          schemaVersion: 1 as const,
          defaultsVersion: 1 as const,
          resolverVersion: 1 as const,
          payload: { targets: {}, policies: {}, outboundEnabled: false },
        };
        const draft = await createTopologyTemplateVersion(
          ctx.auth,
          ctx.permissions,
          template.id,
          input,
        );
        expect(draft.state).toBe('draft');
        expect((await listEligibleTopologyVersions(ctx)).items).toHaveLength(0);
        const published = await publishTopologyTemplateVersion(
          ctx.auth,
          ctx.permissions,
          template.id,
          draft.id,
          { expectedTemplateRevision: '2', expectedVersionRevision: '1' },
        );
        expect(published.state).toBe('published');
        expect(published.contentDigest).toBe(draft.contentDigest);
        expect(
          (
            await listTopologyTemplateVersions(
              ctx.auth,
              ctx.permissions,
              template.id,
            )
          ).items,
        ).toHaveLength(1);
        expect(
          (await listEligibleTopologyVersions(ctx)).items.map((v) => v.id),
        ).toEqual([draft.id]);
        expect(
          (
            await db.execute(
              sql`SELECT count(*)::int n FROM topology_site_template_bindings WHERE org_id=${t.orgId}::uuid`,
            )
          )[0]?.n,
        ).toBe(0);
        expect(
          (
            await db.execute(
              sql`SELECT count(*)::int n FROM topology_monitoring_policies WHERE org_id=${t.orgId}::uuid`,
            )
          )[0]?.n,
        ).toBe(0);
        await expect(
          createTopologyTemplateVersion(
            ctx.auth,
            ctx.permissions,
            template.id,
            input,
          ),
        ).rejects.toMatchObject({ code: 'revision_conflict' });
        await updateTopologyTemplate(ctx.auth, ctx.permissions, template.id, {
          expectedRevision: '3',
          lifecycle: 'archived',
        });
        expect((await listEligibleTopologyVersions(ctx)).items).toHaveLength(0);
        await expect(
          createTopologyTemplateVersion(
            ctx.auth,
            ctx.permissions,
            template.id,
            { ...input, expectedRevision: '4' },
          ),
        ).rejects.toMatchObject({ code: 'template_unavailable' });
      },
    );
  });
  it('site readers can select own-partner published options but cannot see drafts or foreign owners', async () => {
    const a = await createTopologyTenant(),
      b = await createTopologyTenant(),
      ctx = context(a);
    await withSystemDbAccessContext(async () => {
      for (const [partnerId, state] of [
        [a.partnerId, 'published'],
        [a.partnerId, 'draft'],
        [b.partnerId, 'published'],
      ] as const) {
        const template = crypto.randomUUID();
        await db.execute(
          sql`INSERT INTO topology_config_templates(id,partner_id,key,name) VALUES(${template}::uuid,${partnerId}::uuid,${'key-' + template},${template})`,
        );
        await db.execute(
          sql`INSERT INTO topology_config_template_versions(template_id,partner_id,version,state,payload,content_digest,published_at) VALUES(${template}::uuid,${partnerId}::uuid,1,${state},'{"targets":{},"policies":{}}',${'0'.repeat(64)},${state === 'published' ? new Date().toISOString() : null})`,
        );
      }
    });
    ctx.auth.allowedSiteIds = [a.siteId];
    ctx.permissions.allowedSiteIds = [a.siteId];
    ctx.permissions.permissions = ctx.permissions.permissions.filter(
      (p) => p.action === 'read',
    );
    await withDbAccessContext(
      { ...orgContext(a.orgId), currentPartnerId: a.partnerId },
      async () => {
        const result = await listEligibleTopologyVersions(ctx, { limit: 1 });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.ownerScope).toBe('partner');
        expect(result.items[0]?.state).toBe('published');
        expect(result.nextCursor).toBeNull();
      },
    );
  });
});
