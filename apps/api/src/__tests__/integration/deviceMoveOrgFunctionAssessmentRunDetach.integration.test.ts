/**
 * Live-Postgres coverage: a device org-move must not abort when the device
 * carries a `device_function_assessments` row with a `run_id`.
 *
 * WHY THIS NEEDS A REAL DATABASE
 * ------------------------------
 * `device_function_assessments` IS a member of `getDeviceOrgDenormalizedTables()`
 * / `breeze_device_child_orgid_tables()`, so a device org-move re-stamps its
 * `org_id` to the destination org unconditionally. `device_function_assessments_run_org_fk`
 * ((run_id, org_id) -> ai_agent_runs(id, org_id)) is DEFERRABLE INITIALLY
 * IMMEDIATE — checked at the end of EACH statement — and `ai_agent_runs`
 * deliberately does NOT follow the device (design decision 2026-08-23), so once
 * the org_id re-stamp lands, the composite pair no longer resolves and the
 * re-stamp statement itself raises 23503, aborting the whole move. Only a real
 * FK enforcement engine can prove this; a mocked suite can only assert the SQL
 * text is present (moveOrg.coverage.test.ts does that, statically).
 *
 * TWO CALLERS, both asserted, mirroring
 * deviceMoveOrgVulnerabilityTicketDetach.integration.test.ts:
 *
 *   - `POST /devices/:id/move-org` (the route's own statement).
 *   - a raw `UPDATE devices SET org_id` under `withSystemDbAccessContext` as
 *     the unprivileged `breeze_app` role — proves
 *     `breeze_cascade_device_org_id()`'s mirrored statement.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, deviceFunctionAssessments, devices } from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed() {
  const adminDb = getTestDb();
  const sfx = uid();

  const { partner, organization: sourceOrg, site: sourceSite, user, role } = await setupTestEnvironment({
    scope: 'partner',
  });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });

  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `fn-assess-agent-${sfx}`,
      hostname: `fn-assess-host-${sfx}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });

  const [agent] = await adminDb
    .insert(aiAgents)
    .values({ orgId: sourceOrg.id, partnerId: null, kind: 'triage', name: `Fleet Designer ${sfx}`, createdBy: user.id })
    .returning({ id: aiAgents.id });

  const [run] = await adminDb
    .insert(aiAgentRuns)
    .values({
      agentId: agent!.id,
      orgId: sourceOrg.id,
      triggerKind: 'alert',
      dedupeKey: `fn-assess-run-${sfx}`,
      modeAtStart: 'shadow',
      policySnapshot: { schemaVersion: 1 } as never,
    })
    .returning({ id: aiAgentRuns.id });

  const [assessment] = await adminDb
    .insert(deviceFunctionAssessments)
    .values({
      orgId: sourceOrg.id,
      deviceId: device!.id,
      functionKey: 'domain_controller',
      source: 'ai',
      confidence: '0.90',
      runId: run!.id,
    })
    .returning({ id: deviceFunctionAssessments.id });

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });

  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  const post = async () =>
    app.request(`/devices/${device!.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        await withMoveOrgStepUpGrant(token, device!.id, { orgId: targetOrg.id, siteId: targetSite.id }),
      ),
    });

  return {
    deviceId: device!.id,
    assessmentId: assessment!.id,
    runId: run!.id,
    sourceOrgId: sourceOrg.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    post,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function readAssessment(id: string) {
  const [row] = await getTestDb()
    .select({ orgId: deviceFunctionAssessments.orgId, runId: deviceFunctionAssessments.runId })
    .from(deviceFunctionAssessments)
    .where(eq(deviceFunctionAssessments.id, id));
  return row;
}

async function assertOutcome(f: Fixture) {
  const [d] = await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, f.deviceId));
  expect(d?.orgId).toBe(f.targetOrgId);

  const assessment = await readAssessment(f.assessmentId);
  expect(assessment?.orgId, 'the assessment travels with its device').toBe(f.targetOrgId);
  expect(assessment?.runId, 'the source-org run pointer must be severed, not carried cross-tenant').toBeNull();
}

describe('POST /devices/:id/move-org — device_function_assessments.run_id detach (#3828-class)', () => {
  it('moves a device whose function assessment carries a run_id, without a 23503, and detaches the pointer', async () => {
    const f: Fixture = await seed();

    expect((await readAssessment(f.assessmentId))?.runId).toBe(f.runId);

    const res = await f.post();
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.success).toBe(true);

    await assertOutcome(f);
  });
});

describe('breeze_cascade_device_org_id(): device_function_assessments.run_id detach', () => {
  it('a raw UPDATE devices under the unprivileged breeze_app role (system context) detaches the stale run pointer', async () => {
    const f: Fixture = await seed();

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
         WHERE id = ${f.deviceId}::uuid
      `);
    });

    await assertOutcome(f);
  });

  it('a raw superuser UPDATE devices SET org_id also detaches the stale run pointer', async () => {
    const f: Fixture = await seed();

    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
       WHERE id = ${f.deviceId}::uuid
    `);

    await assertOutcome(f);
  });
});
