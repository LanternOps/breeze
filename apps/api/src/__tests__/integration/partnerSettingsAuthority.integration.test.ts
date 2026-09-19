/**
 * Partner-global settings authority — real PostgreSQL request-role coverage.
 *
 * Partner-axis RLS intentionally allows a partner member to reach their
 * partner row, so the application-level full-partner capability is the
 * load-bearing boundary for this mutation. These controls exercise the real
 * route through the `breeze_app` request pool: selected/none memberships must
 * be denied, while an all-access member may update and restore the setting.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { partners, partnerUsers, users } from '../../db/schema';
import { orgRoutes } from '../../routes/orgs';
import { createAccessToken } from '../../services/jwt';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/orgs', orgRoutes);
  return app;
}

describe('PATCH /orgs/partners/me partner-global authority', () => {
  runDb('denies selected/none members and allows an all-access update and restore', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const database = getTestDb();
    await database
      .update(partners)
      .set({ settings: { security: { requireMfa: true, maxSessions: 4 } } })
      .where(eq(partners.id, env.partner.id));
    await database
      .update(users)
      .set({ mfaEnabled: true, mfaMethod: 'totp' })
      .where(eq(users.id, env.user.id));

    const token = await createAccessToken({
      sub: env.user.id,
      email: env.user.email,
      roleId: env.role.id,
      orgId: null,
      partnerId: env.partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });
    const patch = (requireMfa: boolean) => buildApp().request('/orgs/partners/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ settings: { security: { requireMfa } } }),
    });
    const readRequireMfa = async (): Promise<boolean | undefined> => {
      const [row] = await database
        .select({ settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, env.partner.id))
        .limit(1);
      return (row?.settings as { security?: { requireMfa?: boolean } } | null)?.security?.requireMfa;
    };
    const setOrgAccess = async (orgAccess: 'all' | 'selected' | 'none') => {
      await database
        .update(partnerUsers)
        .set({
          orgAccess,
          orgIds: orgAccess === 'selected' ? [env.organization.id] : null,
        })
        .where(and(
          eq(partnerUsers.userId, env.user.id),
          eq(partnerUsers.partnerId, env.partner.id),
        ));
    };

    await setOrgAccess('selected');
    expect((await patch(false)).status).toBe(403);
    expect(await readRequireMfa()).toBe(true);

    await setOrgAccess('none');
    expect((await patch(false)).status).toBe(403);
    expect(await readRequireMfa()).toBe(true);

    await setOrgAccess('all');
    const allowed = await patch(false);
    expect(allowed.status).toBe(200);
    expect(await readRequireMfa()).toBe(false);

    const restored = await patch(true);
    expect(restored.status).toBe(200);
    expect(await readRequireMfa()).toBe(true);
  });
});
