/**
 * Public device responses against real PostgreSQL and the real JWT/auth/RLS
 * stack. The fixture deliberately fills every credential family: a passing
 * test must prove the response projection, not merely rely on null columns.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { devices } from '../../db/schema';
import { coreRoutes } from '../../routes/devices/core';
import { createAccessToken } from '../../services/jwt';

const FORBIDDEN = [
  'agentId',
  'agentTokenHash', 'tokenIssuedAt', 'previousTokenHash', 'previousTokenExpiresAt',
  'watchdogTokenHash', 'watchdogTokenIssuedAt', 'previousWatchdogTokenHash',
  'previousWatchdogTokenExpiresAt', 'helperTokenHash', 'helperTokenIssuedAt',
  'previousHelperTokenHash', 'previousHelperTokenExpiresAt',
  'pendingTokenHash', 'pendingWatchdogTokenHash', 'pendingHelperTokenHash',
  'pendingTokenExpiresAt', 'mtlsCertSerialNumber', 'mtlsCertExpiresAt',
  'mtlsCertIssuedAt', 'mtlsCertCfId', 'agentTokenSuspendedAt',
  'agentTokenSuspendedReason',
] as const;

function expectPublicDevice(value: unknown): void {
  expect(value).toMatchObject({ hostname: expect.any(String), orgId: expect.any(String) });
  for (const field of FORBIDDEN) expect(value).not.toHaveProperty(field);
}

describe('device public response projection (real bearer + breeze_app PostgreSQL)', () => {
  it('projects both detail and mutation responses while retaining internal verifier state', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const suffix = randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + 60_000);
    const verifier = (character: string) => character.repeat(64);
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `public-projection-${suffix}`,
      hostname: `projection-${suffix}`,
      osType: 'linux', osVersion: 'test', architecture: 'x86_64', agentVersion: 'test',
      status: 'online',
      agentTokenHash: verifier('a'), tokenIssuedAt: now,
      previousTokenHash: verifier('b'), previousTokenExpiresAt: expires,
      watchdogTokenHash: verifier('c'), watchdogTokenIssuedAt: now,
      previousWatchdogTokenHash: verifier('d'), previousWatchdogTokenExpiresAt: expires,
      helperTokenHash: verifier('e'), helperTokenIssuedAt: now,
      previousHelperTokenHash: verifier('f'), previousHelperTokenExpiresAt: expires,
      pendingTokenHash: verifier('1'), pendingWatchdogTokenHash: verifier('2'),
      pendingHelperTokenHash: verifier('3'), pendingTokenExpiresAt: expires,
      mtlsCertSerialNumber: 'internal-serial', mtlsCertCfId: 'internal-cert-id',
      mtlsCertIssuedAt: now, mtlsCertExpiresAt: expires,
      agentTokenSuspendedAt: now, agentTokenSuspendedReason: 'internal-reason',
    }).returning();
    if (!device) throw new Error('device fixture insert returned no row');

    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id,
      orgId: env.organization.id, partnerId: env.partner.id, scope: 'organization',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/devices', coreRoutes);
    const headers = { Authorization: `Bearer ${token}` };

    const detailResponse = await app.request(`/devices/${device.id}`, { headers });
    expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
    expectPublicDevice(await detailResponse.json());

    const updateResponse = await app.request(`/devices/${device.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Projected update' }),
    });
    expect(updateResponse.status, await updateResponse.clone().text()).toBe(200);
    expectPublicDevice(await updateResponse.json());

    const [stored] = await getTestDb().select().from(devices).where(eq(devices.id, device.id));
    expect(stored).toMatchObject({
      agentTokenHash: verifier('a'), pendingTokenHash: verifier('1'),
      pendingWatchdogTokenHash: verifier('2'), pendingHelperTokenHash: verifier('3'),
      mtlsCertCfId: 'internal-cert-id', agentTokenSuspendedReason: 'internal-reason',
      displayName: 'Projected update',
    });
  });
});
