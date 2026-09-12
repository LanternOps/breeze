/** Real-PostgreSQL proof for partner-global accounting admission. */
import './setup';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { accountingConnections, partnerUsers } from '../../db/schema';
import { accountingRoutes } from '../../routes/accounting';
import { clearPermissionCache } from '../../services/permissions';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const result = new Hono();
  result.route('/accounting', accountingRoutes);
  return result;
}

describe('accounting partner authority (real PostgreSQL as breeze_app)', () => {
  runDb('allows all access and denies selected/none before the partner-axis read', async () => {
    const client = await createIntegrationTestClient(app(), { scope: 'partner' });
    await getTestDb().insert(accountingConnections).values({
      partnerId: client.env.partner.id,
      provider: 'quickbooks',
      environment: 'sandbox',
      status: 'connected',
      pushMode: 'manual',
    });

    const allowed = await client.get('/accounting/quickbooks');
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      status: 'connected',
      environment: 'sandbox',
      pushMode: 'manual',
    });

    for (const orgAccess of ['selected', 'none'] as const) {
      await getTestDb()
        .update(partnerUsers)
        .set({
          orgAccess,
          orgIds: orgAccess === 'selected' ? [client.env.organization.id] : null,
        })
        .where(eq(partnerUsers.userId, client.env.user.id));
      await clearPermissionCache(client.env.user.id);

      const denied = await client.get('/accounting/quickbooks');
      expect(denied.status, orgAccess).toBe(403);
      await expect(denied.json()).resolves.toEqual({
        error: 'Full partner organization access is required',
      });
    }

    await getTestDb()
      .update(partnerUsers)
      .set({ orgAccess: 'all', orgIds: null })
      .where(eq(partnerUsers.userId, client.env.user.id));
    await clearPermissionCache(client.env.user.id);
    expect((await client.get('/accounting/quickbooks')).status).toBe(200);
  });
});
