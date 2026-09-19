import './setup';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  deviceCommands,
  devices,
  organizationUsers,
  scriptExecutionBatches,
  scriptExecutions,
  scripts,
} from '../../db/schema';
import { scriptRoutes } from '../../routes/scripts';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/scripts', scriptRoutes);
  return app;
}

function execute(app: Hono, token: string, scriptId: string, deviceIds: string[]): Promise<Response> {
  return Promise.resolve(app.request(`/scripts/${scriptId}/execute`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ deviceIds }),
  }));
}

describe('POST /scripts/:id/execute — real PostgreSQL admission isolation', () => {
  it('returns one oracle-safe result per distinct target and writes only the admitted target', async () => {
    const allowed = await setupTestEnvironment({ scope: 'organization' });
    const deniedSite = await createSite({ orgId: allowed.organization.id, name: 'Restricted Site Name' });
    const foreignPartner = await createPartner({ name: 'Foreign Partner Name' });
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id, name: 'Foreign Org Name' });
    const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'Foreign Site Name' });

    await getTestDb().update(organizationUsers)
      .set({ siteIds: [allowed.site.id] })
      .where(eq(organizationUsers.userId, allowed.user.id));

    const mfaToken = await createAccessToken({
      sub: allowed.user.id,
      email: allowed.user.email,
      roleId: allowed.role.id,
      orgId: allowed.organization.id,
      partnerId: allowed.partner.id,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });

    const [savedScript] = await getTestDb().insert(scripts).values({
      orgId: allowed.organization.id,
      name: 'Admission Script',
      osTypes: ['linux'],
      language: 'bash',
      content: 'true',
    }).returning({ id: scripts.id });
    if (!savedScript) throw new Error('script fixture insert failed');

    const [allowedDevice, siteDeniedDevice, foreignDevice] = await getTestDb().insert(devices).values([{
      orgId: allowed.organization.id,
      siteId: allowed.site.id,
      agentId: `admission-allowed-${randomUUID()}`,
      hostname: 'allowed-hostname',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }, {
      orgId: allowed.organization.id,
      siteId: deniedSite.id,
      agentId: `admission-site-denied-${randomUUID()}`,
      hostname: 'restricted-secret-hostname',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }, {
      orgId: foreignOrg.id,
      siteId: foreignSite.id,
      agentId: `admission-foreign-${randomUUID()}`,
      hostname: 'foreign-secret-hostname',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }]).returning({ id: devices.id });
    if (!allowedDevice || !siteDeniedDevice || !foreignDevice) throw new Error('device fixture insert failed');

    const app = buildApp();
    const response = await execute(app, mfaToken, savedScript.id, [
      allowedDevice.id,
      siteDeniedDevice.id,
      foreignDevice.id,
      allowedDevice.id,
      foreignDevice.id,
    ]);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      status: 'partially_queued',
      targets: [{
        requestedDeviceId: allowedDevice.id,
        admission: 'admitted',
        executionId: expect.any(String),
        commandId: expect.any(String),
        // Device fixtures have no live socket, so admission-time delivery is always queued_offline here (W02, #5133).
        delivery: 'queued_offline',
      }, {
        requestedDeviceId: siteDeniedDevice.id,
        admission: 'denied',
        reasonCode: 'site_access_denied',
      }, {
        requestedDeviceId: foreignDevice.id,
        admission: 'denied',
        reasonCode: 'not_found_or_inaccessible',
      }],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('restricted-secret-hostname');
    expect(serialized).not.toContain('foreign-secret-hostname');
    expect(serialized).not.toContain('Foreign Org Name');
    expect(serialized).not.toContain('Foreign Site Name');

    expect(await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)
      .where(eq(deviceCommands.deviceId, allowedDevice.id))).toHaveLength(1);
    // #5128 — and it rests in `queued`, not `pending`: the spec's
    // "Manual runs whose command was `queued_offline` sit in `queued`" is what
    // makes the web's "Queued — device offline" chip and its Queued history
    // filter describe a reachable state. Asserted against real Postgres
    // because two things can only fail here: `queued` must be a legal
    // `execution_status` enum value (it is, since 0001-baseline), and the
    // follow-up UPDATE has to pass the row's RLS policy under the request's own
    // org-scoped context — a unit test with a mocked db proves neither.
    expect(await getTestDb().select({ id: scriptExecutions.id, status: scriptExecutions.status })
      .from(scriptExecutions).where(eq(scriptExecutions.deviceId, allowedDevice.id)))
      .toEqual([{ id: expect.any(String), status: 'queued' }]);
    expect(await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)
      .where(eq(deviceCommands.deviceId, siteDeniedDevice.id))).toHaveLength(0);
    expect(await getTestDb().select({ id: scriptExecutions.id }).from(scriptExecutions)
      .where(eq(scriptExecutions.deviceId, siteDeniedDevice.id))).toHaveLength(0);
    expect(await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)
      .where(eq(deviceCommands.deviceId, foreignDevice.id))).toHaveLength(0);
    expect(await getTestDb().select({ id: scriptExecutions.id }).from(scriptExecutions)
      .where(eq(scriptExecutions.deviceId, foreignDevice.id))).toHaveLength(0);
    expect(await getTestDb().select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches)
      .where(eq(scriptExecutionBatches.scriptId, savedScript.id))).toHaveLength(0);

    const rejected = await execute(app, mfaToken, savedScript.id, [siteDeniedDevice.id, foreignDevice.id]);
    expect(rejected.status).toBe(201);
    expect(await rejected.json()).toMatchObject({
      status: 'rejected',
      targets: [
        { requestedDeviceId: siteDeniedDevice.id, admission: 'denied', reasonCode: 'site_access_denied' },
        { requestedDeviceId: foreignDevice.id, admission: 'denied', reasonCode: 'not_found_or_inaccessible' },
      ],
    });
    expect(await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)).toHaveLength(1);
    expect(await getTestDb().select({ id: scriptExecutions.id }).from(scriptExecutions)).toHaveLength(1);
    expect(await getTestDb().select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches)).toHaveLength(0);
  });
});
