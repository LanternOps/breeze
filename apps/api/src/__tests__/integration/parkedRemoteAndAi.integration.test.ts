/**
 * Remote access, launcher issuance and AI device access for a device parked in
 * a holding org, against real Postgres.
 *
 * With zero policy rows every remote capability defaults to enabled; the
 * canonical remote-access check must still deny a parked device. The AI
 * device verifier must not resolve it even for a system-scope session, and
 * the external launcher must refuse it before any provider settings are read.
 * A customer-org device with the same (empty) policy state is the control:
 * it passes every check, so a denial for the parked device is not vacuous.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/parkedRemoteAndAi.integration.test.ts
 */
import './setup';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { checkRemoteAccess, invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import { verifyDeviceAccess } from '../../services/aiTools';
import { aiQueueCommand } from '../../services/aiDispatch';
import { ParkedDeviceCommandRefusedError } from '../../services/unassignedPool/deliveryEligibility';
import {
  RemoteAccessLaunchParkedDeviceError,
  resolveRemoteAccessLauncherForDevice,
} from '../../routes/devices/core';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { insertDevice, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

const CAPABILITIES = ['webrtcDesktop', 'vncRelay', 'remoteTools', 'proxy'] as const;

function systemAuth(): AuthContext {
  return {
    principal: { kind: 'system', reason: 'parked-remote-and-ai-test' },
    user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
    token: {} as never,
    partnerId: null,
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'parked-remote-and-ai' },
  } as unknown as AuthContext;
}

describe('remote access and AI device access for a parked device (real Postgres)', () => {
  let parked: { id: string };
  let parkedOrgId: string;
  let control: { id: string };
  let controlOrgId: string;

  beforeEach(async () => {
    invalidateRemoteAccessCache();
    const partner = await createPartner();
    const pool = await seedHoldingOrg(partner.id);
    parked = await seedParkedDevice(pool.orgId, pool.siteId);
    parkedOrgId = pool.orgId;
    const customer = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: customer.id });
    control = await insertDevice(customer.id, site.id);
    controlOrgId = customer.id;
    for (const id of [parked.id, control.id]) {
      await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, id));
    }
  });

  it('checkRemoteAccess denies every capability for the parked device with zero policy rows', async () => {
    for (const capability of CAPABILITIES) {
      for (const bypassCache of [false, true]) {
        const result = await withSystemDbAccessContext(() =>
          checkRemoteAccess(parked.id, capability, { bypassCache }));
        expect(result, `${capability} bypassCache=${bypassCache}`).toMatchObject({
          allowed: false,
          code: 'DEVICE_PENDING_ASSIGNMENT',
        });
      }
    }
  });

  it('control: the customer device with zero policy rows is allowed every capability', async () => {
    for (const capability of CAPABILITIES) {
      const result = await withSystemDbAccessContext(() => checkRemoteAccess(control.id, capability));
      expect(result, capability).toEqual({ allowed: true });
    }
  });

  it('verifyDeviceAccess does not resolve the parked device, even for a system-scope session', async () => {
    const denied = await withSystemDbAccessContext(() => verifyDeviceAccess(parked.id, systemAuth()));
    expect(denied).toEqual({ error: 'Device not found or access denied' });

    const allowed = await withSystemDbAccessContext(() => verifyDeviceAccess(control.id, systemAuth()));
    expect('device' in allowed && allowed.device.id).toBe(control.id);
  });

  it('launcher issuance refuses the parked device before reading any provider settings', async () => {
    await expect(withSystemDbAccessContext(() =>
      resolveRemoteAccessLauncherForDevice(parked.id, parkedOrgId, {}, systemAuth()),
    )).rejects.toBeInstanceOf(RemoteAccessLaunchParkedDeviceError);

    const controlResult = await withSystemDbAccessContext(() =>
      resolveRemoteAccessLauncherForDevice(control.id, controlOrgId, {}, systemAuth()),
    );
    expect(controlResult.launchUrl).toBeNull();
    expect(controlResult.skipReason).toBe('no_provider_configured');
  });

  it('the AI queue wrapper refuses a command for the parked device and writes no row', async () => {
    await expect(withSystemDbAccessContext(() =>
      aiQueueCommand(systemAuth(), 'parked_test_tool', parked.id, 'script', { scriptId: 'noop', content: 'echo' }),
    )).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
  });
});
