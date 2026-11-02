/** CI-only Postgres proof of start atomicity.
 * Guard-flip read: dispatch observes both rows in test 1; dispatch before createEpisode fails it.
 * Replacing the service savepoint with direct work leaves rows after test 2's refused dispatch.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext } from '../../db';
import { devices, deviceCommands, deviceNetworkIsolations, incidentActions, incidents } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { orgContext } from './topology-fixtures';
import type { AuthContext } from '../../middleware/auth';
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../../services/dispatchDeviceCommand', () => ({ dispatchDeviceCommand: dispatch }));
vi.mock('../../services/partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: async () => undefined, deviceExecuteAllowedForOrg: async () => true,
  TrustDeniedError: class extends Error {},
}));
import { queueCommand } from '../../services/commandQueue';
import { decryptCommandForDelivery } from '../../services/sensitiveCommandPayload';
import { decryptSecret } from '../../services/secretCrypto';
import { columnAad } from '../../services/encryptedColumnTransform';
import { ISOLATION_SECRET_COLUMN } from '../../services/networkIsolation/reconcile';
import { startNetworkIsolation } from '../../services/networkIsolation/service';
afterAll(() => closeDb());
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'true');
  vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', '');
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  await withDbAccessContext(orgContext(org.id), async () => {
    await db.update(devices).set({ agentVersion: '999.0.0', networkIsolationVersion: 1, networkIsolationReady: true, osType: 'windows', agentServerUrl: 'https://control.example.test', status: 'online' }).where(eq(devices.id, device.id));
  });
  const auth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id], principal: { kind: 'user_session', id: randomUUID() }, user: { id: randomUUID() }, canAccessOrg: (id: string) => id === org.id, canAccessSite: () => true } as unknown as AuthContext;
  return { device, org, auth };
}
const input = { createIncident: { title: 'Containment investigation', severity: 'p2' as const }, reason: 'Investigation' };
describe('isolation start transaction', () => {
  it('makes the action and episode visible to dispatch in the same transaction', async () => {
    const { device, org, auth } = await fixture();
    dispatch.mockImplementationOnce(async ({ commandId, payload }: { commandId: string; payload: Record<string, unknown> }) => {
      const episodes = await db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.deviceId, device.id));
      const actions = await db.select().from(incidentActions).where(eq(incidentActions.orgId, org.id));
      expect(episodes).toHaveLength(1); expect(actions).toHaveLength(1);
      expect(episodes[0]!.incidentActionId).toBe(actions[0]!.id);
      expect(actions[0]).toMatchObject({ reversible: true, actionType: 'network_isolation', result: { commandId } });
      // Exercise the real INSERT boundary: bypassing the service's sealing causes
      // the enc: assertion to fail; corrupt delivery AAD fails the plaintext equality.
      await queueCommand(device.id, 'execute_containment', payload, undefined, { commandId });
      const [command] = await db.select().from(deviceCommands).where(eq(deviceCommands.id, commandId));
      expect((command!.payload as Record<string, unknown>).breakGlassSecret).toMatch(/^enc:/);
      const plaintext = decryptSecret(episodes[0]!.breakGlassSecretEnc, { aad: columnAad(ISOLATION_SECRET_COLUMN, episodes[0]!.id), strict: true });
      const delivered = decryptCommandForDelivery(command!);
      expect((delivered?.payload as Record<string, unknown>)?.breakGlassSecret).toBe(plaintext);
      return { ok: true, command: { id: commandId }, delivery: 'queued_offline' };
    });
    expect(await startNetworkIsolation(auth, device.id, input, { requestedByKind: 'system' })).not.toHaveProperty('error');
  });
  it('rolls the incident, action and episode back when enqueue refuses', async () => {
    const { device, org, auth } = await fixture();
    dispatch.mockResolvedValueOnce({ ok: false, code: 'device_pending_assignment' });
    // Model the HTTP request's already-open transaction. The service must roll back its own
    // savepoint before returning a refusal; catching it inside this outer context still commits.
    await withDbAccessContext(orgContext(org.id), async () => {
      expect(await startNetworkIsolation(auth, device.id, input, { requestedByKind: 'system' })).toEqual({ error: 'device_pending_assignment' });
      expect(await db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.deviceId, device.id))).toHaveLength(0);
      expect(await db.select().from(incidentActions).where(eq(incidentActions.orgId, org.id))).toHaveLength(0);
      expect(await db.select().from(incidents).where(eq(incidents.orgId, org.id))).toHaveLength(0);
    });
  });
});
