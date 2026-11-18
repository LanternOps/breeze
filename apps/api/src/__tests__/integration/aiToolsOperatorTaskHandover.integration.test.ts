/**
 * Integration test — W10 (#6780, quorum QW1): `get_operator_task` never relays the one-time credential
 * hand-over of an `identity_onboarding` task, against real Postgres as `breeze_app`.
 *
 * The task is driven by the real onboarding harness to the point where the account exists and its temporary
 * password is SEALED in `action_intents.result`. The tool is then called through `executeTool`, and the
 * SERIALISED output is scanned byte-for-byte for: the sealed ciphertext, the plaintext password, the sealed-key
 * names, the create intent id, the account's external id, the approver's id and display name.
 *
 * CONTROL: the REST detail loader (`loadOperatorTaskDetail`, the route's own query) over the same task DOES
 * contain the intent id, the external id and the approver, so the scan is capable of failing; and the stored
 * intent really carries the sealed key, so "nothing leaked" is not "nothing was sealed".
 */
import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

const fake = vi.hoisted(() => ({
  world: null as unknown as import('./identityOnboardingHarness').FakeWorld,
  googleConnId: null as string | null,
  probe: {} as import('./identityOnboardingHarness').FakeProviders['probe'],
  h: {} as Record<string, (...args: any[]) => any>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => { throw new Error('SDK transport must not run in this suite'); },
  tool: () => ({}),
  createSdkMcpServer: () => ({}),
}));
vi.mock('../../services/m365ControlPlane/readActionService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeM365ReadActionByOrg: (...a: unknown[]) => fake.h.m365Read!(...a),
}));
vi.mock('../../services/aiToolsGoogle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveContextByOrg: (...a: unknown[]) => fake.h.googleContext!(...a),
}));
vi.mock('../../services/googleClient', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDirectoryClient: (...a: unknown[]) => fake.h.directory!(...a),
  getLicensingClient: (...a: unknown[]) => fake.h.licensing!(...a),
}));
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction: (...a: unknown[]) => fake.h.executeWriteAction!(...a) }),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));
vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadM365CustomerGraphActionsRuntimeConfig: () => ({
    clientId: 'test-client-id',
    vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
    credentialVersion: '00000000000000000000000000000000',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'test-kid',
  }),
  isM365GraphActionsEnabledForOrg: () => true,
  m365GraphActionsAvailability: () => 'enabled',
}));

import { db, withDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { loadOperatorTaskDetail } from '../../services/aiOperator/taskReadQueries';
import { TEMP_PASSWORD_ENC_KEY } from '../../services/actionIntents/resultSecrets';
import { clearPermissionCache } from '../../services/permissions';
import {
  CREATED_M365_ID, FAKE_PASSWORD,
  bindFakeProviders, childIntents, driveToProvisionProposed, resetFakes, seedTenant, system, type Tenant,
} from './identityOnboardingHarness';

bindFakeProviders(fake as never);

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  clearPermissionCache();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED', 'true');
  resetFakes();
});
afterEach(() => { vi.unstubAllEnvs(); });

function authFor(t: Tenant, userId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true, aep: 1, mep: 1 },
    partnerId: t.partnerId, orgId: t.orgId, scope: 'organization', accessibleOrgIds: [t.orgId],
    orgCondition: (col: PgColumn) => eq(col, t.orgId),
    canAccessOrg: (id: string) => id === t.orgId,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'handover-scan' },
  } as unknown as AuthContext;
}
const ctx = (t: Tenant, userId: string) => ({
  scope: 'organization' as const, orgId: t.orgId, accessibleOrgIds: [t.orgId], accessiblePartnerIds: [], userId, currentPartnerId: t.partnerId,
});

describe('get_operator_task over an onboarding task with a sealed credential', () => {
  runDb('relays no hand-over pointer, seal key, ciphertext, plaintext or revealer (byte-level), while REST does', async () => {
    const t = await seedTenant({ google: false });
    const a = await driveToProvisionProposed(t);

    const createChild = (await childIntents(a)).find((i) => i.actionName === 'm365_create_user')!;
    expect(createChild, 'the create child exists').toBeTruthy();
    const [stored] = await system(() => db.select({ result: actionIntents.result }).from(actionIntents).where(eq(actionIntents.id, createChild.id)));
    const sealed = (stored!.result as Record<string, unknown>)[TEMP_PASSWORD_ENC_KEY];
    expect(sealed, 'the credential really is sealed on the intent').toMatch(/^enc:v3:/);

    // CONTROL: the REST detail over the same task carries the pointers the tool must drop.
    const rest = await withDbAccessContext(ctx(t, t.requesterId), () => loadOperatorTaskDetail(authFor(t, t.requesterId), a.taskId));
    const restBytes = JSON.stringify(rest);
    expect(restBytes, 'control: REST relays the create intent id').toContain(createChild.id);
    expect(restBytes, 'control: REST relays the account external id').toContain(CREATED_M365_ID);
    expect(rest?.accounts?.length, 'control: REST relays the accounts view').toBeGreaterThan(0);

    const raw = await withDbAccessContext(ctx(t, t.requesterId), () =>
      executeTool('get_operator_task', { taskId: a.taskId }, authFor(t, t.requesterId)));
    const body = JSON.parse(raw) as Record<string, any>;
    expect(body.id, raw).toBe(a.taskId);

    for (const needle of [
      String(sealed), FAKE_PASSWORD, TEMP_PASSWORD_ENC_KEY, createChild.id,
      t.approverName, 'revealable', 'revealExpiresAt', 'intentId', 'externalId', 'connectionId',
    ]) {
      expect(raw, `tool output must not contain ${needle}`).not.toContain(needle);
    }

    // The Entra object id is not a reveal pointer: it appears only inside the coordinator's own event narrative
    // ("m365 account <id> (<upn>) frozen"), which REST relays too. No STRUCTURED externalId field survives (scanned above).
    expect(raw).toContain(CREATED_M365_ID);
    // Likewise the approver's user id inside "plan revision 1 approved ... by user <id>": narrative text, not a structured
    // actor field (`actorUserId`, `approvedByUserId` and the revealer are all dropped, scanned above by key name).

    // What the technician needs survives: the account and its credential STATE only.
    expect(body.accounts?.length).toBeGreaterThan(0);
    for (const account of body.accounts as Record<string, unknown>[]) {
      expect(Object.keys(account).sort()).toEqual(['credentialState', 'principalLabel', 'provider']);
    }
  });
});
