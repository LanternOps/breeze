import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { users } from '../../db/schema';
import { vulnerabilityRoutes, vulnerabilitySyncRoutes } from '../../routes/vulnerabilities';
import { createAccessToken } from '../../services/jwt';
import { getTestDb } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  // Deeper mount first so /sync is isolated from the org-read middleware on the
  // main router (verified: same-prefix double-mount leaks `.use('*')` both ways).
  app.route('/api/v1/vulnerabilities/sync', vulnerabilitySyncRoutes);
  app.route('/api/v1/vulnerabilities', vulnerabilityRoutes);
  return app;
}

async function adminHeaders(env: TestEnvironment): Promise<Record<string, string>> {
  await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, env.user.id));
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
  });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function memberHeaders(env: TestEnvironment): Record<string, string> {
  return { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' };
}

describe('POST /api/v1/vulnerabilities/sync', () => {
  runDb('enqueues a sync job for a platform admin', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const res = await buildApp().request('/api/v1/vulnerabilities/sync', {
      method: 'POST',
      headers: await adminHeaders(env),
      body: JSON.stringify({ source: 'nvd' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { enqueued: boolean; jobId?: string };
    expect(body.enqueued).toBe(true);
    expect(body.jobId).toBeTruthy();
  });

  runDb('forbids a non-admin', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const res = await buildApp().request('/api/v1/vulnerabilities/sync', {
      method: 'POST',
      headers: memberHeaders(env),
      body: JSON.stringify({ source: 'nvd' }),
    });
    expect(res.status).toBe(403);
  });

  runDb('rejects an unknown source', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const res = await buildApp().request('/api/v1/vulnerabilities/sync', {
      method: 'POST',
      headers: await adminHeaders(env),
      body: JSON.stringify({ source: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});
