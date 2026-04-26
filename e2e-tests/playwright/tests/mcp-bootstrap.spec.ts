// e2e-tests/playwright/tests/mcp-bootstrap.spec.ts
//
// The MCP bootstrap flow is entirely API-only (no UI). It requires:
//   MCP_BOOTSTRAP_ENABLED=true
//   MCP_BOOTSTRAP_TEST_MODE=true
//   PUBLIC_ACTIVATION_BASE_URL (set in env)
//   STRIPE_SECRET_KEY (set in env)
//
// When these env vars are absent the tests are skipped to avoid false failures
// in standard CI.
import { test, expect } from '../fixtures';
import { McpBootstrapPage } from '../pages/McpBootstrapPage';

const MCP_ENABLED =
  process.env.MCP_BOOTSTRAP_ENABLED === 'true' &&
  process.env.MCP_BOOTSTRAP_TEST_MODE === 'true';

test.describe('MCP Agent-Deployable Bootstrap Flow', () => {
  test.skip(!MCP_ENABLED, 'Requires MCP_BOOTSTRAP_ENABLED=true and MCP_BOOTSTRAP_TEST_MODE=true');

  test('full bootstrap flow: create → verify → activate → payment → active → invites → fleet', async ({
    authedPage,
    request,
  }) => {
    const page = new McpBootstrapPage(authedPage, request);
    const runId = Date.now().toString(36);

    // Stage 1: create_tenant
    const createRes = await page.callMcpTool('create_tenant', {
      org_name: `MCP E2E ${runId}`,
      admin_email: `test+${runId}@acme-e2e.test`,
      admin_name: 'Test Admin',
      region: 'us',
    });
    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const createPayload = JSON.parse(createBody.result?.content?.[0]?.text ?? '{}');
    expect(createPayload.activation_status).toBe('pending_email');
    const tenantId: string = createPayload.tenant_id;
    expect(tenantId).toBeTruthy();

    // Stage 2: verify_tenant — expect pending_email
    const verifyPendingEmailRes = await page.callMcpTool(
      'verify_tenant',
      { tenant_id: tenantId },
      { id: 2 },
    );
    expect(verifyPendingEmailRes.ok()).toBe(true);
    const verifyPendingEmailBody = await verifyPendingEmailRes.json();
    const verifyPendingEmailPayload = JSON.parse(
      verifyPendingEmailBody.result?.content?.[0]?.text ?? '{}',
    );
    expect(verifyPendingEmailPayload.status).toBe('pending_email');

    // Stage 3: simulate email activation
    const activateRes = await page.simulateEmailActivation(tenantId);
    expect(activateRes.ok()).toBe(true);

    // Stage 4: verify_tenant — expect pending_payment
    const verifyPendingPaymentRes = await page.callMcpTool(
      'verify_tenant',
      { tenant_id: tenantId },
      { id: 3 },
    );
    expect(verifyPendingPaymentRes.ok()).toBe(true);
    const verifyPendingPaymentBody = await verifyPendingPaymentRes.json();
    const verifyPendingPaymentPayload = JSON.parse(
      verifyPendingPaymentBody.result?.content?.[0]?.text ?? '{}',
    );
    expect(verifyPendingPaymentPayload.status).toBe('pending_payment');
    const apiKey: string = verifyPendingPaymentPayload.api_key;
    expect(apiKey).toBeTruthy();

    // Stage 5: simulate payment
    const paymentRes = await page.simulatePaymentCompletion(tenantId);
    expect(paymentRes.ok()).toBe(true);

    // Stage 6: verify_tenant — expect active
    const verifyActiveRes = await page.callMcpTool(
      'verify_tenant',
      { tenant_id: tenantId },
      { id: 4 },
    );
    expect(verifyActiveRes.ok()).toBe(true);
    const verifyActiveBody = await verifyActiveRes.json();
    const verifyActivePayload = JSON.parse(verifyActiveBody.result?.content?.[0]?.text ?? '{}');
    expect(verifyActivePayload.status).toBe('active');

    // Stage 7: authed send_deployment_invites
    const invitesRes = await page.callMcpTool(
      'send_deployment_invites',
      { emails: [`test+invitee-${runId}@acme-e2e.test`] },
      { id: 5, headers: { 'X-API-Key': apiKey } },
    );
    expect(invitesRes.ok()).toBe(true);
    const invitesBody = await invitesRes.json();
    const invitesPayload = JSON.parse(invitesBody.result?.content?.[0]?.text ?? '{}');
    expect(invitesPayload.invites_sent).toBeGreaterThanOrEqual(1);

    // Stage 8: authed get_fleet_status
    const fleetRes = await page.callMcpTool(
      'get_fleet_status',
      {},
      { id: 6, headers: { 'X-API-Key': apiKey } },
    );
    expect(fleetRes.ok()).toBe(true);
    const fleetBody = await fleetRes.json();
    const fleetPayload = JSON.parse(fleetBody.result?.content?.[0]?.text ?? '{}');
    expect(fleetPayload.invite_funnel?.total_invited).toBeGreaterThanOrEqual(1);
  });
});
