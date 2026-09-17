import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  organizationUsers,
  sites,
  topologyChangeOutbox,
} from '../../db/schema';
import {
  withAuthDbAccessContext,
  type AuthContext,
} from '../../middleware/auth';
import { getUserPermissions } from '../../services/permissions';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import {
  previewTopologyTemplateApplication,
  applyTopologyTemplatePreview,
  getTopologyTemplateApplication,
} from '../../services/topology/templateApply';
import { drainTopologyTemplateApplications } from '../../services/topology/templateApplicationExecution';
import { updateTopologySiteConfiguration } from '../../services/topology/siteConfiguration';
import { pruneDeliveredTopologyOutbox } from '../../services/topology/legacyRetention';
import { INTENT_EVENT } from '../../services/topology/templateApplicationTypes';

async function fixture(count = 1) {
  const env = await setupTestEnvironment();
  const siteIds = [
    env.site.id,
    ...Array.from({ length: count - 1 }, () => randomUUID()),
  ];
  if (count > 1)
    await getTestDb()
      .insert(sites)
      .values(
        siteIds.slice(1).map((id, index) => ({
          id,
          orgId: env.organization.id,
          name: `Application site ${index}`,
        })),
      );
  const auth: AuthContext = {
    principal: { kind: 'user_session' },
    user: {
      id: env.user.id,
      email: env.user.email,
      name: env.user.name,
      isPlatformAdmin: false,
    },
    token: {
      sub: env.user.id,
      email: env.user.email,
      roleId: env.role.id,
      orgId: env.organization.id,
      partnerId: env.partner.id,
      scope: 'organization',
      type: 'access',
      mfa: true,
      aep: 1,
      mep: 1,
    },
    scope: 'organization',
    orgId: env.organization.id,
    partnerId: env.partner.id,
    accessibleOrgIds: [env.organization.id],
    canAccessOrg: (id) => id === env.organization.id,
    orgCondition: (column) => eq(column, env.organization.id),
  };
  const permissions = (await getUserPermissions(
    env.user.id,
    {
      orgId: env.organization.id,
      partnerId: env.partner.id,
      scope: 'organization',
    },
    { bypassCache: true },
  ))!;
  const request = {
    partnerVersionId: null,
    orgVersionId: null,
    sites: siteIds.map((siteId) => ({
      siteId,
      expectedBindingRevision: '0',
      enableRecurring: false,
      overrides: { targets: {}, policies: {}, passive: { enabled: false } },
    })),
  };
  const run = <T>(fn: () => Promise<T>) => withAuthDbAccessContext(auth, fn);
  /** A published library version owned by this fixture's org or partner. */
  const publishVersion = async (owner: 'organization' | 'partner') => {
    const templateId = randomUUID(),
      versionId = randomUUID();
    const ownerOrg = owner === 'organization' ? env.organization.id : null,
      ownerPartner = owner === 'partner' ? env.partner.id : null;
    await getTestDb().execute(
      sql`INSERT INTO topology_config_templates(id,org_id,partner_id,key,name)
        VALUES(${templateId}::uuid,${ownerOrg}::uuid,${ownerPartner}::uuid,${`k-${versionId.slice(0, 8)}`},${`Template ${versionId.slice(0, 8)}`})`,
    );
    await getTestDb().execute(
      sql`INSERT INTO topology_config_template_versions(id,template_id,org_id,partner_id,version,state,payload,content_digest,published_at)
        VALUES(${versionId}::uuid,${templateId}::uuid,${ownerOrg}::uuid,${ownerPartner}::uuid,1,'published',
        ${JSON.stringify({ targets: {}, policies: {}, passive: { enabled: true } })}::jsonb,${'0'.repeat(64)},now())`,
    );
    return { templateId, versionId };
  };
  const auditActions = async (operationId: string) =>
    withSystemDbAccessContext(async () => {
      const rows = await db.execute(
        sql`SELECT action,result,details FROM audit_logs WHERE resource_type='topology_template_application' AND resource_id=${operationId}::uuid`,
      );
      return rows.map((row) => String(row.action)).sort();
    });
  const bindingCount = async () =>
    withSystemDbAccessContext(async () => {
      const [row] = await db.execute(
        sql`SELECT count(*)::int n FROM topology_site_template_bindings WHERE org_id=${env.organization.id}::uuid`,
      );
      return row!.n as number;
    });
  const outcomes = async (operationId: string) =>
    withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(topologyChangeOutbox)
        .where(eq(topologyChangeOutbox.aggregateId, operationId));
      return rows.map((row) => (row.payload as any).outcome);
    });
  return {
    env,
    auth,
    permissions,
    siteIds,
    request,
    run,
    publishVersion,
    auditActions,
    bindingCount,
    outcomes,
  };
}
describe('durable topology template applications', () => {
  it('commits198of200 sites once, conflicts changed/unauthorized sites, and redacts denied status', async () => {
    const f = await fixture(200);
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, f.request),
    );
    expect(preview.sites).toHaveLength(200);
    expect(preview.sites.every((site) => !site.errors.length)).toBe(true);
    const operation = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'apply-200',
      ),
    );
    await f.run(() =>
      updateTopologySiteConfiguration(
        {
          auth: f.auth,
          permissions: f.permissions,
          scope: { orgId: f.env.organization.id, siteId: f.siteIds[3]! },
        },
        { targets: {}, policies: {}, passive: { neighbors: false } },
        '0',
      ),
    );
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: f.siteIds.filter((_, index) => index !== 7) })
      .where(eq(organizationUsers.userId, f.env.user.id));
    expect(await drainTopologyTemplateApplications(500)).toBe(200);
    await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(topologyChangeOutbox)
        .where(eq(topologyChangeOutbox.aggregateId, operation.id));
      const outcomes = rows.map((row) => (row.payload as any).outcome);
      expect(outcomes.filter((o) => o.state === 'applied')).toHaveLength(198);
      expect(
        outcomes
          .filter((o) => o.state === 'conflict')
          .map((o) => o.code)
          .sort(),
      ).toEqual(['permission_changed', 'revision_conflict']);
      const [commands] = await db.execute(
        sql`SELECT count(*)::int n FROM device_commands WHERE device_id IN(SELECT id FROM devices WHERE org_id=${f.env.organization.id}::uuid)`,
      );
      expect(commands!.n).toBe(0);
    });
    const visible = await f.run(() =>
      getTopologyTemplateApplication(f.auth, f.permissions, operation.id),
    );
    expect(visible.sites).toHaveLength(199);
    expect(visible.sites.some((site) => site.siteId === f.siteIds[7])).toBe(
      false,
    );
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: null })
      .where(eq(organizationUsers.userId, f.env.user.id));
    const restored = await f.run(() =>
      getTopologyTemplateApplication(f.auth, f.permissions, operation.id),
    );
    expect(
      restored.sites.filter((site) => site.state === 'applied'),
    ).toHaveLength(198);
    expect(
      restored.sites
        .filter((site) => site.state === 'conflict')
        .map((site) => site.code)
        .sort(),
    ).toEqual(['permission_changed', 'revision_conflict']);
    const again = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'apply-200',
      ),
    );
    expect(again.id).toBe(operation.id);
    expect(await drainTopologyTemplateApplications(500)).toBe(0);
    await withSystemDbAccessContext(async () => {
      const [commits] = await db.execute(
        sql`SELECT count(*)::int n FROM topology_site_template_bindings WHERE org_id=${f.env.organization.id}::uuid AND apply_operation_id=${operation.id}::uuid`,
      );
      expect(commits!.n).toBe(198);
    });
  }, 120_000);
  it('rejects expired previews/body-conflicting idempotency and isolates requester/tenant status', async () => {
    const f = await fixture();
    const other = await fixture();
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, f.request),
    );
    const operation = await f.run(() =>
      applyTopologyTemplatePreview(f.auth, f.permissions, preview.token, 'one'),
    );
    const next = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, f.request),
    );
    await expect(
      f.run(() =>
        applyTopologyTemplatePreview(f.auth, f.permissions, next.token, 'one'),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      other.run(() =>
        getTopologyTemplateApplication(
          other.auth,
          other.permissions,
          operation.id,
        ),
      ),
    ).rejects.toMatchObject({ code: 'application_not_found' });
    await withSystemDbAccessContext(() =>
      db.execute(
        sql`UPDATE topology_change_outbox SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE event_kind='template.application.preview' AND payload->>'requesterId'=${f.auth.user.id}`,
      ),
    );
    await expect(
      f.run(() =>
        applyTopologyTemplatePreview(
          f.auth,
          f.permissions,
          next.token,
          'expired',
        ),
      ),
    ).rejects.toMatchObject({ code: 'preview_expired' });
  });
  it('never overwrites a moved intent scope and keeps pending application journals past30days', async () => {
    const f = await fixture();
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, f.request),
    );
    const operation = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'scope',
      ),
    );
    await withSystemDbAccessContext(async () => {
      await db.execute(
        sql`UPDATE topology_change_outbox SET delivered_at=now()-interval '40 days',updated_at=now()-interval '40 days' WHERE aggregate_id=${operation.id}::uuid`,
      );
      await pruneDeliveredTopologyOutbox({
        orgId: f.env.organization.id,
        siteId: f.env.site.id,
      });
      expect(
        await db
          .select()
          .from(topologyChangeOutbox)
          .where(eq(topologyChangeOutbox.aggregateId, operation.id)),
      ).toHaveLength(1);
    });
    await withSystemDbAccessContext(() =>
      db.execute(
        sql`UPDATE topology_change_outbox SET payload=jsonb_set(payload,'{originalOrgId}',to_jsonb(${randomUUID()}::text)) WHERE aggregate_id=${operation.id}::uuid AND event_kind=${INTENT_EVENT}`,
      ),
    );
    await drainTopologyTemplateApplications();
    await withSystemDbAccessContext(async () => {
      const [record] = await db
        .select()
        .from(topologyChangeOutbox)
        .where(eq(topologyChangeOutbox.aggregateId, operation.id));
      expect((record!.payload as any).outcome.code).toBe('preview_invalidated');
      const [count] = await db.execute(
        sql`SELECT count(*)::int n FROM topology_site_template_bindings WHERE org_id=${f.env.organization.id}::uuid`,
      );
      expect(count!.n).toBe(0);
    });
  });
  it('conflicts a pinned version whose template revision moved after admission', async () => {
    const f = await fixture();
    const { templateId, versionId } = await f.publishVersion('organization');
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, {
        ...f.request,
        orgVersionId: versionId,
      }),
    );
    expect(preview.sites[0]!.errors).toEqual([]);
    const op = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'revision-moved',
      ),
    );
    // The library moved between admission and execution: the approved effect
    // no longer describes the content it was digested against.
    await getTestDb().execute(
      sql`UPDATE topology_config_templates SET revision=revision+1 WHERE id=${templateId}::uuid`,
    );
    expect(await drainTopologyTemplateApplications()).toBe(1);
    expect(await f.outcomes(op.id)).toEqual([
      {
        siteId: f.env.site.id,
        state: 'conflict',
        code: 'template_revision_changed',
        settingsRevision: null,
      },
    ]);
    expect(await f.bindingCount()).toBe(0);
    expect(await f.auditActions(op.id)).toEqual([
      'topology.template.application_accepted',
      'topology.template.application_conflict',
    ]);
  });
  it('refuses another partner library version instead of resolving it', async () => {
    const f = await fixture();
    const other = await fixture();
    const foreign = await other.publishVersion('partner');
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, {
        ...f.request,
        partnerVersionId: foreign.versionId,
      }),
    );
    expect(preview.sites[0]!.errors).toEqual([
      { code: 'template_version_unavailable', field: null },
    ]);
    expect(preview.sites[0]!.effects).toEqual([]);
    const op = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'cross-partner',
      ),
    );
    expect(await drainTopologyTemplateApplications()).toBe(0);
    expect(await f.outcomes(op.id)).toEqual([
      {
        siteId: f.env.site.id,
        state: 'conflict',
        code: 'template_version_unavailable',
        settingsRevision: null,
      },
    ]);
    expect(await f.bindingCount()).toBe(0);
    // A site the worker will never touch still has to leave a conflict trail.
    expect(await f.auditActions(op.id)).toEqual([
      'topology.template.application_accepted',
      'topology.template.application_conflict',
    ]);
  });
  it('audits each commit and refuses a tampered approved effect', async () => {
    const f = await fixture(2);
    const { versionId } = await f.publishVersion('organization');
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, {
        ...f.request,
        orgVersionId: versionId,
      }),
    );
    expect(Date.parse(preview.expiresAt) - Date.now()).toBeGreaterThan(
      9 * 60_000,
    );
    expect(Date.parse(preview.expiresAt) - Date.now()).toBeLessThanOrEqual(
      10 * 60_000,
    );
    const op = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'tamper',
      ),
    );
    // Rewriting the stored effect must not change what is applied: the digest
    // is what binds the approved intent, not the row it is stored in.
    const tampered = await withSystemDbAccessContext(() =>
      db.execute(
        sql`UPDATE topology_change_outbox
          SET payload=jsonb_set(payload,'{effect,overrides,passive,enabled}','true'::jsonb)
          WHERE aggregate_id=${op.id}::uuid AND event_kind=${INTENT_EVENT} AND site_id=${f.siteIds[1]!}::uuid
            AND payload->'effect'->'overrides'->'passive'->>'enabled'='false'
          RETURNING id`,
      ),
    );
    // Prove the control actually mutated a row before trusting the red below.
    expect(tampered).toHaveLength(1);
    expect(await drainTopologyTemplateApplications()).toBe(2);
    const byState = Object.fromEntries(
      (await f.outcomes(op.id)).map((outcome) => [outcome.siteId, outcome]),
    );
    expect(byState[f.siteIds[0]!]).toMatchObject({
      state: 'applied',
      code: null,
    });
    expect(byState[f.siteIds[1]!]).toMatchObject({
      state: 'conflict',
      code: 'preview_invalidated',
    });
    expect(await f.bindingCount()).toBe(1);
    expect(await f.auditActions(op.id)).toEqual([
      'topology.template.application_accepted',
      'topology.template.application_accepted',
      'topology.template.application_applied',
      'topology.template.application_conflict',
    ]);
  });
  it('rolls back configuration when journal publication fails and retries once after recovery', async () => {
    const f = await fixture();
    const preview = await f.run(() =>
      previewTopologyTemplateApplication(f.auth, f.permissions, f.request),
    );
    const op = await f.run(() =>
      applyTopologyTemplatePreview(
        f.auth,
        f.permissions,
        preview.token,
        'rollback',
      ),
    );
    await getTestDb().execute(
      sql.raw(
        `CREATE FUNCTION topology_test_apply_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='${op.id}'::uuid AND NEW.payload->'outcome'->>'state'='applied' THEN RAISE EXCEPTION 'test journal unavailable' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`,
      ),
    );
    await getTestDb().execute(
      sql`CREATE TRIGGER topology_test_apply_failure BEFORE UPDATE ON topology_change_outbox FOR EACH ROW EXECUTE FUNCTION topology_test_apply_failure()`,
    );
    try {
      await expect(drainTopologyTemplateApplications()).rejects.toThrow();
      await withSystemDbAccessContext(async () => {
        const [count] = await db.execute(
          sql`SELECT count(*)::int n FROM topology_site_template_bindings WHERE org_id=${f.env.organization.id}::uuid`,
        );
        expect(count!.n).toBe(0);
        const [record] = await db
          .select()
          .from(topologyChangeOutbox)
          .where(eq(topologyChangeOutbox.aggregateId, op.id));
        expect((record!.payload as any).outcome.state).toBe('queued');
        expect(record!.attemptCount).toBe(1);
      });
    } finally {
      await getTestDb().execute(
        sql`DROP TRIGGER topology_test_apply_failure ON topology_change_outbox`,
      );
      await getTestDb().execute(
        sql`DROP FUNCTION topology_test_apply_failure()`,
      );
    }
    await withSystemDbAccessContext(() =>
      db
        .update(topologyChangeOutbox)
        .set({ nextAttemptAt: null })
        .where(eq(topologyChangeOutbox.aggregateId, op.id)),
    );
    expect(await drainTopologyTemplateApplications()).toBe(1);
    expect(
      (
        await f.run(() =>
          getTopologyTemplateApplication(f.auth, f.permissions, op.id),
        )
      ).state,
    ).toBe('completed');
    expect(await drainTopologyTemplateApplications()).toBe(0);
  });
});
