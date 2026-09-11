/**
 * Real-PostgreSQL proof for cross-user AI admin reads.
 *
 * The route runs in the same request-scoped `breeze_app` context as production:
 * the dedicated permission denies an ordinary organization reader before SQL,
 * an authorized reader receives a redacted same-org transcript, and forced RLS
 * keeps a foreign session opaque even when the application is given its UUID.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

type Permission = { resource: string; action: string };
const authState = vi.hoisted(() => ({
  orgId: '',
  permissions: [] as Permission[],
}));

vi.mock('../../middleware/auth', async () => {
  const { withDbAccessContext } = await import('../../db');
  return {
    authMiddleware: (c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: authState.orgId,
        partnerId: null,
        accessibleOrgIds: [authState.orgId],
        permissions: authState.permissions,
        user: { id: null, email: 'synthetic-reader@example.test' },
        canAccessOrg: (orgId: string) => orgId === authState.orgId,
        orgCondition: () => undefined,
      });
      return withDbAccessContext(
        {
          scope: 'organization',
          orgId: authState.orgId,
          accessibleOrgIds: [authState.orgId],
          accessiblePartnerIds: null,
          userId: null,
        },
        () => next(),
      );
    },
    requirePermission: (resource: string, action: string) => (c: any, next: any) => {
      const allowed = authState.permissions.some(
        (permission) =>
          (permission.resource === resource || permission.resource === '*')
          && (permission.action === action || permission.action === '*'),
      );
      return allowed ? next() : c.json({ error: 'Forbidden' }, 403);
    },
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { clientAiAdminSessionRoutes } from '../../routes/clientAi/adminSessions';
import { authMiddleware } from '../../middleware/auth';
import { db, withDbAccessContext } from '../../db';
import { aiMessages, aiSessions, aiToolExecutions, portalUsers } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminSessionRoutes);
  return app;
}

beforeEach(() => {
  authState.orgId = '';
  authState.permissions = [];
});

describe('cross-user AI admin read boundary', () => {
  it('denies an ordinary reader, redacts an authorized read, and hides a foreign session under RLS', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const ownOrg = await createOrganization({ partnerId: partner.id });
    const foreignOrg = await createOrganization({ partnerId: partner.id });

    const [ownPortalUser, foreignPortalUser] = await admin
      .insert(portalUsers)
      .values([
        { orgId: ownOrg.id, email: `own-${randomUUID()}@example.test`, authMethod: 'password' },
        { orgId: foreignOrg.id, email: `foreign-${randomUUID()}@example.test`, authMethod: 'password' },
      ])
      .returning({ id: portalUsers.id, orgId: portalUsers.orgId });

    const [ownSession, foreignSession] = await admin
      .insert(aiSessions)
      .values([
        { orgId: ownOrg.id, clientUserId: ownPortalUser!.id, type: 'excel_client', title: 'own' },
        { orgId: foreignOrg.id, clientUserId: foreignPortalUser!.id, type: 'excel_client', title: 'foreign' },
      ])
      .returning({ id: aiSessions.id, orgId: aiSessions.orgId });

    await admin.insert(aiMessages).values({
      sessionId: ownSession!.id,
      role: 'tool_use',
      content: 'synthetic content',
      toolInput: { note: 'password=synthetic-message-secret', deviceId: randomUUID() },
    });
    await admin.insert(aiToolExecutions).values({
      sessionId: ownSession!.id,
      toolName: 'synthetic_tool',
      toolInput: {
        deviceId: randomUUID(),
        providerConfig: { accessKey: 'synthetic-access', secretKey: 'synthetic-secret' },
      },
      status: 'completed',
    });

    authState.orgId = ownOrg.id;
    const app = buildApp();

    authState.permissions = [{ resource: 'organizations', action: 'read' }];
    const denied = await app.request(`/client-ai/admin/sessions/${ownSession!.id}`, {
      headers: { Authorization: 'Bearer synthetic' },
    });
    expect(denied.status).toBe(403);

    authState.permissions = [{ resource: 'ai_sessions', action: 'read_all' }];
    const allowed = await app.request(`/client-ai/admin/sessions/${ownSession!.id}`, {
      headers: { Authorization: 'Bearer synthetic' },
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as {
      messages: Array<{ toolInput: { note: string; deviceId: string } }>;
      toolExecutions: Array<{ toolInput: { deviceId: string; providerConfig: Record<string, string> } }>;
    };
    expect(body.messages[0]!.toolInput.note).not.toContain('synthetic-message-secret');
    expect(body.messages[0]!.toolInput.deviceId).toBeDefined();
    expect(body.toolExecutions[0]!.toolInput.providerConfig).toEqual({
      accessKey: '[REDACTED]',
      secretKey: '[REDACTED]',
    });
    expect(body.toolExecutions[0]!.toolInput.deviceId).toBeDefined();

    const foreign = await app.request(`/client-ai/admin/sessions/${foreignSession!.id}`, {
      headers: { Authorization: 'Bearer synthetic' },
    });
    expect(foreign.status).toBe(404);

    const roleRows = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: ownOrg.id,
        accessibleOrgIds: [ownOrg.id],
        accessiblePartnerIds: null,
        userId: null,
      },
      () => db.execute(sql`SELECT current_user AS who, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = current_user`),
    ) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(roleRows[0]).toEqual({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });
});
