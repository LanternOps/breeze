/**
 * Real-Postgres boundary checks for live remote-session continuation.
 * Code under test uses the production breeze_app pool and its explicit system
 * context; fixtures are synthetic and are created through the test superuser.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { devices, organizations, partners, tunnelSessions } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { authorizeRemoteSessionContinuation } from '../../services/remoteWsAuthorization';

async function createTunnelFixture(rolePermissions: Array<{ resource: string; action: string }>) {
  const env = await setupTestEnvironment({ scope: 'organization', rolePermissions });
  const [device] = await getTestDb().insert(devices).values({
    orgId: env.organization.id,
    siteId: env.site.id,
    agentId: `continuation-${randomUUID()}`,
    hostname: `continuation-${randomUUID()}`,
    osType: 'linux',
    osVersion: 'test',
    osBuild: 'test',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  if (!device) throw new Error('device fixture was not created');

  const [session] = await getTestDb().insert(tunnelSessions).values({
    orgId: env.organization.id,
    deviceId: device.id,
    userId: env.user.id,
    type: 'proxy',
    status: 'active',
    targetHost: '192.0.2.10',
    targetPort: 443,
  }).returning({ id: tunnelSessions.id });
  if (!session) throw new Error('tunnel fixture was not created');

  return { env, sessionId: session.id };
}

const required = [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE];

describe('live tunnel continuation authorization', () => {
  it('allows the positive control with an active tenant, membership, site, and both grants', async () => {
    const fixture = await createTunnelFixture(required);

    await expect(authorizeRemoteSessionContinuation({
      sessionId: fixture.sessionId,
      sessionType: 'tunnel',
      userId: fixture.env.user.id,
    }, required)).resolves.toMatchObject({ ok: true });
  });

  it('denies through the real permission join when DEVICES_EXECUTE is absent', async () => {
    const fixture = await createTunnelFixture([PERMISSIONS.REMOTE_ACCESS]);

    await expect(authorizeRemoteSessionContinuation({
      sessionId: fixture.sessionId,
      sessionType: 'tunnel',
      userId: fixture.env.user.id,
    }, required)).resolves.toEqual({
      ok: false,
      status: 403,
      reason: 'permission_denied',
    });
  });

  it('denies an existing session after the organization becomes inactive', async () => {
    const fixture = await createTunnelFixture(required);
    await getTestDb().update(organizations)
      .set({ status: 'suspended' })
      .where(eq(organizations.id, fixture.env.organization.id));

    await expect(authorizeRemoteSessionContinuation({
      sessionId: fixture.sessionId,
      sessionType: 'tunnel',
      userId: fixture.env.user.id,
    }, required)).resolves.toEqual({
      ok: false,
      status: 403,
      reason: 'session_not_owned',
    });
  });

  it.each([
    ['suspended', { status: 'suspended' as const }],
    ['soft-deleted', { deletedAt: new Date('2026-09-07T00:00:00.000Z') }],
  ])('denies an existing session after its owning partner becomes %s', async (_case, update) => {
    const fixture = await createTunnelFixture(required);

    // Positive control proves the same durable session is usable immediately
    // before the owning-partner lifecycle transition.
    await expect(authorizeRemoteSessionContinuation({
      sessionId: fixture.sessionId,
      sessionType: 'tunnel',
      userId: fixture.env.user.id,
    }, required)).resolves.toMatchObject({ ok: true });

    await getTestDb().update(partners)
      .set(update)
      .where(eq(partners.id, fixture.env.partner.id));

    await expect(authorizeRemoteSessionContinuation({
      sessionId: fixture.sessionId,
      sessionType: 'tunnel',
      userId: fixture.env.user.id,
    }, required)).resolves.toEqual({
      ok: false,
      status: 403,
      reason: 'session_not_owned',
    });
  });
});
