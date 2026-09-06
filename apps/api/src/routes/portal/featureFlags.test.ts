import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PortalVisibilityFlag } from '../../services/portal/portalFlags';

// DB mock: select().from().where().limit() resolves the next queued row set.
// Only one read happens per gate check, so a single `rows` slot (rather than
// a FIFO queue like invoices.test.ts/quotes.test.ts) is enough here; the
// compiled `where` predicate is captured so the org-scoping SQL can be
// asserted directly. Mirrors the portal route Drizzle mock convention.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    where: undefined as unknown,
  },
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((predicate: unknown) => {
    dbState.where = predicate;
    return chain;
  });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbState.rows).then(resolve);
  return { db: chain };
});

import { createPortalFeatureGateStrict } from './featureFlags';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

function createTestApp(flag: PortalVisibilityFlag, withAuth = true) {
  const a = new Hono();
  if (withAuth) {
    a.use('*', async (c, next) => {
      c.set('portalAuth', {
        user: { id: 'pu1', orgId: ORG_ID, email: 'c@example.test', name: 'Cust', contactId: null, receiveNotifications: true, status: 'active' },
        token: 't',
        authMethod: 'bearer',
        timezone: 'UTC',
      });
      await next();
    });
  }
  a.use('/protected', createPortalFeatureGateStrict(flag));
  a.get('/protected', (c) => c.json({ ok: true }));
  return a;
}

describe('createPortalFeatureGateStrict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.where = undefined;
  });

  it.each([
    ['enableDashboard', 'PORTAL_DASHBOARD_DISABLED'],
    ['enableSecurity', 'PORTAL_SECURITY_DISABLED'],
    ['enableBackups', 'PORTAL_BACKUPS_DISABLED'],
    ['enableReports', 'PORTAL_REPORTS_DISABLED'],
    ['enableSupportUsage', 'PORTAL_SUPPORT_USAGE_DISABLED'],
  ] as const)(
    'fails closed for %s',
    async (flag, code) => {
      dbState.rows = [];
      const app = createTestApp(flag);
      const response = await app.request('/protected');

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code });

      const query = new PgDialect().sqlToQuery(dbState.where as SQL);
      expect(query.sql).toContain('"portal_branding"."org_id" = $1');
      expect(query.params).toEqual([ORG_ID]);
    },
  );

  it('continues only when the strict flag is true', async () => {
    dbState.rows = [{ enableSecurity: true }];
    const response = await createTestApp('enableSecurity').request('/protected');

    expect(response.status).toBe(200);
  });

  it.each([
    'enableDashboard',
    'enableSecurity',
    'enableBackups',
    'enableReports',
    'enableSupportUsage',
  ] as const)(
    'rejects an unauthenticated request for %s before the gate runs',
    async (flag) => {
      dbState.rows = [{ [flag]: true }];
      const app = createTestApp(flag, false);
      const response = await app.request('/protected');

      expect(response.status).toBe(401);
      expect(dbState.where).toBeUndefined();
    },
  );
});
