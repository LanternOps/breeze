import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import './setup';
import { getTestDb } from './setup';
import {
  createOrganization,
  createSite,
  setupTestEnvironment,
  type TestEnvironment
} from './db-utils';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { securityRoutes } from '../../routes/security';
import { devices, devicePatches, patches, securityStatus } from '../../db/schema';

// Regression coverage for PR #973 — server-side orgId narrowing on the
// /patches and /security/* routes. Asserts real data isolation against a
// live test DB (not mocked): a partner-scope caller narrowing to one of its
// own orgs sees only that org's rows, and a caller asking for an org it
// cannot access is denied (403 for patches, empty set for security).
//
// /security/firewall is one of the four compliance routes this PR actually
// repaired (their query schema stripped orgId and their handler dropped the
// second listStatusRows arg). /security/status was never broken; it is
// asserted too, but firewall is the route that locks the fix against the
// exact regression that reopens the hole — a refactor dropping orgId from a
// compliance schema or call site.

function buildApp(): Hono {
  const app = new Hono();
  app.use(authMiddleware);
  app.route('/patches', patchRoutes);
  app.route('/security', securityRoutes);
  return app;
}

async function seedDevice(orgId: string, siteId: string, agentId: string, hostname: string) {
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '0.66.1',
      status: 'online'
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: insert returned no row');
  return row.id;
}

async function seedPatch(externalId: string, title: string) {
  const [row] = await getTestDb()
    .insert(patches)
    .values({ source: 'microsoft', externalId, title, requiresReboot: false })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: insert returned no row');
  return row.id;
}

describe('org-scope narrowing (PR #973) — /patches and /security', () => {
  // `patches` is a global catalog (no tenant FK) so cleanupDatabase does not
  // truncate it between tests or across runs; random external_ids keep each
  // seeded patch unique regardless of leftover catalog rows.
  let app: Hono;
  let partnerEnv: TestEnvironment; // partner P1, owns orgA (partnerEnv.organization)
  let orgAId: string;
  let orgBId: string;
  let foreignOrgId: string; // belongs to a different partner — P1 cannot access it
  let token: string;
  let patchA: string;
  let patchB: string;
  let deviceAId: string;
  let deviceBId: string;

  beforeEach(async () => {
    // Partner P1 with org A + a partner-scope user/token that can access all of P1's orgs.
    partnerEnv = await setupTestEnvironment({ scope: 'partner' });
    token = partnerEnv.token;
    orgAId = partnerEnv.organization.id;

    // Second org B under the SAME partner P1.
    const orgB = await createOrganization({ partnerId: partnerEnv.partner.id });
    orgBId = orgB.id;
    const siteB = await createSite({ orgId: orgBId });
    const siteA = await createSite({ orgId: orgAId });

    // A foreign org under a DIFFERENT partner — P1's token must not reach it.
    const foreignEnv = await setupTestEnvironment({ scope: 'partner' });
    foreignOrgId = foreignEnv.organization.id;

    // Devices: one in A, one in B, one in the foreign org.
    const deviceA = await seedDevice(orgAId, siteA.id, 'agent-a', 'dev-a');
    const deviceB = await seedDevice(orgBId, siteB.id, 'agent-b', 'dev-b');
    deviceAId = deviceA;
    deviceBId = deviceB;
    const deviceForeign = await seedDevice(
      foreignOrgId,
      foreignEnv.site.id,
      'agent-f',
      'dev-f'
    );

    // Distinct patches present on A's device vs B's device.
    patchA = await seedPatch(`KB-A-${randomUUID()}`, 'Patch only on org A device');
    patchB = await seedPatch(`KB-B-${randomUUID()}`, 'Patch only on org B device');
    await getTestDb()
      .insert(devicePatches)
      .values([
        { deviceId: deviceA, orgId: orgAId, patchId: patchA, status: 'missing' },
        { deviceId: deviceB, orgId: orgBId, patchId: patchB, status: 'missing' }
      ]);

    // Security status rows for every device.
    await getTestDb()
      .insert(securityStatus)
      .values([
        { deviceId: deviceA, orgId: orgAId, provider: 'windows_defender' },
        { deviceId: deviceB, orgId: orgBId, provider: 'windows_defender' },
        { deviceId: deviceForeign, orgId: foreignOrgId, provider: 'windows_defender' }
      ]);

    app = buildApp();
  });

  const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

  // ── Test 1: narrowing returns a strict subset ──────────────────────────────
  it('patches: ?orgId=A returns only patches present on org A devices', async () => {
    const res = await app.request(`/patches?orgId=${orgAId}`, auth());
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((p: { id: string }) => p.id);
    expect(ids).toContain(patchA);
    expect(ids).not.toContain(patchB); // org B's patch is excluded
  });

  it('security/status: ?orgId=A returns only org A device statuses', async () => {
    const res = await app.request(`/security/status?orgId=${orgAId}`, auth());
    expect(res.status).toBe(200);
    const orgIds = (await res.json()).data.map((s: { orgId: string }) => s.orgId);
    expect(orgIds.length).toBeGreaterThan(0);
    expect(new Set(orgIds)).toEqual(new Set([orgAId])); // nothing from B or foreign
  });

  // ── Test 2: IDOR pin — a foreign org the caller cannot access ──────────────
  it('patches: ?orgId=<foreign> is rejected with 403', async () => {
    const res = await app.request(`/patches?orgId=${foreignOrgId}`, auth());
    expect(res.status).toBe(403);
  });

  it('security/status: ?orgId=<foreign> returns an empty set (200)', async () => {
    const res = await app.request(`/security/status?orgId=${foreignOrgId}`, auth());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  // ── The fix's real target: a repaired compliance route (/security/firewall).
  // Locks both the schema (orgId must survive validation) and the call site
  // (handler must forward query.orgId to listStatusRows).
  it('security/firewall (repaired route): ?orgId=A narrows to org A devices, excluding B', async () => {
    const res = await app.request(`/security/firewall?orgId=${orgAId}`, auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    const deviceIds = body.data.map((d: { deviceId: string }) => d.deviceId);
    expect(deviceIds).toContain(deviceAId);
    expect(deviceIds).not.toContain(deviceBId); // org B's device is excluded
    expect(body.summary.total).toBe(1); // only A's single device is in scope
  });

  it('security/firewall (repaired route): ?orgId=<foreign> returns empty (200) — IDOR pin', async () => {
    const res = await app.request(`/security/firewall?orgId=${foreignOrgId}`, auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.summary.total).toBe(0);
  });

  // ── Test 3: the patches device-join filter actually excludes the other org ─
  it('patches: ?orgId=B returns B-only patches, excluding A', async () => {
    const res = await app.request(`/patches?orgId=${orgBId}`, auth());
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((p: { id: string }) => p.id);
    expect(ids).toContain(patchB);
    expect(ids).not.toContain(patchA);
  });
});
