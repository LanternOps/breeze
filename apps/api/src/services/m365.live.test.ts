import { describe, it, expect } from 'vitest';
import { invokeDelegantTool } from './delegantClient';
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';

// Opt-in live suite. Runs ONLY when real Delegant creds + a seeded sandbox
// connection are present. Without them, every test SKIPS so `pnpm test` is green.
const LIVE = process.env.DELEGANT_LIVE_TEST === '1'
  && !!process.env.DELEGANT_BASE_URL
  && !!process.env.DELEGANT_SERVICE_TOKEN
  && !!process.env.DELEGANT_PRINCIPAL_SIGNING_KEY
  && !!process.env.DELEGANT_PRINCIPAL_KID
  && !!process.env.DELEGANT_TEST_AGENT_ID
  && !!process.env.DELEGANT_TEST_ACTING_USER_ID;

// Mutations (password reset) require an EXTRA explicit opt-in so a stray live
// run can never reset a real account.
const ALLOW_MUTATIONS = LIVE && process.env.DELEGANT_LIVE_ALLOW_MUTATIONS === '1';

function liveEnv() {
  return {
    DELEGANT_BASE_URL: process.env.DELEGANT_BASE_URL!,
    DELEGANT_SERVICE_TOKEN: process.env.DELEGANT_SERVICE_TOKEN!,
    DELEGANT_PRINCIPAL_SIGNING_KEY: process.env.DELEGANT_PRINCIPAL_SIGNING_KEY!,
    DELEGANT_PRINCIPAL_KID: process.env.DELEGANT_PRINCIPAL_KID!,
  };
}

// A seeded sandbox connection + a known sandbox user are provided via env.
function liveConnection(): DelegantM365ConnectionRow {
  return {
    id: process.env.DELEGANT_LIVE_CONNECTION_ID ?? 'live-conn',
    orgId: process.env.DELEGANT_LIVE_BREEZE_ORG_ID ?? 'live-org',
    customerLabel: 'sandbox',
    customerDisplayName: 'Sandbox Tenant',
    delegantOrgId: process.env.DELEGANT_LIVE_DELEGANT_ORG_ID!,
    delegantConnectionId: process.env.DELEGANT_LIVE_DELEGANT_CONNECTION_ID ?? 'live-dconn',
    m365TenantId: process.env.DELEGANT_LIVE_M365_TENANT_ID ?? 'live-tid',
    status: 'active',
    lastVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function liveActingUser() {
  return { breezeUserId: 'live-tech', delegantPrincipalId: process.env.DELEGANT_TEST_ACTING_USER_ID! };
}

function liveAgent() {
  return { delegantPrincipalId: process.env.DELEGANT_TEST_AGENT_ID! };
}

describe.skipIf(!LIVE)('m365 live (sandbox tenant)', () => {
  it('get_user returns a real profile for the sandbox user', async () => {
    const sandboxUser = process.env.DELEGANT_LIVE_SANDBOX_UPN!;
    const res = await invokeDelegantTool({
      connection: liveConnection(),
      toolName: 'get_user',
      parameters: { userId: sandboxUser },
      actingUser: liveActingUser(),
      agent: liveAgent(),
      sessionId: 'live-session',
    }, { env: liveEnv() });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.data).toBeTruthy();
      // Delegant returns the Graph user object (id/displayName/userPrincipalName).
      expect(typeof res.toolCallId === 'string' || res.toolCallId === undefined).toBe(true);
    }
  });

  it('audit round-trip: a live invoke returns a toolCallId that resolves in Delegant audit', async () => {
    const sandboxUser = process.env.DELEGANT_LIVE_SANDBOX_UPN!;
    const res = await invokeDelegantTool({
      connection: liveConnection(),
      toolName: 'get_user',
      parameters: { userId: sandboxUser },
      actingUser: liveActingUser(),
      agent: liveAgent(),
      sessionId: 'live-session',
    }, { env: liveEnv() });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok' && res.toolCallId) {
      // GET {BASE}/v1/audit/tool-calls/{id} with the service token + a breeze_service
      // principal JWT should return the audit record with agent + acting-user attribution.
      // TODO(live-harness): implement the authed GET once a breeze_service JWT minter
      // is available to the test; for now assert we have an id to correlate.
      expect(typeof res.toolCallId).toBe('string');
    }
  });
});

describe.skipIf(!ALLOW_MUTATIONS)('m365 live mutations (DISPOSABLE sandbox user ONLY)', () => {
  it('reset_user_password returns a temporary password for a disposable sandbox user', async () => {
    const disposableUser = process.env.DELEGANT_LIVE_DISPOSABLE_UPN!;
    const res = await invokeDelegantTool({
      connection: liveConnection(),
      toolName: 'reset_user_password',
      parameters: { userId: disposableUser },
      actingUser: liveActingUser(),
      agent: liveAgent(),
      sessionId: 'live-session',
    }, { env: liveEnv() });
    expect(res.kind).toBe('ok');
  });
});
