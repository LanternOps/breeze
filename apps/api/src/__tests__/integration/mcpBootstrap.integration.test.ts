/**
 * MCP Bootstrap Integration Test
 *
 * End-to-end walkthrough of the MCP agent-deployable tenant-bootstrap state
 * machine against a real Postgres instance. Exercises:
 *
 *   1. Unauth tools/call create_tenant           → pending_email
 *   2. Unauth tools/call verify_tenant           → pending_email
 *   3. Direct DB write simulates email click
 *   4. Unauth tools/call verify_tenant           → pending_payment (+ api_key)
 *   5. Direct DB write simulates Stripe webhook
 *   6. Unauth tools/call verify_tenant           → active (scope=full)
 *   7. Authed tools/call send_deployment_invites → invites_sent > 0
 *
 * We avoid depending on Task 9.2's test-mode HTTP hooks so the state-machine
 * and key-scope transitions are verified in isolation. Email delivery is
 * mocked away at the `services/email` module level.
 */

// ⚠️ Env vars required by the MCP bootstrap module's startup check MUST be set
// BEFORE the module is imported. `startupCheck.ts` throws when any of these are
// missing, and initMcpBootstrap runs at first POST /mcp/message. Set them here
// at top-of-file so Vitest's hoisted vi.mock() and the import graph both see
// them.
process.env.MCP_BOOTSTRAP_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_xxx';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test';
process.env.BREEZE_BILLING_URL = process.env.BREEZE_BILLING_URL || 'http://localhost:9999';
process.env.EMAIL_PROVIDER_KEY = process.env.EMAIL_PROVIDER_KEY || 'test-email-key';
process.env.PUBLIC_ACTIVATION_BASE_URL = process.env.PUBLIC_ACTIVATION_BASE_URL || 'http://localhost:3000';
process.env.BREEZE_REGION = process.env.BREEZE_REGION || 'us';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';

// Mock the email service so sendActivationEmail / sendDeploymentInvites don't
// hit a real SMTP / Resend / Mailgun provider during the test.
vi.mock('../../services/email', () => ({
  getEmailService: () => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Import setup so DB connection + migrations are ready.
import './setup';
import { getTestDb } from './setup';
import { partners, partnerActivations, apiKeys, organizations, sites } from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);

// JSON-RPC helper: POST a tools/call message into the mounted Hono app.
async function rpcCall(
  app: Hono,
  params: { name: string; arguments: Record<string, unknown> },
  headers: Record<string, string> = {},
): Promise<Response> {
  // The unauth bootstrap dispatch now wraps handler execution in
  // withSystemDbAccessContext internally (see mcpServer.ts), so the unauth
  // path does not need an outer wrap. The authed path still needs one in this
  // harness: the authed `requirePaymentMethod` decorator reads `partners`,
  // which is partner-axis RLS; apiKeyAuthMiddleware enters `organization`
  // scope with `accessiblePartnerIds: []`, so the direct read would return
  // empty and trip a false PAYMENT_REQUIRED. Wrapping here short-circuits
  // nested withDbAccessContext (it returns fn() when a store is already set)
  // so the partner read runs under system scope, matching production flow
  // where upstream middleware establishes context before routes run.
  return withSystemDbAccessContext(async () =>
    app.request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1_000_000),
        method: 'tools/call',
        params,
      }),
    }),
  );
}

/**
 * Extract the tool-result JSON payload from a JSON-RPC response. Bootstrap
 * tools wrap results as `{ content: [{ type:'text', text: JSON.stringify(...) }] }`.
 */
async function readToolResult(res: Response): Promise<any> {
  const body = await res.json() as any;
  if (body.error) {
    throw new Error(`JSON-RPC error: ${body.error.message} (${JSON.stringify(body.error.data ?? {})})`);
  }
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Unexpected result shape: ${JSON.stringify(body)}`);
  }
  return JSON.parse(text);
}

describe('MCP bootstrap integration', () => {
  // Global cleanupDatabase() (in setup.ts) truncates roles/permissions before
  // each test. createPartner() depends on a seeded "Partner Admin" system role
  // so its permissions can be copied onto the new partner admin role; re-seed
  // here after the global truncate runs.
  beforeEach(async () => {
    if (!SHOULD_RUN) return;
    const { seedPermissions, seedRoles } = await import('../../db/seed');
    await seedPermissions();
    await seedRoles();
  });

  it.skipIf(!SHOULD_RUN)(
    'end-to-end: create → pending_email → email-click → pending_payment → webhook → active → authed invite',
    async () => {
      // Import the route + bootstrap loader here so env vars + mocks are in
      // place before the mcpServer module initializes its bootstrap side-effects.
      const { mcpServerRoutes, __loadMcpBootstrapForTests } = await import('../../routes/mcpServer');
      // Force-load the bootstrap module now (normally deferred to a microtask).
      const bootstrap = await __loadMcpBootstrapForTests();
      expect(bootstrap, 'bootstrap module should load when MCP_BOOTSTRAP_ENABLED=true').not.toBeNull();

      const app = new Hono();
      app.route('/mcp', mcpServerRoutes);

      const testDb = getTestDb();
      const adminEmail = `bootstrap-${Date.now()}@acme-ops.com`; // business domain (acme-ops.com isn't on free-provider blocklists)
      const orgName = `Bootstrap Test ${Date.now()}`;

      // Step 1: create_tenant ---------------------------------------------------
      let res = await rpcCall(app, {
        name: 'create_tenant',
        arguments: {
          org_name: orgName,
          admin_email: adminEmail,
          admin_name: 'Bootstrap Admin',
          region: 'us',
        },
      });
      expect(res.status).toBe(200);
      const created = await readToolResult(res);
      expect(created).toMatchObject({ activation_status: 'pending_email' });
      expect(created.tenant_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof created.bootstrap_secret).toBe('string');
      const tenantId: string = created.tenant_id;
      const bootstrapSecret: string = created.bootstrap_secret;

      // Step 2: verify_tenant → pending_email -----------------------------------
      res = await rpcCall(app, {
        name: 'verify_tenant',
        arguments: { tenant_id: tenantId, bootstrap_secret: bootstrapSecret },
      });
      expect(await readToolResult(res)).toEqual({ status: 'pending_email' });

      // Step 3: simulate email click (direct DB writes) -------------------------
      //   - mark partner email verified
      //   - consume the latest activation token row
      await testDb
        .update(partners)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(partners.id, tenantId));
      await testDb
        .update(partnerActivations)
        .set({ consumedAt: new Date() })
        .where(eq(partnerActivations.partnerId, tenantId));

      // Step 4: verify_tenant → pending_payment (mints readonly api_key) -------
      res = await rpcCall(app, {
        name: 'verify_tenant',
        arguments: { tenant_id: tenantId, bootstrap_secret: bootstrapSecret },
      });
      const afterEmail = await readToolResult(res);
      expect(afterEmail.status).toBe('pending_payment');
      expect(afterEmail.scope).toBe('readonly');
      expect(afterEmail.api_key).toMatch(/^brz_/);
      const rawApiKey: string = afterEmail.api_key;

      // Step 5: simulate Stripe webhook (direct DB writes) ---------------------
      //   - mark payment method attached
      //   - upgrade readonly keys under the partner to full
      await testDb
        .update(partners)
        .set({ paymentMethodAttachedAt: new Date() })
        .where(eq(partners.id, tenantId));
      const orgs = await testDb
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, tenantId));
      if (orgs.length > 0) {
        await testDb
          .update(apiKeys)
          .set({ scopeState: 'full' })
          .where(
            and(
              inArray(
                apiKeys.orgId,
                orgs.map((o) => o.id),
              ),
              eq(apiKeys.scopeState, 'readonly'),
            ),
          );
      }

      // Step 6: verify_tenant → active -----------------------------------------
      res = await rpcCall(app, {
        name: 'verify_tenant',
        arguments: { tenant_id: tenantId, bootstrap_secret: bootstrapSecret },
      });
      const afterPayment = await readToolResult(res);
      expect(afterPayment.status).toBe('active');
      expect(afterPayment.scope).toBe('full');

      // Sanity: partner should have at least one site (needed for mintChildEnrollmentKey).
      const [org] = orgs;
      expect(org).toBeDefined();
      const [site] = await testDb
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.orgId, org!.id))
        .limit(1);
      expect(site).toBeDefined();

      // Step 7: authed send_deployment_invites ---------------------------------
      res = await rpcCall(
        app,
        {
          name: 'send_deployment_invites',
          arguments: {
            emails: [`invitee-${Date.now()}@acme-ops.com`],
            custom_message: 'Please install the Breeze agent.',
          },
        },
        { 'X-API-Key': rawApiKey },
      );
      expect(res.status).toBe(200);
      const invites = await readToolResult(res);
      expect(invites.invites_sent).toBeGreaterThan(0);
      expect(Array.isArray(invites.invite_ids)).toBe(true);
      expect(invites.invite_ids.length).toBe(invites.invites_sent);
    },
    60_000,
  );
});
