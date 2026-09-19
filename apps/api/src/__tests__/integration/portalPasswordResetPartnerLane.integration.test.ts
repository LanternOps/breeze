import './setup';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { partnerSenderIdentities, partnerSendingDomains, portalUsers } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

/**
 * The portal password-reset route, end to end on REAL Postgres (spec §8.2, §14).
 *
 * WHY THIS FILE EXISTS: `routes/portal/auth.ts` resolves the partner for
 * `portal.password_reset` with an inner join on `organizations`, inside the
 * `withSystemDbAccessContext` the lookup already holds. That read MUST stay in a
 * DB context — an unauthenticated request carries none, and `organizations` is
 * org-axis, so OUTSIDE a context forced RLS matches ZERO ROWS **silently**
 * rather than raising. A mocked-DB unit test cannot see that: it would hand back
 * the stubbed row either way and stay green while production quietly sent every
 * portal reset from the platform sender.
 *
 * `partnerSendingDomainsRls.integration.test.ts` proves `resolveSender` itself
 * works with no ambient context, but it calls the resolver directly and never
 * touches this route. This file drives the actual HTTP handler, with no auth
 * context, and asserts on the envelope that reaches the transport.
 *
 * Only the TRANSPORT is mocked. The route, the resolver, the identity lookup,
 * the provider registry and the `static` adapter are all production code.
 */

const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
vi.mock('resend', () => ({ Resend: class MockResend { emails = { send: resendSendMock }; } }));

const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM',
  'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_STATIC_ALLOWED', 'EMAIL_DOMAINS_DAILY_SEND_CAP',
  'EMAIL_DOMAINS_PARTNER_ALLOWLIST', 'IS_HOSTED',
];

const DOMAIN = `portal-reset-${Date.now().toString(36)}.test`;
const PLATFORM_FROM = 'Breeze <no-reply@2breeze.app>';

beforeAll(() => {
  for (const key of ENV_KEYS) SAVED[key] = process.env[key];
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 're_integration_test';
  process.env.EMAIL_FROM = PLATFORM_FROM;
  // `static` is the self-hosted adapter, so IS_HOSTED must stay unset; it sends
  // by handing the message back to EmailService.deliverRaw, which is where the
  // mocked Resend SDK captures the envelope.
  delete process.env.IS_HOSTED;
  process.env.EMAIL_DOMAINS_PROVIDER = 'static';
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = DOMAIN;
  process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
  delete process.env.EMAIL_DOMAINS_PARTNER_ALLOWLIST;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key]!;
  }
});

describe.runIf(!!process.env.DATABASE_URL_APP)('portal password reset resolves the partner lane on real Postgres', () => {
  it('sends the reset from the partner support identity, with no ambient DB context', async () => {
    const db = getTestDb();
    const { resetEmailDomainProviderForTests } = await import('../../services/emailDomains/providerRegistry');
    resetEmailDomainProviderForTests();
    resendSendMock.mockReset();
    resendSendMock.mockResolvedValue({ error: null });

    // createPartner() defaults to status 'active' / trust_state 'trusted'.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [domainRow] = await db.insert(partnerSendingDomains).values({
      partnerId: partner.id, domain: DOMAIN, provider: 'static',
      providerDomainId: null, providerManaged: false, status: 'verified',
    }).returning();
    if (!domainRow) throw new Error('failed to seed sending domain');

    await db.insert(partnerSenderIdentities).values({
      partnerId: partner.id, sendingDomainId: domainRow.id, stream: 'support',
      localPart: 'support', displayName: 'Acme Support', replyTo: null,
    });

    const email = `portal-reset-${Date.now()}@example.test`;
    const [user] = await db.insert(portalUsers).values({
      orgId: org.id, email, name: 'Portal Reset Fixture',
      passwordHash: await hashPassword('Synthetic-Portal-Pass-902!'),
      authMethod: 'password', status: 'active',
    }).returning();
    if (!user) throw new Error('failed to seed portal user');

    // The real, unauthenticated route. No withDbAccessContext wrapper here on
    // purpose: that IS the condition under test.
    const { authRoutes } = await import('../../routes/portal/auth');
    const app = new Hono().route('/', authRoutes);
    const res = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, orgId: org.id }),
    });

    // The route always answers 200 (it must not disclose whether the address
    // exists), so the assertion that matters is the envelope, not the status.
    expect(res.status).toBe(200);
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const sent = resendSendMock.mock.calls[0]![0] as { from: string; headers?: Record<string, string> };
    // If the organizations join ever escapes its system context, RLS returns
    // zero rows, partnerId becomes null and this is PLATFORM_FROM instead.
    expect(sent.from).toBe(`"Acme Support" <support@${DOMAIN}>`);
    expect(sent.from).not.toBe(PLATFORM_FROM);
    expect(sent.headers?.['X-Breeze-Outbound']).toBe('1');
  });
});
