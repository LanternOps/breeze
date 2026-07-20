/**
 * Real-Postgres proof that the durable release worker executes an M365
 * Tier-3 tool (m365_disable_user / m365_reset_password) HEADLESSLY via the
 * control-plane customer-graph-actions write-action ladder
 * (writeActionService.executeM365WriteActionByOrg, Task 8) instead of
 * false-failing it `session_required` — the vertical-slice closer for the
 * M365 customer-graph-actions executor (Task 9).
 *
 * Mirrors intentReleaseWorkerGoogleHeadless.integration.test.ts 1:1 in
 * structure: the mocked unit suite (intentReleaseWorker.test.ts) mocks
 * `../services/m365ToolsHeadless` wholesale, so it can never prove the real
 * connection load + org-scoped RLS read + budget consumption + intent
 * lifecycle line up against real Postgres/Redis. This suite does, mocking
 * ONLY the Graph-actions executor client at the network boundary
 * (createGraphActionsExecutorClient) — the real
 * executeM365WriteActionByOrg authz ladder (feature flag -> connection load
 * -> readiness -> budget -> executor call) runs for real.
 *
 * As with the Google suite, the intent is built with `createActionIntent`
 * (correct canonical digest + a real winning approval_requests row) and the
 * requester's org role is granted the tool's `m365.execute` permission, and
 * the org is active — so `revalidateApprovedIntentForRelease` returns ok and
 * control reaches the M365 dispatch.
 *
 * Co-located with the worker it exercises, so it must be named explicitly in
 * BOTH vitest.integration.config.ts (`include`) and vitest.config.ts
 * (`exclude`) — the same dual hand-list the Google sibling test uses. Miss
 * either edit and it silently never runs in CI, or reds the no-DB unit job on
 * ECONNREFUSED.
 */
import '../__tests__/integration/setup';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

// Mock the Graph-actions executor client at construction ONLY. The real
// feature-flag check, connection load (RLS-scoped), readiness ladder, and
// budget consumption in writeActionService.ts all still run for real against
// Postgres/Redis — only the outbound call to the executor is faked. Hoisted
// so the (hoisted) vi.mock factory can close over the same spy the
// assertions read.
const h = vi.hoisted(() => {
  const executeWriteAction = vi.fn();
  return { executeWriteAction };
});

vi.mock('../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction: h.executeWriteAction }),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));

// --- M365 customer-graph-actions runtime config -----------------------------
// loadM365CustomerGraphActionsRuntimeConfig() runs for real (unmocked) inside
// writeActionService.ts even though the executor client itself is mocked
// above, so its env-var validation (incl. reading a real signing-key file
// from disk) must be satisfied. The key material itself is never used for
// real signing (the mocked client ignores its config entirely), so a fixed
// fake Ed25519 JWK is fine — same fixture writeActionRuntimeConfig.test.ts
// uses.
const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CREDENTIAL_VERSION = '0123456789abcdef0123456789abcdef';
let tempDir: string;
let signingJwkFile: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'breeze-m365-actions-worker-it-'));
  signingJwkFile = join(tempDir, 'executor-signing.jwk');
  writeFileSync(signingJwkFile, JSON.stringify({
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid: 'graph-actions-api-1',
    x: Buffer.alloc(32, 1).toString('base64url'),
    d: Buffer.alloc(32, 2).toString('base64url'),
  }), { mode: 0o600 });
  chmodSync(signingJwkFile, 0o600);

  process.env.M365_GRAPH_ACTIONS_TOOLS_ENABLED = 'true';
  process.env.M365_GRAPH_ACTIONS_TOOLS_ORG_IDS = '*';
  process.env.M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID = CLIENT_ID;
  process.env.M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION = CREDENTIAL_VERSION;
  process.env.M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF =
    `akv://customer-vault.vault.azure.net/m365-customer-graph-actions/${CREDENTIAL_VERSION}`;
  process.env.M365_GRAPH_ACTIONS_EXECUTOR_URL = 'https://m365-graph-actions.internal.example.test';
  process.env.M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE = 'm365-graph-actions-executor';
  process.env.M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE = signingJwkFile;
  process.env.M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID = 'graph-actions-api-1';
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

import { db, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { createActionIntent, transitionIntent } from '../services/actionIntents/intentService';
import { seedActionsConnection } from '../services/m365ControlPlane/__testHelpers__/seedActionsConnection';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  assignUserToOrganization,
  grantRolePermissions,
} from '../__tests__/integration/db-utils';
import { releaseApprovedIntent } from './intentReleaseWorker';

// m365_disable_user / m365_reset_password → { resource: 'm365', action:
// 'execute' } in aiGuardrails.TOOL_PERMISSIONS. revalidation step (e)
// re-checks the REQUESTER still holds this against their freshly-rebuilt
// role, so the requester's org role must carry it or release fails
// `rbac_denied` (not the M365 path).
const M365_EXECUTE = { resource: 'm365', action: 'execute' } as const;
const APPROVALS_DECIDE = { resource: 'approvals', action: 'decide' } as const;

/** Real org-scope AuthContext for the requester, same shape authMiddleware
 * produces (reuses buildOrgAccessClosures so org-access semantics can't drift
 * from the live path). Mirrors the Google headless sibling's helper. */
function requesterAuth(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    user: { id: user.id, email: user.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId,
      orgId,
      partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

interface Scenario {
  orgId: string;
  intentId: string;
}

/**
 * Seeds partner + active org + a requester (holding m365.execute) + a second
 * eligible approver (holding approvals.decide), creates a real M365 Tier-3
 * intent via createActionIntent, then drives it to a GENUINE `approved`
 * state that PASSES release-time revalidation. Does NOT seed the M365
 * customer-graph-actions connection — each case seeds/omits that itself.
 */
async function seedApprovedM365Intent(
  toolName: 'm365_disable_user' | 'm365_reset_password',
): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [M365_EXECUTE]);

  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [APPROVALS_DECIDE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@m365.test`,
  });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);

  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@m365.test`,
  });
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  const auth = requesterAuth(
    { id: requester.id, email: requester.email },
    org.id,
    partner.id,
    requesterRole.id,
  );

  const snapshot = await createActionIntent(auth, {
    toolName,
    input: { userIdentifier: 'target@customer.example', reason: 'offboarding' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  expect(snapshot.approvalRequestIds.length).toBeGreaterThan(0);

  await withSystemDbAccessContext(async () => {
    await db
      .update(approvalRequests)
      .set({ status: 'approved' })
      .where(eq(approvalRequests.intentId, snapshot.id));
  });
  const promoted = await transitionIntent(snapshot.id, 'pending_approval', 'approved', {
    decidedAt: new Date(),
    decidedByUserId: approver.id,
  });
  expect(promoted).toBe(true);

  return { orgId: org.id, intentId: snapshot.id };
}

async function readIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId))
      .limit(1);
    return row!;
  });
}

beforeEach(() => {
  h.executeWriteAction.mockReset();
});

describe('releaseApprovedIntent headless M365 dispatch (real Postgres, breeze_app)', () => {
  it('disables a user headlessly and completes the intent — NOT session_required', async () => {
    const { orgId, intentId } = await seedApprovedM365Intent('m365_disable_user');
    await seedActionsConnection({ orgId, tenantId: randomUUID(), status: 'active' });

    h.executeWriteAction.mockResolvedValue({ success: true, action: 'm365.user.disable', userId: 'u1' });

    await releaseApprovedIntent(intentId);

    // Core proof #1: the real write-action mutation actually fired (headless
    // execution happened, not a skip/fail before execution).
    expect(h.executeWriteAction).toHaveBeenCalledTimes(1);
    expect(h.executeWriteAction).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: intentId,
        tenantId: expect.any(String),
        action: { type: 'm365.user.disable', userIdentifier: 'target@customer.example', reason: 'offboarding' },
      }),
    );

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('completed');
    expect(intent.errorCode).toBeNull();
    expect(intent.executedAt).not.toBeNull();
    expect(intent.result).toMatchObject({ success: true, userId: 'u1' });
    // Discriminating proof: not the pre-Task-9 false-fail.
    expect(intent.errorCode).not.toBe('session_required');
  });

  it('resets a password headlessly and stores temporaryPassword in intent.result', async () => {
    const { orgId, intentId } = await seedApprovedM365Intent('m365_reset_password');
    await seedActionsConnection({ orgId, tenantId: randomUUID(), status: 'active' });

    h.executeWriteAction.mockResolvedValue({
      success: true,
      action: 'm365.user.reset_password',
      userId: 'u1',
      temporaryPassword: 'Tmp!23xyz789',
      forceChangeNextSignIn: true,
    });

    await releaseApprovedIntent(intentId);

    expect(h.executeWriteAction).toHaveBeenCalledTimes(1);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('completed');
    expect(intent.result).toMatchObject({ success: true, temporaryPassword: 'Tmp!23xyz789' });
  });

  it('revoked connection: fails connection_unavailable with NO executor call', async () => {
    const { orgId, intentId } = await seedApprovedM365Intent('m365_disable_user');
    // Connection exists but was revoked during the approval wait —
    // executeM365WriteActionByOrg refuses a non-'active' status, so the
    // seam throws M365ConnectionUnavailableError and the worker fails closed
    // BEFORE any outbound Graph call.
    await seedActionsConnection({ orgId, tenantId: randomUUID(), status: 'revoked' });

    await releaseApprovedIntent(intentId);

    expect(h.executeWriteAction).not.toHaveBeenCalled();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('connection_unavailable');
  });

  it('no connection at all: fails connection_unavailable with NO executor call', async () => {
    const { intentId } = await seedApprovedM365Intent('m365_disable_user');
    // Deliberately no seedActionsConnection call for this org.

    await releaseApprovedIntent(intentId);

    expect(h.executeWriteAction).not.toHaveBeenCalled();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('connection_unavailable');
  });

  it('wrong-org connection: a connection belonging to a DIFFERENT org fails closed with NO executor call', async () => {
    const { intentId } = await seedApprovedM365Intent('m365_disable_user');
    // Seed an active connection for an entirely unrelated org — the RLS +
    // eq(orgId) filter in executeM365WriteActionByOrg must never let this
    // satisfy the intent's own org's lookup.
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    await seedActionsConnection({ orgId: otherOrg.id, tenantId: randomUUID(), status: 'active' });

    await releaseApprovedIntent(intentId);

    expect(h.executeWriteAction).not.toHaveBeenCalled();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('connection_unavailable');
  });

  it('no longer fails session_required for m365_disable_user / m365_reset_password with an active connection', async () => {
    for (const toolName of ['m365_disable_user', 'm365_reset_password'] as const) {
      const { orgId, intentId } = await seedApprovedM365Intent(toolName);
      await seedActionsConnection({ orgId, tenantId: randomUUID(), status: 'active' });
      h.executeWriteAction.mockResolvedValue(
        toolName === 'm365_disable_user'
          ? { success: true, action: 'm365.user.disable', userId: 'u1' }
          : { success: true, action: 'm365.user.reset_password', userId: 'u1', temporaryPassword: 'x', forceChangeNextSignIn: true },
      );

      await releaseApprovedIntent(intentId);

      const intent = await readIntent(intentId);
      expect(intent.errorCode).not.toBe('session_required');
    }
  });
});
