/** #10919: delivery of isolate and release commands is bound to the rows the isolation service issued.
 * Real Postgres and RLS: the claim runs under the device org's context, as the agent heartbeat does,
 * and reads the episode's server-held command ids. A forged row naming the real episode id and
 * generation is cancelled; the service's own rows are delivered.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext } from '../../db';
import { agentVersions, devices, deviceCommands, deviceNetworkIsolations } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite, deviceAgentId } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';
import type { AuthContext } from '../../middleware/auth';
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../../services/dispatchDeviceCommand', () => ({ dispatchDeviceCommand: dispatch }));
vi.mock('../../services/partnerTrust.commands', async (original) => ({
  ...(await original<typeof import('../../services/partnerTrust.commands')>()),
  assertDeviceExecuteAllowed: async () => undefined, deviceExecuteAllowedForOrg: async () => true,
  createDeviceExecuteBatchGate: () => async () => undefined,
}));
import { queueCommand } from '../../services/commandQueue';
import { claimPendingCommandForDelivery, claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { releaseNetworkIsolation, startNetworkIsolation } from '../../services/networkIsolation/service';
afterAll(() => closeDb());
afterEach(() => { vi.unstubAllEnvs(); dispatch.mockReset(); });

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
  // The service's own enqueue, with the transport stubbed: the row lands in its transaction.
  dispatch.mockImplementation(async ({ deviceId, type, commandId, payload }: { deviceId: string; type: string; commandId: string; payload: Record<string, unknown> }) => {
    await queueCommand(deviceId, type, payload, undefined, { commandId });
    return { ok: true, command: { id: commandId }, delivery: 'queued_offline' };
  });
  const agentId = await deviceAgentId(device.id);
  const claim = () => withDbAccessContext(orgContext(org.id), () => claimPendingCommandsForDevice({ deviceId: device.id, agentId, installIncarnation: 1 }));
  const rows = (ids: string[]) => withDbAccessContext(orgContext(org.id), () => db.select().from(deviceCommands).where(inArray(deviceCommands.id, ids)));
  return { device, org, auth, claim, rows };
}

describe('isolation delivery binding', () => {
  it('delivers the service-issued isolate and release and cancels forged rows naming the same episode', async () => {
    const { device, org, auth, claim, rows } = await fixture();
    const started = await startNetworkIsolation(auth, device.id, { createIncident: { title: 'Containment investigation', severity: 'p2' }, reason: 'Investigation' }, { requestedByKind: 'system' });
    if ('error' in started) throw new Error(`start refused: ${started.error}`);
    const episode = started.episode;
    const [stored] = await withDbAccessContext(orgContext(org.id), () => db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.id, episode.id)));
    expect(stored!.commandId).toBe(started.commandId);

    // Valid episode id and generation, a wider allowlist, but not the episode's own row.
    const forgedIsolate = await queueCommand(device.id, 'execute_containment', {
      actionType: 'network_isolation', incidentId: episode.incidentId, actionId: randomUUID(),
      parameters: { isolationId: episode.id, generation: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), deadManSeconds: 0, remoteRelay: false, allow: [{ kind: 'cidr', cidr: '0.0.0.0/0', scope: 'any', proto: 'any' }] },
    });
    const firstClaim = await claim();
    expect(firstClaim.map((c) => c.id)).toEqual([started.commandId]);
    const [own, forged] = [started.commandId, forgedIsolate.id];
    const afterFirst = new Map((await rows([own, forged])).map((r) => [r.id, r]));
    expect(afterFirst.get(own)!.status).toBe('sent');
    expect(afterFirst.get(forged)!.status).toBe('cancelled');
    expect(afterFirst.get(forged)!.result).toMatchObject({ reason: 'isolation_episode_mismatch', cancelledBy: 'claim_eligibility' });

    const released = await releaseNetworkIsolation(auth, device.id, episode.id, { reason: 'Investigation closed' }, { kind: 'console' });
    if ('error' in released) throw new Error(`release refused: ${released.error}`);
    // A release naming the episode while it is being released is still not the episode's own row.
    const forgedRelease = await queueCommand(device.id, 'release_containment', { isolationId: episode.id, generation: released.episode.generation, reason: 'forged' });
    const secondClaim = await claim();
    expect(secondClaim.map((c) => c.id)).toEqual([released.commandId]);
    const afterSecond = new Map((await rows([released.commandId!, forgedRelease.id])).map((r) => [r.id, r]));
    expect(afterSecond.get(released.commandId!)!.status).toBe('sent');
    expect(afterSecond.get(forgedRelease.id)!.status).toBe('cancelled');
    expect(afterSecond.get(forgedRelease.id)!.result).toMatchObject({ reason: 'isolation_episode_mismatch' });
  });

  it('judges a dev_update download by the release record its checksum names, not its version label', async () => {
    const { device, auth, claim, rows } = await fixture();
    const old = randomUUID().replace(/-/g, '').repeat(2);
    const current = randomUUID().replace(/-/g, '').repeat(2);
    await getTestDb().insert(agentVersions).values([
      { version: '1.0.0', platform: 'windows', architecture: 'amd64', downloadUrl: 'https://updates.example.test/old.bin', checksum: old, component: 'agent' },
      { version: '999.0.0', platform: 'windows', architecture: 'amd64', downloadUrl: 'https://updates.example.test/new.bin', checksum: current, component: 'agent' },
    ]);
    const started = await startNetworkIsolation(auth, device.id, { createIncident: { title: 'Containment investigation', severity: 'p2' }, reason: 'Investigation' }, { requestedByKind: 'system' });
    if ('error' in started) throw new Error(`start refused: ${started.error}`);
    const lying = await queueCommand(device.id, 'dev_update', { version: '999.0.0', downloadUrl: 'https://updates.example.test/old.bin', checksum: old });
    const honest = await queueCommand(device.id, 'dev_update', { version: '1.0.0', downloadUrl: 'https://updates.example.test/new.bin', checksum: current });
    const claimed = (await claim()).map((c) => c.id);
    expect(claimed).toContain(honest.id);
    expect(claimed).not.toContain(lying.id);
    const [refused] = await rows([lying.id]);
    expect(refused!.status).toBe('cancelled');
    expect(refused!.result).toMatchObject({ reason: 'network-isolation-version-floor' });
    await getTestDb().delete(agentVersions).where(inArray(agentVersions.checksum, [old, current]));
  });

  it('applies the same binding on the socket-push claim leg', async () => {
    const { device, auth, rows } = await fixture();
    const started = await startNetworkIsolation(auth, device.id, { createIncident: { title: 'Containment investigation', severity: 'p2' }, reason: 'Investigation' }, { requestedByKind: 'system' });
    if ('error' in started) throw new Error(`start refused: ${started.error}`);
    const forged = await queueCommand(device.id, 'release_containment', { isolationId: started.episode.id, generation: 1, reason: 'forged' });
    expect(await claimPendingCommandForDelivery(forged.id)).toEqual({ status: 'cancelled', id: forged.id, reason: 'isolation_episode_mismatch' });
    expect(await claimPendingCommandForDelivery(started.commandId)).toMatchObject({ status: 'claimed', id: started.commandId });
    const byId = new Map((await rows([forged.id, started.commandId])).map((r) => [r.id, r.status]));
    expect(byId.get(forged.id)).toBe('cancelled');
    expect(byId.get(started.commandId)).toBe('sent');
  });

  it('cancels a forged release of an episode that is still meant to be isolated', async () => {
    const { device, auth, claim, rows } = await fixture();
    const started = await startNetworkIsolation(auth, device.id, { createIncident: { title: 'Containment investigation', severity: 'p2' }, reason: 'Investigation' }, { requestedByKind: 'system' });
    if ('error' in started) throw new Error(`start refused: ${started.error}`);
    const forgedRelease = await queueCommand(device.id, 'release_containment', { isolationId: started.episode.id, generation: 1, reason: 'forged' });
    expect((await claim()).map((c) => c.id)).toEqual([started.commandId]);
    const [row] = await rows([forgedRelease.id]);
    expect(row!.status).toBe('cancelled');
  });
});
