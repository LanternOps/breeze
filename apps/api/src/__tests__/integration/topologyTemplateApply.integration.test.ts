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
  return { env, auth, permissions, siteIds, request, run };
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
