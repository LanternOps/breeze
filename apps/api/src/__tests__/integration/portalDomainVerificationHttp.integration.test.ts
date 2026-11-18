/**
 * Org-scoped customer domain routes through the real Hono app, auth middleware
 * and RLS (portal registration W5 #11382, plan Task 7): partner B's admin can
 * neither read nor change partner A's org domains, and a domain id from another
 * org of the same partner is 404. Real Postgres; the verification check itself
 * is not exercised here (no network), only the refusals in front of it.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, setupTestEnvironment } from './db-utils';
import { customerEmailDomains } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgCustomerDomainRoutes } from '../../routes/orgCustomerDomains';

const admin = () => getTestDb();

async function mspSession() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgCustomerDomainRoutes(app);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { env, call };
}

async function seedVerified(orgId: string, partnerId: string) {
  const domain = `d-${randomUUID().slice(0, 8)}.example.com`;
  const at = new Date(Date.now() - 60 * 60_000);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId, orgId, domain,
    verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at, verifiedMethod: 'dns_txt',
    verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt: at, lastPassedAt: at, lastCheckStatus: 'pass',
  }).returning();
  return row!;
}

async function rowOf(id: string) {
  const [row] = await admin().select().from(customerEmailDomains).where(eq(customerEmailDomains.id, id));
  return row ?? null;
}

describe('org customer-domain routes over HTTP', () => {
  it('lists this org\'s domains with verification state and never the token or evidence', async () => {
    const a = await mspSession();
    const row = await seedVerified(a.env.organization.id, a.env.partner.id);
    const res = await a.call('GET', `/organizations/${a.env.organization.id}/customer-domains`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([expect.objectContaining({ id: row.id, state: 'verified', method: 'dns_txt', usableForSignIn: true })]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('verificationToken');
    expect(text).not.toContain('verifiedEvidence');
  });

  it("another partner's admin gets 404 on every route and changes nothing", async () => {
    const a = await mspSession();
    const b = await mspSession();
    const row = await seedVerified(a.env.organization.id, a.env.partner.id);
    const base = `/organizations/${a.env.organization.id}/customer-domains`;

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', base],
      ['POST', base, { domain: `x-${randomUUID().slice(0, 6)}.example.com` }],
      ['PATCH', `${base}/${row.id}`, { isActive: false }],
      ['DELETE', `${base}/${row.id}`],
      ['POST', `${base}/${row.id}/verification/dns`],
      ['POST', `${base}/${row.id}/verification/check`, { method: 'dns_txt' }],
      ['DELETE', `${base}/${row.id}/verification`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await b.call(method, path, body);
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    const after = await rowOf(row.id);
    expect(after).not.toBeNull();
    expect(after!.isActive).toBe(true);
    expect(after!.verifiedAt?.getTime()).toBe(row.verifiedAt!.getTime());
    const rows = await admin().select().from(customerEmailDomains).where(eq(customerEmailDomains.orgId, a.env.organization.id));
    expect(rows).toHaveLength(1);
  });

  it('a domain id from another org of the same partner is 404 CUSTOMER_DOMAIN_NOT_FOUND on every row route', async () => {
    const a = await mspSession();
    const sibling = await createOrganization({ partnerId: a.env.partner.id });
    const row = await seedVerified(sibling.id, a.env.partner.id);
    const base = `/organizations/${a.env.organization.id}/customer-domains/${row.id}`;
    const attempts: Array<[string, string, unknown?]> = [
      ['PATCH', base, { isActive: false }],
      ['DELETE', base],
      ['POST', `${base}/verification/dns`],
      ['POST', `${base}/verification/check`, { method: 'dns_txt' }],
      ['DELETE', `${base}/verification`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await a.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json(), `${method} ${path}`).toMatchObject({ code: 'CUSTOMER_DOMAIN_NOT_FOUND' });
    }
    const after = await rowOf(row.id);
    expect(after!.isActive).toBe(true);
    expect(after!.verifiedAt).not.toBeNull();
  });

  it('PATCH moving a verified domain to another org of the partner clears verification (trigger) and returns no token', async () => {
    const a = await mspSession();
    const sibling = await createOrganization({ partnerId: a.env.partner.id });
    const row = await seedVerified(a.env.organization.id, a.env.partner.id);
    const res = await a.call('PATCH', `/organizations/${a.env.organization.id}/customer-domains/${row.id}`, { orgId: sibling.id });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ orgId: sibling.id, state: 'declared', clearedReason: 'repointed', dnsRecord: null });
    expect((await rowOf(row.id))!.verificationToken).toBeNull();
  });
});
