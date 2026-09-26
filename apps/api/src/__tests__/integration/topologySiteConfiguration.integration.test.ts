import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import {
  loadTopologyConfiguration,
  updateTopologySiteConfiguration,
  applyTopologyTemplateSite,
} from '../../services/topology/siteConfiguration';
import {
  upsertTopologyProbeTarget,
  upsertTopologyMonitoringPolicy,
  deleteTopologyConfigurationObject,
  listTopologyConfigurationObjects,
} from '../../services/topology/configurationObjects';
import { readTopologySiteSettings } from '../../services/topology/siteSettings';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import type {
  TopologyTargetDefinition,
  TopologyPolicyDefinition,
} from '@breeze/shared';
const actor = '00000000-0000-4000-8000-000000000001';
const target: TopologyTargetDefinition = {
  kind: 'tcp',
  label: 'Application',
  host: 'service.example.test',
  port: 443,
  enabled: true,
  families: ['ipv4'],
  provider: null,
  independenceLabel: null,
};
const policy: TopologyPolicyDefinition = {
  kind: 'policy',
  enabled: false,
  recipeId: 'target_connectivity',
  recipeVersion: 1,
  subject: 'configured_target',
  targetKeys: ['app'],
  families: ['ipv4'],
  origin: 'eligible_collector',
  intervalSeconds: 300,
  jitterPercent: 10,
  alertsEnabled: false,
  failureThreshold: 3,
  recoveryThreshold: 2,
};
function context(t: Awaited<ReturnType<typeof createTopologyTenant>>) {
  return {
    scope: { orgId: t.orgId, siteId: t.siteId },
    auth: {
      user: { id: actor, email: 'topology@example.test' },
      principal: { kind: 'user_session' },
      token: { mfa: true },
      scope: 'organization',
      orgId: t.orgId,
      partnerId: t.partnerId,
      canAccessOrg: (id: string) => id === t.orgId,
    } as AuthContext,
    permissions: {
      permissions: ['topology', 'devices'].flatMap((resource) =>
        ['read', 'write', 'execute'].map((action) => ({ resource, action })),
      ),
      scope: 'organization',
      orgId: t.orgId,
      partnerId: t.partnerId,
      roleId: actor,
    } as UserPermissions,
  };
}
describe('site configuration compiler', () => {
  it('serializes simultaneous settings revisions so only one edit commits', async () => {
    const t = await createTopologyTenant(),
      ctx = context(t);
    const results = await Promise.allSettled(
      [false, true].map((enabled) =>
        withDbAccessContext(orgContext(t.orgId), () =>
          updateTopologySiteConfiguration(
            ctx,
            { passive: { enabled }, targets: {}, policies: {} },
            '0',
          ),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .map((result) => (result as PromiseRejectedResult).reason.code),
    ).toEqual(['revision_conflict']);
    await withDbAccessContext(orgContext(t.orgId), async () =>
      expect((await loadTopologyConfiguration(ctx)).settingsRevision).toBe('1'),
    );
  });

  it('persists explicit target overrides, revisions, links and disabled policy drafts atomically', async () => {
    const t = await createTopologyTenant(),
      ctx = context(t);
    await withDbAccessContext(orgContext(t.orgId), async () => {
      const before = await readTopologySiteSettings(ctx);
      expect(before.settingsRevision).toBe('0');
      expect(before.capabilities.recurringMonitoring.available).toBe(false);
      const saved = await upsertTopologyProbeTarget(ctx, {
        key: 'app',
        definition: target,
        expectedRevision: '0',
      });
      expect(saved).toHaveProperty('revision', '1');
      let snapshot = await loadTopologyConfiguration(ctx);
      expect(snapshot.layers.site?.targets.app).toEqual(target);
      expect(snapshot.settingsRevision).toBe('1');
      await upsertTopologyMonitoringPolicy(ctx, {
        key: 'availability',
        definition: policy,
        expectedRevision: '1',
      });
      expect(
        (
          await db.execute(
            sql`SELECT enabled,authority_digest FROM topology_monitoring_policies WHERE org_id=${t.orgId}::uuid`,
          )
        )[0],
      ).toEqual({ enabled: false, authority_digest: null });
      expect(
        (
          await db.execute(
            sql`SELECT count(*)::int n FROM topology_policy_targets WHERE org_id=${t.orgId}::uuid`,
          )
        )[0]?.n,
      ).toBe(1);
      // M3: `enabled` is activation intent only — the compile records it and
      // arms nothing; arming is the separate human-only route.
      await upsertTopologyMonitoringPolicy(ctx, {
        key: 'availability',
        definition: { ...policy, enabled: true },
        expectedRevision: '2',
      });
      expect(
        (
          await db.execute(
            sql`SELECT enabled,activation_intent,authority_digest,blocked_reason FROM topology_monitoring_policies WHERE org_id=${t.orgId}::uuid`,
          )
        )[0],
      ).toEqual({ enabled: false, activation_intent: true, authority_digest: null, blocked_reason: 'not_armed' });
      snapshot = await loadTopologyConfiguration(ctx);
      expect(snapshot.settingsRevision).toBe('3');
      expect(
        (
          await db.execute(
            sql`SELECT count(*)::int n FROM topology_change_outbox WHERE org_id=${t.orgId}::uuid AND event_kind='configuration.change'`,
          )
        )[0]?.n,
      ).toBe(3);
      expect(
        (
          await db.execute(
            sql`SELECT count(*)::int n FROM topology_diagnostic_runs WHERE org_id=${t.orgId}::uuid`,
          )
        )[0]?.n,
      ).toBe(0);
    });
  });
  it('preserves direct overrides during template apply and replays an operation without reapplying it', async () => {
    const t = await createTopologyTenant(),
      ctx = context(t);
    await withDbAccessContext(orgContext(t.orgId), async () => {
      await upsertTopologyProbeTarget(ctx, {
        key: 'app',
        definition: target,
        expectedRevision: '0',
      });
      const templateId = crypto.randomUUID(),
        versionId = crypto.randomUUID();
      await db.execute(
        sql`INSERT INTO topology_config_templates(id,org_id,key,name) VALUES(${templateId}::uuid,${t.orgId}::uuid,'base','Base')`,
      );
      await db.execute(
        sql`INSERT INTO topology_config_template_versions(id,template_id,org_id,version,state,payload,content_digest,published_at) VALUES(${versionId}::uuid,${templateId}::uuid,${t.orgId}::uuid,1,'published',${JSON.stringify({ targets: { app: { ...target, host: 'inherited.example.test' } }, policies: {} })}::jsonb,${'0'.repeat(64)},now())`,
      );
      const snapshot = await loadTopologyConfiguration(ctx, {
        partnerVersionId: null,
        orgVersionId: versionId,
      });
      const effect = {
        siteId: t.siteId,
        expectedBindingRevision: '1',
        expectedSettingsRevision: '1',
        partnerVersionId: null,
        orgVersionId: versionId,
        overrides: snapshot.layers.site!,
        resolvedDigest: snapshot.resolved.digest,
        templateRevisions: snapshot.templateRevisions,
        enableRecurring: false,
        operationId: crypto.randomUUID(),
      };
      const applied = await applyTopologyTemplateSite(ctx, effect);
      expect(applied.settingsRevision).toBe('2');
      expect(
        (await applyTopologyTemplateSite(ctx, effect)).settingsRevision,
      ).toBe('2');
      const after = await loadTopologyConfiguration(ctx);
      expect(after.layers.site?.targets.app).toEqual(target);
      expect(after.binding?.revision).toBe(2n);
      expect(after.binding?.orgVersionId).toBe(versionId);
      expect(after.resolved.settings.targets.app).toEqual(target);
      await expect(
        applyTopologyTemplateSite(ctx, {
          ...effect,
          operationId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
    });
  });
  it('requires execute grants for target edits but permits passive-only settings with write grants', async () => {
    const t = await createTopologyTenant(),
      ctx = context(t);
    ctx.permissions.permissions = ctx.permissions.permissions.filter(
      (p) => p.action !== 'execute',
    );
    await withDbAccessContext(orgContext(t.orgId), async () => {
      await updateTopologySiteConfiguration(
        ctx,
        { passive: { enabled: false }, targets: {}, policies: {} },
        '0',
      );
      await expect(
        updateTopologySiteConfiguration(
          ctx,
          { targets: { app: target }, policies: {} },
          '1',
        ),
      ).rejects.toMatchObject({ code: 'topology_permission_denied' });
      expect((await loadTopologyConfiguration(ctx)).settingsRevision).toBe('1');
    });
  });
  it('denies foreign sites and stale revisions; deletes into tombstones without deleting reused monitor rows', async () => {
    const t = await createTopologyTenant(),
      other = await createTopologyTenant(),
      ctx = context(t);
    await withDbAccessContext(orgContext(t.orgId), async () => {
      const saved = await upsertTopologyProbeTarget(ctx, {
        key: 'app',
        definition: target,
        expectedRevision: '0',
      });
      await expect(
        updateTopologySiteConfiguration(
          { ...ctx, scope: { orgId: other.orgId, siteId: other.siteId } },
          { targets: {}, policies: {} },
          '0',
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        upsertTopologyProbeTarget(ctx, {
          key: 'app',
          definition: target,
          expectedRevision: '0',
        }),
      ).rejects.toMatchObject({ code: 'revision_conflict' });
      if (!('id' in saved)) throw new Error('target missing');
      await deleteTopologyConfigurationObject(ctx, 'targets', saved.id, {
        expectedRevision: '1',
      });
      expect(
        (await loadTopologyConfiguration(ctx)).layers.site?.targets.app,
      ).toEqual({ kind: 'tombstone' });
      expect(
        (await listTopologyConfigurationObjects(ctx, 'targets', { limit: 100 }))
          .items,
      ).toHaveLength(0);
      expect(
        (
          await db.execute(
            sql`SELECT deleted_at IS NOT NULL AS tombstoned FROM topology_probe_targets WHERE id=${saved.id}::uuid`,
          )
        )[0]?.tombstoned,
      ).toBe(true);
    });
  });
});
