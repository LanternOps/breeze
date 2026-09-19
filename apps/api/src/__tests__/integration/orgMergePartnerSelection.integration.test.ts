/**
 * Real-request/real-PostgreSQL coverage for organization-merge admission.
 *
 * The merge engine and queue are synthetic mocks: this suite proves the HTTP
 * boundary re-reads the caller's current partner_users selection through the
 * unprivileged breeze_app pool before either downstream can run.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

const { previewMock, enqueueMock } = vi.hoisted(() => ({
  previewMock: vi.fn(async () => ({
    tables: [],
    totalMovableRows: 0,
    verdict: 'ok',
    warnings: [],
  })),
  enqueueMock: vi.fn(),
}));

vi.mock('../../services/orgMerge', () => {
  class MergeValidationError extends Error {}
  return { MergeValidationError, previewOrgMerge: previewMock };
});
vi.mock('../../jobs/orgMerge', () => ({
  enqueueOrgMerge: enqueueMock,
  getOrgMergeQueue: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { db, withSystemDbAccessContext } from '../../db';
import { partnerUsers } from '../../db/schema';
import { createOrganization, setupTestEnvironment } from './db-utils';
import { createAccessToken } from '../../services/jwt';
import { orgMergeRoutes } from '../../routes/orgMerge';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);

async function mfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'org-merge-selection-integration',
  });
}

describe('organization merge current partner selection admission', () => {
  runDb('denies a hidden loser and permits the same suspended loser only after current selection includes both orgs', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const loser = await withSystemDbAccessContext(() =>
      createOrganization({
        partnerId: env.partner.id,
        name: 'Synthetic suspended merge loser',
        status: 'suspended',
      }),
    );

    await withSystemDbAccessContext(() =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'selected', orgIds: [env.organization.id] })
        .where(eq(partnerUsers.userId, env.user.id)),
    );

    const app = new Hono();
    app.route('/orgs', orgMergeRoutes);
    const token = await mfaToken(env);
    const request = () =>
      app.request(`/orgs/organizations/${loser.id}/merge-preview`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ survivorId: env.organization.id }),
      });

    const denied = await request();
    expect(denied.status).toBe(404);
    expect(previewMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();

    const enqueueDenied = await app.request(`/orgs/organizations/${loser.id}/merge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ survivorId: env.organization.id, confirmName: loser.name }),
    });
    expect(enqueueDenied.status).toBe(404);
    expect(previewMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();

    await withSystemDbAccessContext(() =>
      db
        .update(partnerUsers)
        .set({ orgIds: [env.organization.id, loser.id] })
        .where(eq(partnerUsers.userId, env.user.id)),
    );

    const allowed = await request();
    expect(allowed.status).toBe(200);
    expect(previewMock).toHaveBeenCalledWith(loser.id, env.organization.id, env.partner.id);

    await withSystemDbAccessContext(() =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'none', orgIds: [] })
        .where(eq(partnerUsers.userId, env.user.id)),
    );

    previewMock.mockClear();
    const noneDenied = await request();
    expect(noneDenied.status).toBe(404);
    expect(previewMock).not.toHaveBeenCalled();
  });
});
