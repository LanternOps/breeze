/**
 * TenantInactive gate integration tests
 *
 * Covers `services/tenantStatus.ts::assertActiveTenantContext`, invoked by
 * `middleware/auth.ts` on every authenticated request after JWT verification.
 *
 * The unit tests for routes (`authenticated.example.test.ts`,
 * `devices.endpoints.test.ts`, `oauth/provider.test.ts`) all mock the
 * tenantStatus module and bypass this gate, so the suspended-tenant 403 path
 * has zero unit coverage. These tests run against the real Postgres test
 * stack so the gate is exercised end-to-end.
 *
 * NOTE: lives in its own file (not auth.integration.test.ts) because that
 * file is excluded from the integration runner by vitest.integration.config.ts
 * — see the inline note in that config explaining the legacy /auth/register
 * & login-cookie issues. Adding the tests here is the only way they actually
 * run against the gate.
 *
 * Each test:
 *   1. Creates a partner + org (varying the status / deletedAt)
 *   2. Mints a real JWT for that tenant via createAccessToken
 *   3. Hits a tiny Hono app mounted with authMiddleware
 *   4. Asserts 200 (active) or 403 (gated)
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/tenantStatus.integration.test.ts
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  createUser,
  createPartner,
  createOrganization,
  createRole,
  assignUserToPartner,
  assignUserToOrganization
} from './db-utils';

/**
 * Build a Hono app that mounts authMiddleware in front of a no-op handler.
 * Mirrors the global onError shape used by the real API (HTTPException →
 * structured JSON response), so 403 from the gate surfaces cleanly.
 */
function buildAuthGatedApp() {
  const app = new Hono();
  app.use('/protected', authMiddleware);
  app.get('/protected', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  });
  return app;
}

/**
 * Mint an org-scoped access token for a freshly created user that's been
 * properly assigned to the org. The user/role rows have to exist because
 * authMiddleware does a real lookup against `users` (system-scope read)
 * before reaching assertActiveTenantContext.
 */
async function mintOrgScopedToken(opts: {
  userPartnerId: string; // user.partner_id (FK NOT NULL)
  tokenPartnerId: string | null; // what the JWT claims (may differ to test cross-tenant)
  orgId: string;
  userOrgId?: string | null; // user.org_id; defaults to orgId
}): Promise<string> {
  const user = await createUser({
    partnerId: opts.userPartnerId,
    orgId: opts.userOrgId === undefined ? opts.orgId : opts.userOrgId
  });
  const role = await createRole({ scope: 'organization', orgId: opts.orgId });
  await assignUserToOrganization(user.id, opts.orgId, role.id);

  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: opts.orgId,
    partnerId: opts.tokenPartnerId,
    scope: 'organization',
    mfa: false
  };
  return createAccessToken(payload);
}

async function mintPartnerScopedToken(partnerId: string): Promise<string> {
  const user = await createUser({ partnerId, orgId: null });
  const role = await createRole({ scope: 'partner', partnerId });
  await assignUserToPartner(user.id, partnerId, role.id, 'all');

  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId,
    scope: 'partner',
    mfa: false
  };
  return createAccessToken(payload);
}

describe('TenantInactive gate (assertActiveTenantContext)', () => {
  describe('partner-scoped tokens', () => {
    it('returns 403 when partner.status = suspended', async () => {
      const partner = await createPartner({ status: 'suspended' });
      const token = await mintPartnerScopedToken(partner.id);
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/tenant/i);
    });

    it('returns 403 when partner.deletedAt is set (soft-deleted)', async () => {
      const partner = await createPartner({ deletedAt: new Date() });
      const token = await mintPartnerScopedToken(partner.id);
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });

    it('returns 200 when partner.status = active and deletedAt is null', async () => {
      const partner = await createPartner({ status: 'active' });
      const token = await mintPartnerScopedToken(partner.id);
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe('org-scoped tokens', () => {
    it('returns 403 when org.status = suspended', async () => {
      const partner = await createPartner({ status: 'active' });
      const org = await createOrganization({
        partnerId: partner.id,
        status: 'suspended'
      });
      const token = await mintOrgScopedToken({
        userPartnerId: partner.id,
        tokenPartnerId: partner.id,
        orgId: org.id
      });
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when org.deletedAt is set (soft-deleted)', async () => {
      const partner = await createPartner({ status: 'active' });
      const org = await createOrganization({
        partnerId: partner.id,
        status: 'active',
        deletedAt: new Date()
      });
      const token = await mintOrgScopedToken({
        userPartnerId: partner.id,
        tokenPartnerId: partner.id,
        orgId: org.id
      });
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 (cascade) when the org is active but its partner is suspended', async () => {
      // org is fine; partner under it is suspended → must still be denied
      const partner = await createPartner({ status: 'suspended' });
      const org = await createOrganization({
        partnerId: partner.id,
        status: 'active'
      });
      const token = await mintOrgScopedToken({
        userPartnerId: partner.id,
        tokenPartnerId: partner.id,
        orgId: org.id
      });
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when token.partnerId does not match org.partnerId (cross-tenant)', async () => {
      // Partner A owns the org. Token claims partner B. Both are active —
      // the only thing that should fail is the partnerId mismatch check
      // at the bottom of getActiveOrgTenant + assertActiveTenantContext.
      const partnerA = await createPartner({ status: 'active' });
      const partnerB = await createPartner({ status: 'active' });
      const org = await createOrganization({
        partnerId: partnerA.id,
        status: 'active'
      });

      // The user belongs to partnerA (the actual owner) so the user lookup
      // succeeds. We forge a token whose partnerId claim is partnerB to
      // simulate a cross-tenant escalation attempt.
      const token = await mintOrgScopedToken({
        userPartnerId: partnerA.id,
        tokenPartnerId: partnerB.id,
        orgId: org.id
      });
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
    });

    it('returns 200 for a healthy partner+org combination (positive control)', async () => {
      const partner = await createPartner({ status: 'active' });
      const org = await createOrganization({
        partnerId: partner.id,
        status: 'active'
      });
      const token = await mintOrgScopedToken({
        userPartnerId: partner.id,
        tokenPartnerId: partner.id,
        orgId: org.id
      });
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns 200 when org.status = trial (other allowlisted status)', async () => {
      const partner = await createPartner({ status: 'active' });
      const org = await createOrganization({
        partnerId: partner.id,
        status: 'trial'
      });
      const token = await mintOrgScopedToken({
        userPartnerId: partner.id,
        tokenPartnerId: partner.id,
        orgId: org.id
      });
      const app = buildAuthGatedApp();

      const res = await app.request('/protected', {
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
    });
  });
});
