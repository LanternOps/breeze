/** Postgres proof of the release-token pin (#10102): start writes the key and requirement on the
 * episode and the command, the mint signs with that key, and the CHECK refuses an unusable pin. */
import './setup';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceNetworkIsolations } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { orgContext } from './topology-fixtures';
import type { AuthContext } from '../../middleware/auth';
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../../services/dispatchDeviceCommand', () => ({ dispatchDeviceCommand: dispatch }));
vi.mock('../../services/partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: async () => undefined, deviceExecuteAllowedForOrg: async () => true,
  TrustDeniedError: class extends Error {},
}));
import { getReleaseToken, startNetworkIsolation } from '../../services/networkIsolation/service';
import { RELEASE_TOKEN_DOMAIN, releaseTokenSigner } from '../../services/networkIsolation/releaseToken';
afterAll(() => closeDb());
afterEach(() => { vi.unstubAllEnvs(); dispatch.mockReset(); });
// Arbitrary TEST seed; it protects nothing.
const SEED = Buffer.alloc(32, 0x5c).toString('base64');
async function fixture(capability: number) {
  vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'true');
  vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', '');
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  await withDbAccessContext(orgContext(org.id), async () => {
    await db.update(devices).set({ agentVersion: '999.0.0', networkIsolationVersion: capability, networkIsolationReady: true, osType: 'windows', agentServerUrl: 'https://control.example.test', status: 'online' }).where(eq(devices.id, device.id));
  });
  const auth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id], principal: { kind: 'user_session', id: randomUUID() }, user: { id: randomUUID() }, canAccessOrg: (id: string) => id === org.id, canAccessSite: () => true } as unknown as AuthContext;
  dispatch.mockImplementation(async ({ commandId }: { commandId: string }) => ({ ok: true, command: { id: commandId }, delivery: 'queued_offline' }));
  return { device, org, auth };
}
const input = { createIncident: { title: 'Containment investigation', severity: 'p2' as const }, reason: 'Investigation' };
const episodeOf = async (orgId: string, deviceId: string) => withDbAccessContext(orgContext(orgId), async () =>
  (await db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.deviceId, deviceId)))[0]!);

describe('release-token pin (#10102)', () => {
  it('pins the configured key on the episode and the command, and mints tokens it verifies', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED);
    const { device, org, auth } = await fixture(4);
    const started = await startNetworkIsolation(auth, device.id, input, { requestedByKind: 'system' });
    expect(started).not.toHaveProperty('error');
    const publicKey = releaseTokenSigner()!.publicKey;
    const row = await episodeOf(org.id, device.id);
    expect(row).toMatchObject({ releaseTokenPublicKey: publicKey, releaseTokenRequired: false });
    expect(dispatch.mock.calls[0]![0].payload.parameters).toMatchObject({ releaseTokenPublicKey: publicKey, releaseTokenDeviceId: device.id, requireSignedReleaseToken: false });

    const minted = await withDbAccessContext(orgContext(org.id), () => getReleaseToken(auth, device.id, row.id)) as { token: string; generation: number };
    expect(minted).not.toHaveProperty('error');
    const [payload, sig] = minted.token.split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toMatchObject({ v: 1, iid: row.id, gen: 1, dev: device.id });
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(RELEASE_TOKEN_DOMAIN + payload, 'utf8'), key, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('pins nothing for an agent below capability 4, and refuses to mint', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED);
    const { device, org, auth } = await fixture(3);
    expect(await startNetworkIsolation(auth, device.id, input, { requestedByKind: 'system' })).not.toHaveProperty('error');
    const row = await episodeOf(org.id, device.id);
    expect(row).toMatchObject({ releaseTokenPublicKey: null, releaseTokenRequired: false });
    expect(dispatch.mock.calls[0]![0].payload.parameters).not.toHaveProperty('releaseTokenPublicKey');
    expect(await withDbAccessContext(orgContext(org.id), () => getReleaseToken(auth, device.id, row.id))).toEqual({ error: 'release_token_unavailable' });
  });

  it('the CHECK refuses a requirement without a key and a malformed key', async () => {
    const { device, org, auth } = await fixture(3);
    expect(await startNetworkIsolation(auth, device.id, input, { requestedByKind: 'system' })).not.toHaveProperty('error');
    const row = await episodeOf(org.id, device.id);
    for (const patch of [{ releaseTokenRequired: true }, { releaseTokenPublicKey: 'not-base64' }, { releaseTokenPublicKey: Buffer.alloc(31).toString('base64') }]) {
      await expect(withSystemDbAccessContext(() => db.update(deviceNetworkIsolations).set(patch).where(eq(deviceNetworkIsolations.id, row.id))), JSON.stringify(patch))
        .rejects.toMatchObject({ cause: { constraint_name: 'device_network_isolations_release_token_chk' } });
    }
    await withSystemDbAccessContext(() => db.update(deviceNetworkIsolations).set({ releaseTokenPublicKey: Buffer.alloc(32, 1).toString('base64'), releaseTokenRequired: true }).where(eq(deviceNetworkIsolations.id, row.id)));
  });
});
