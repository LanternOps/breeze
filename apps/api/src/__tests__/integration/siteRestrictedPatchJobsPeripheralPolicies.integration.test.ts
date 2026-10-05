import './setup';

import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { patchRoutes } from '../../routes/patches/index';
import { peripheralControlRoutes } from '../../routes/peripheralControl';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

/**
 * Real-Postgres coverage for the site-restricted reader paths on
 * GET /patches/jobs(/:id) and GET /peripherals/policies(/:id): the requests run
 * through authMiddleware + requirePermission, so the queries execute as
 * `breeze_app` inside the normal request DB context. The SQL visibility
 * conditions (jsonb_exists / jsonb_exists_any over targets) must parse and
 * filter correctly, and unrestricted readers must see rows unchanged.
 */

function buildApp(): Hono {
  const app = new Hono();
  app.route('/patches', patchRoutes);
  app.route('/peripherals', peripheralControlRoutes);
  return app;
}

async function clientFor(app: Hono, opts: { userId: string; email: string; roleId: string; orgId: string; partnerId: string }) {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: opts.userId,
    email: opts.email,
    roleId: opts.roleId,
    orgId: opts.orgId,
    partnerId: opts.partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  return async (path: string) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as any };
  };
}

interface Fixture {
  restricted: (path: string) => Promise<{ status: number; body: any }>;
  unrestricted: (path: string) => Promise<{ status: number; body: any }>;
  siteA: string;
  siteB: string;
  devA: string;
  devB: string;
  grpA: string;
  grpB: string;
  jobs: { both: string; onlyB: string; noTargets: string };
  policies: Record<'org' | 'siteAB' | 'siteB' | 'dev' | 'devB' | 'grp' | 'grpB', string>;
}

async function seed(): Promise<Fixture> {
  const app = buildApp();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = (await createSite({ orgId: org.id, name: 'Site A' })).id;
  const siteB = (await createSite({ orgId: org.id, name: 'Site B' })).id;

  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);

  const restrictedUser = await createUser({ partnerId: partner.id, orgId: org.id, email: `r-${randomUUID()}@example.com` });
  await assignUserToOrganization(restrictedUser.id, org.id, role.id);
  await getTestDb().execute(sql`
    UPDATE organization_users SET site_ids = ARRAY[${siteA}]::uuid[]
    WHERE user_id = ${restrictedUser.id} AND org_id = ${org.id}
  `);

  const openUser = await createUser({ partnerId: partner.id, orgId: org.id, email: `u-${randomUUID()}@example.com` });
  await assignUserToOrganization(openUser.id, org.id, role.id);

  const devA = randomUUID();
  const devB = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version) VALUES
      (${devA}, ${org.id}, ${siteA}, ${`agent-${randomUUID()}`}, 'host-a', 'windows', '11', 'amd64', '2.0.0'),
      (${devB}, ${org.id}, ${siteB}, ${`agent-${randomUUID()}`}, 'host-b', 'windows', '11', 'amd64', '2.0.0')
  `);
  const grpA = randomUUID();
  const grpB = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO device_groups (id, org_id, site_id, name) VALUES
      (${grpA}, ${org.id}, ${siteA}, 'Group A'),
      (${grpB}, ${org.id}, ${siteB}, 'Group B')
  `);

  const jobs = { both: randomUUID(), onlyB: randomUUID(), noTargets: randomUUID() };
  await getTestDb().execute(sql`
    INSERT INTO patch_jobs (id, org_id, name, targets, status, devices_total, created_at) VALUES
      (${jobs.both}, ${org.id}, 'both sites', ${JSON.stringify({ deviceIds: [devA, devB], configPolicyName: 'Baseline' })}::jsonb, 'completed', 2, now() - interval '3 minutes'),
      (${jobs.onlyB}, ${org.id}, 'site B only', ${JSON.stringify({ deviceIds: [devB] })}::jsonb, 'completed', 1, now() - interval '2 minutes'),
      (${jobs.noTargets}, ${org.id}, 'no targets', '{}'::jsonb, 'completed', 0, now() - interval '1 minute')
  `);

  const policies = {
    org: randomUUID(), siteAB: randomUUID(), siteB: randomUUID(),
    dev: randomUUID(), devB: randomUUID(), grp: randomUUID(), grpB: randomUUID(),
  };
  const rows: Array<[string, string, string, Record<string, string[]>]> = [
    [policies.org, 'org-wide', 'organization', {}],
    [policies.siteAB, 'sites A+B', 'site', { siteIds: [siteA, siteB] }],
    [policies.siteB, 'site B', 'site', { siteIds: [siteB] }],
    [policies.dev, 'devices A+B', 'device', { deviceIds: [devA, devB] }],
    [policies.devB, 'device B', 'device', { deviceIds: [devB] }],
    [policies.grp, 'groups A+B', 'group', { groupIds: [grpA, grpB] }],
    [policies.grpB, 'group B', 'group', { groupIds: [grpB] }],
  ];
  for (const [id, name, targetType, targetIds] of rows) {
    await getTestDb().execute(sql`
      INSERT INTO peripheral_policies (id, org_id, name, device_class, action, target_type, target_ids)
      VALUES (${id}, ${org.id}, ${name}, 'storage', 'block', ${targetType}, ${JSON.stringify(targetIds)}::jsonb)
    `);
  }

  return {
    restricted: await clientFor(app, { userId: restrictedUser.id, email: restrictedUser.email, roleId: role.id, orgId: org.id, partnerId: partner.id }),
    unrestricted: await clientFor(app, { userId: openUser.id, email: openUser.email, roleId: role.id, orgId: org.id, partnerId: partner.id }),
    siteA, siteB, devA, devB, grpA, grpB, jobs, policies,
  };
}

describe('site-restricted readers: patch jobs and peripheral policies (real Postgres)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seed();
  });

  it('patch jobs list: only jobs touching the reader\'s sites, count matches, targets narrowed', async () => {
    const res = await f.restricted('/patches/jobs');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data.map((j: any) => j.id)).toEqual([f.jobs.both]);
    expect(res.body.data[0].targets).toEqual({ deviceIds: [f.devA], configPolicyName: 'Baseline' });
  });

  it('patch job detail: narrowed targets, 404 when fully hidden', async () => {
    const visible = await f.restricted(`/patches/jobs/${f.jobs.both}`);
    expect(visible.status).toBe(200);
    expect(visible.body.data.targets.deviceIds).toEqual([f.devA]);

    expect((await f.restricted(`/patches/jobs/${f.jobs.onlyB}`)).status).toBe(404);
    expect((await f.restricted(`/patches/jobs/${f.jobs.noTargets}`)).status).toBe(404);
  });

  it('patch jobs: an unrestricted reader sees every job with full targets', async () => {
    const res = await f.unrestricted('/patches/jobs');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(3);
    const both = res.body.data.find((j: any) => j.id === f.jobs.both);
    expect(both.targets.deviceIds).toEqual([f.devA, f.devB]);
    expect((await f.unrestricted(`/patches/jobs/${f.jobs.onlyB}`)).status).toBe(200);
  });

  it('peripheral policies list: visibility, count, pagination and narrowed targets', async () => {
    const res = await f.restricted('/peripherals/policies');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(4);
    const byId = Object.fromEntries(res.body.data.map((p: any) => [p.id, p.targetIds]));
    expect(Object.keys(byId).sort()).toEqual(
      [f.policies.org, f.policies.siteAB, f.policies.dev, f.policies.grp].sort(),
    );
    expect(byId[f.policies.siteAB]).toEqual({ siteIds: [f.siteA] });
    expect(byId[f.policies.dev]).toEqual({ deviceIds: [f.devA] });
    expect(byId[f.policies.grp]).toEqual({ groupIds: [f.grpA] });
    expect(byId[f.policies.org]).toEqual({});

    const page = await f.restricted('/peripherals/policies?limit=2&offset=2');
    expect(page.status).toBe(200);
    expect(page.body.pagination.total).toBe(4);
    expect(page.body.data).toHaveLength(2);
  });

  it('peripheral policy detail: narrowed targets, 404 when fully hidden', async () => {
    const visible = await f.restricted(`/peripherals/policies/${f.policies.dev}`);
    expect(visible.status).toBe(200);
    expect(visible.body.data.targetIds).toEqual({ deviceIds: [f.devA] });
    expect((await f.restricted(`/peripherals/policies/${f.policies.org}`)).status).toBe(200);

    for (const hidden of [f.policies.siteB, f.policies.devB, f.policies.grpB]) {
      expect((await f.restricted(`/peripherals/policies/${hidden}`)).status).toBe(404);
    }
  });

  it('peripheral policies: an unrestricted reader sees every policy unchanged', async () => {
    const res = await f.unrestricted('/peripherals/policies');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(7);
    const byId = Object.fromEntries(res.body.data.map((p: any) => [p.id, p.targetIds]));
    expect(byId[f.policies.siteAB]).toEqual({ siteIds: [f.siteA, f.siteB] });
    expect(byId[f.policies.grpB]).toEqual({ groupIds: [f.grpB] });
    expect((await f.unrestricted(`/peripherals/policies/${f.policies.siteB}`)).status).toBe(200);
  });
});
