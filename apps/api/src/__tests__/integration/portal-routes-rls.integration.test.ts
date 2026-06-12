/**
 * Portal routes — scoped DB access context end-to-end (breeze_app pool).
 *
 * Portal request handlers (routes/portal/*) historically queried through the
 * bare `db` proxy with no `withDbAccessContext`, so under the unprivileged
 * `breeze_app` role every portal table (RLS forced, org-keyed) was queried with
 * `breeze_current_scope() = 'none'` → `breeze_has_org_access()` false → zero
 * rows. The companion DB-layer proof lives in
 * `ticket-comments-rls.integration.test.ts` ("stays fail-closed without a DB
 * access context"). This suite proves the *route layer* now establishes the
 * right context: public pre-auth lookups (login, branding) run under system
 * scope, and authenticated requests run under the portal user's org scope.
 *
 * These run through the REAL postgres.js driver (db pool connects as
 * `breeze_app`), so a missing/incorrect context surfaces as the same empty/401
 * behavior production would see — `getTestDb()` (superuser) is used for SEED only.
 */
import './setup';
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { portalRoutes } from '../../routes/portal';
import { portalResetTokens } from '../../routes/portal/helpers';
import { portalUsers, devices, portalBranding } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

const PORTAL_PASSWORD = 'PortalPass123!';

function buildPortalApp(): Hono {
  const app = new Hono();
  app.route('/portal', portalRoutes);
  return app;
}

interface SeededOrg {
  orgId: string;
  siteId: string;
  partnerId: string;
}

async function seedOrgWithDevice(hostname: string): Promise<SeededOrg & { deviceId: string }> {
  const admin = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await admin
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `portal-rls-agent-${unique}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning();

  return { orgId: org.id, siteId: site.id, partnerId: partner.id, deviceId: device.id };
}

async function seedPortalUser(orgId: string): Promise<{ id: string; email: string }> {
  const admin = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `portal-rls-${unique}@example.test`;
  const passwordHash = await hashPassword(PORTAL_PASSWORD);
  const [portalUser] = await admin
    .insert(portalUsers)
    .values({ orgId, email, name: 'Portal Customer', passwordHash, status: 'active' })
    .returning();
  return { id: portalUser.id, email: portalUser.email };
}

async function loginPortal(app: Hono, email: string, orgId: string): Promise<string> {
  const res = await app.request('/portal/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PORTAL_PASSWORD, orgId }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accessToken).toBeTruthy();
  return body.accessToken as string;
}

describe('portal routes — scoped DB access context (breeze_app pool)', () => {
  it('login resolves the portal user under the unprivileged pool (public, system scope)', async () => {
    const { orgId } = await seedOrgWithDevice('portal-login-host');
    const portalUser = await seedPortalUser(orgId);
    const app = buildPortalApp();

    // Pre-auth lookup must run under system scope or breeze_app RLS hides the
    // portal_users row and login always returns "Invalid email or password".
    const token = await loginPortal(app, portalUser.email, orgId);
    expect(token).toBeTruthy();
  });

  it('authenticated device list returns the portal user\'s org devices (protected, org scope)', async () => {
    const { orgId, deviceId } = await seedOrgWithDevice('portal-device-host');
    const portalUser = await seedPortalUser(orgId);
    const app = buildPortalApp();

    const token = await loginPortal(app, portalUser.email, orgId);
    const res = await app.request('/portal/devices', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: any) => d.id)).toContain(deviceId);
  });

  it('a portal user never sees another org\'s devices (org-scope isolation, not system)', async () => {
    const orgA = await seedOrgWithDevice('portal-orgA-host');
    const orgB = await seedOrgWithDevice('portal-orgB-host');
    const portalUserA = await seedPortalUser(orgA.orgId);
    const app = buildPortalApp();

    const token = await loginPortal(app, portalUserA.email, orgA.orgId);
    const res = await app.request('/portal/devices', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((d: any) => d.id);
    expect(ids).toContain(orgA.deviceId);
    expect(ids).not.toContain(orgB.deviceId);
  });

  it('public branding resolves by verified domain under the unprivileged pool (system scope)', async () => {
    const admin = getTestDb() as any;
    const { orgId } = await seedOrgWithDevice('portal-branding-host');
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `portal-${unique}.example.test`;
    await admin.insert(portalBranding).values({
      orgId,
      customDomain: domain,
      domainVerified: true,
      primaryColor: '#111111',
    });

    const app = buildPortalApp();
    const res = await app.request(`/portal/branding/${encodeURIComponent(domain)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding.customDomain).toBe(domain);
  });

  it('ticket round-trip (create → list → detail → comment) works under org scope', async () => {
    const { orgId } = await seedOrgWithDevice('portal-ticket-host');
    const portalUser = await seedPortalUser(orgId);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, orgId);
    const authed = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

    const createRes = await authed('/portal/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject: 'Cannot print', description: 'The office printer is offline', priority: 'high' }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const ticketId = createBody.ticket.id;
    expect(ticketId).toBeTruthy();

    const listRes = await authed('/portal/tickets');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.map((t: any) => t.id)).toContain(ticketId);

    const detailRes = await authed(`/portal/tickets/${ticketId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.ticket.id).toBe(ticketId);

    const commentRes = await authed(`/portal/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Still not working this morning' }),
    });
    expect(commentRes.status).toBe(201);
    const commentBody = await commentRes.json();
    expect(commentBody.comment.content).toBe('Still not working this morning');

    const detailAfter = await authed(`/portal/tickets/${ticketId}`);
    const detailAfterBody = await detailAfter.json();
    expect(detailAfterBody.ticket.comments.map((c: any) => c.id)).toContain(commentBody.comment.id);
  });

  it('asset list + checkout works under org scope', async () => {
    const { orgId, deviceId } = await seedOrgWithDevice('portal-asset-host');
    const portalUser = await seedPortalUser(orgId);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, orgId);
    const authed = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

    const listRes = await authed('/portal/assets');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.map((a: any) => a.id)).toContain(deviceId);

    const checkoutRes = await authed(`/portal/assets/${deviceId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ checkoutNotes: 'Taking home for the weekend' }),
    });
    expect(checkoutRes.status).toBe(201);

    // Once checked out, the device drops off the available list.
    const listAfter = await authed('/portal/assets');
    const listAfterBody = await listAfter.json();
    expect(listAfterBody.data.map((a: any) => a.id)).not.toContain(deviceId);
  });

  it('reset-password updates the portal user password under the unprivileged pool (system scope)', async () => {
    const { orgId } = await seedOrgWithDevice('portal-reset-host');
    const portalUser = await seedPortalUser(orgId);
    const app = buildPortalApp();

    // PORTAL_USE_REDIS is false under NODE_ENV=test, so the reset route reads
    // the token from the in-memory map — seed it directly with a known token.
    const resetToken = `reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    portalResetTokens.set(tokenHash, {
      userId: portalUser.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    const newPassword = 'NewPortalPass456!';
    const resetRes = await app.request('/portal/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password: newPassword }),
    });
    expect(resetRes.status).toBe(200);

    // The UPDATE runs under withSystemDbAccessContext; without it the breeze_app
    // pool would update zero rows and the route would still 200 (silent no-op).
    // Prove the row actually changed: the new password logs in, the old fails.
    const loginNew = await app.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: portalUser.email, password: newPassword, orgId }),
    });
    expect(loginNew.status).toBe(200);

    const loginOld = await app.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: portalUser.email, password: PORTAL_PASSWORD, orgId }),
    });
    expect(loginOld.status).toBe(401);
  });

  it('profile read + update works under org scope', async () => {
    const { orgId } = await seedOrgWithDevice('portal-profile-host');
    const portalUser = await seedPortalUser(orgId);
    const app = buildPortalApp();
    const token = await loginPortal(app, portalUser.email, orgId);
    const authed = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

    const getRes = await authed('/portal/profile');
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.user.email).toBe(portalUser.email);

    const patchRes = await authed('/portal/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed Customer' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.user.name).toBe('Renamed Customer');
  });
});
