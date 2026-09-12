/**
 * Real-database boundary test for the platform extension on/off switch.
 *
 * The extension itself is deliberately fake and is never loaded or executed.
 * Only the global `installed_extensions.enabled` row is exercised, through the
 * production state store running as the unprivileged `breeze_app` role.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AuthContext } from '../../middleware/auth';
import { withSystemDbAccessContext } from '../../db';
import { installedExtensions } from '../../db/schema';
import { createExtensionsAdminRoutes } from '../../routes/extensionsAdmin';
import {
  DrizzleExtensionStateBackend,
  ExtensionStateStore,
} from '../../extensions/stateStore';
import { getAppDb } from './setup';

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
  createAuditLog: vi.fn(),
}));

const extensionName = `mfa-boundary-it-${randomUUID().slice(0, 8)}`;
const registry = {
  get: vi.fn(() => undefined),
  activate: vi.fn(),
  withdraw: vi.fn(),
};

function authContext(args: { platformAdmin: boolean; mfa: boolean }): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: {
      id: randomUUID(),
      email: args.platformAdmin ? 'platform-admin@breeze.test' : 'operator@breeze.test',
      name: 'Synthetic operator',
      isPlatformAdmin: args.platformAdmin,
    },
    token: { mfa: args.mfa },
    scope: args.platformAdmin ? 'system' : 'organization',
    orgId: args.platformAdmin ? null : randomUUID(),
    partnerId: null,
    accessibleOrgIds: args.platformAdmin ? null : [],
  } as unknown as AuthContext;
}

async function readEnabledWithoutSystemScope(): Promise<unknown[]> {
  return getAppDb()
    .select({ enabled: installedExtensions.enabled })
    .from(installedExtensions)
    .where(eq(installedExtensions.name, extensionName));
}

describe('extensions admin MFA boundary with real PostgreSQL', () => {
  const store = new ExtensionStateStore(new DrizzleExtensionStateBackend());

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      const { db } = await import('../../db');
      await db.delete(installedExtensions).where(eq(installedExtensions.name, extensionName));
    });
  });

  it('requires MFA and platform authority before changing global state as breeze_app', async () => {
    await store.upsertObserved({ name: extensionName, configuredVersion: '1.0.0' });
    expect((await store.get(extensionName))?.enabled).toBe(true);

    let auth = authContext({ platformAdmin: true, mfa: false });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
    app.route('/api/v1/admin/extensions', createExtensionsAdminRoutes({
      stateStore: store,
      registry,
      hostDescriptor: {
        apiVersions: ['1'],
        breezeVersion: '1.0.0',
        serverSdkVersion: '1.0.0',
        webSdkVersion: '1.0.0',
        capabilities: [],
        slots: {},
      },
      extensionRoots: () => new Map(),
    }));

    const noMfa = await app.request(
      `/api/v1/admin/extensions/${extensionName}/disable`,
      { method: 'POST' },
    );
    expect(noMfa.status).toBe(403);
    expect(await noMfa.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect((await store.get(extensionName))?.enabled).toBe(true);
    expect(registry.get).not.toHaveBeenCalled();

    auth = authContext({ platformAdmin: false, mfa: true });
    const ordinaryOrg = await app.request(
      `/api/v1/admin/extensions/${extensionName}/disable`,
      { method: 'POST' },
    );
    expect(ordinaryOrg.status).toBe(403);
    expect((await store.get(extensionName))?.enabled).toBe(true);

    auth = authContext({ platformAdmin: true, mfa: true });
    const allowed = await app.request(
      `/api/v1/admin/extensions/${extensionName}/disable`,
      { method: 'POST' },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ name: extensionName, enabled: false });
    expect((await store.get(extensionName))?.enabled).toBe(false);

    // The production store's successful access is not a superuser shortcut:
    // the same global row remains invisible on a contextless breeze_app read.
    expect(await readEnabledWithoutSystemScope()).toEqual([]);
    const role = await getAppDb().execute(sql`
      SELECT current_user AS user_name,
             rolsuper,
             rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `);
    expect(role[0]).toMatchObject({
      user_name: 'breeze_app',
      rolsuper: false,
      rolbypassrls: false,
    });
  });
});
