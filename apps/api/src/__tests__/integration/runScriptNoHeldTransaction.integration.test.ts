import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiSessions, deviceCommands, devices, scriptProposals, scripts } from '../../db/schema';
import { buildOrgAccessClosures, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { createScriptProposal } from '../../services/scriptProposals';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

/**
 * #7918 — `run_script` through the REAL chat/agent-run tool wrapper
 * (`aiAgentSdkTools.makeHandler`) against real Postgres.
 *
 * The wrapper used to run the whole handler in ONE `withDbAccessContext`
 * transaction. The handler then waited up to 60 s per device for the agent's
 * result, so the pooled connection sat idle in transaction for the whole run.
 * Production Postgres kills such a session after 1 minute
 * (`idle_in_transaction_session_timeout`), so a script that took longer than
 * that failed with `CONNECTION_CLOSED` while it actually completed on the
 * device.
 *
 * The invariant this suite pins is the cause, not the symptom: while the
 * handler waits for the device, NO connection is idle in transaction. A held
 * transaction, however short the agent takes, is what the server-side timeout
 * kills. The control at the bottom proves the probe is not vacuous.
 *
 * Only the agent is faked: a background task finds the command the tool
 * queued, samples `pg_stat_activity` while the tool is waiting on it, and then
 * completes the row the way the agent-WS result handler does. Device access,
 * RLS, proposal runnability, dispatch and the poll are all real, and the code
 * under test connects as the unprivileged `breeze_app` role — a DB phase left
 * contextless by the opt-out would read zero rows and answer "Device not found".
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiScriptAuthoringEnabled: () => true,
}));

import { __test__ as sdkToolsTest } from '../../services/aiAgentSdkTools';
import { executeTool } from '../../services/aiTools';

type Scope = 'organization' | 'partner';

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `run-script-${randomUUID()}@example.test` });
  // Delivery revalidation re-reads the REQUESTER's live scripts:execute grant
  // and cancels the command (`scope_changed`) without one, so the requester
  // must be a real member of the org with that permission.
  const role = await withSystemDbAccessContext(() => createRole({ scope: 'organization', orgId: org.id }));
  await withSystemDbAccessContext(() => grantRolePermissions(role.id, [PERMISSIONS.SCRIPTS_EXECUTE]));
  await withSystemDbAccessContext(() => assignUserToOrganization(user.id, org.id, role.id));
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: `run-script-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
      // trigger_agent_restart targets the watchdog, which must be reporting.
      watchdogLastSeen: new Date(),
    })
    .returning({ id: devices.id });
  // `script_executions.ai_session_id` references a real chat session.
  const [session] = await getTestDb().insert(aiSessions).values({
    orgId: org.id, userId: user.id, title: 'run-script-7918', model: 'claude-sonnet-5-5',
  }).returning({ id: aiSessions.id });
  return { partnerId: partner.id, orgId: org.id, userId: user.id, deviceId: device!.id, sessionId: session!.id };
}

function callerAuth(orgId: string, partnerId: string, userId: string, scope: Scope, sessionId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: `${userId}@example.test`, name: 'Test User', isPlatformAdmin: false },
    token: {
      sub: userId, email: `${userId}@example.test`, roleId: null,
      orgId: scope === 'organization' ? orgId : null, partnerId, scope, type: 'access', mfa: true,
    },
    partnerId,
    // A partner-scope token carries no orgId — the shape of the prod incident.
    orgId: scope === 'organization' ? orgId : null,
    scope,
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
    aiOrigin: { kind: 'ai_assistant', sessionId },
  } as unknown as AuthContext;
}

async function seedReviewedProposal(auth: AuthContext, orgId: string, deviceId: string): Promise<string> {
  const { proposal } = await withDbAccessContext(dbAccessContextFromAuth(auth), () =>
    createScriptProposal(auth, {
      language: 'powershell', content: 'Get-Process | Select-Object -First 1', goal: 'Read RAM use',
      expectedEffect: 'Nothing changes', verification: { kind: 'exit_code', equals: 0 },
      deviceIds: [deviceId], runAs: 'system', timeoutSeconds: 300,
    }, { kind: 'chat_session', sessionId: null }, orgId));
  await withSystemDbAccessContext(() => db.update(scriptProposals)
    .set({ status: 'reviewed', riskTier: 'low' }).where(eq(scriptProposals.id, proposal.id)));
  return proposal.id;
}

async function seedLibraryScript(orgId: string): Promise<string> {
  const [row] = await getTestDb().insert(scripts).values({
    orgId,
    name: `ram-${randomUUID().slice(0, 8)}`,
    language: 'powershell',
    osTypes: ['windows'],
    content: 'Get-Process | Select-Object -First 1',
  } as typeof scripts.$inferInsert).returning({ id: scripts.id });
  return row!.id;
}

async function idleInTransactionCount(): Promise<number> {
  const rows = await getTestDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

/**
 * Plays the agent: waits for the tool to queue a script command for
 * `deviceId`, lets the tool settle into its result poll, samples
 * `pg_stat_activity`, then writes the result.
 */
function fakeAgent(deviceId: string): { idleDuringWait: Promise<number> } {
  const idleDuringWait = (async () => {
    const deadline = Date.now() + 20_000;
    let commandId: string | undefined;
    while (!commandId && Date.now() < deadline) {
      const [row] = await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)
        .where(and(eq(deviceCommands.deviceId, deviceId), inArray(deviceCommands.status, ['pending', 'sent'])))
        .limit(1);
      commandId = row?.id;
      if (!commandId) await new Promise((r) => setTimeout(r, 100));
    }
    if (!commandId) throw new Error('the tool never queued a command');
    // Several poll intervals (500 ms) into the tool's wait.
    await new Promise((r) => setTimeout(r, 1_500));
    const idle = await idleInTransactionCount();
    await getTestDb().update(deviceCommands).set({
      status: 'completed',
      completedAt: new Date(),
      result: { status: 'completed', exitCode: 0, stdout: 'ram-ok', stderr: '', durationMs: 99_000 },
    }).where(eq(deviceCommands.id, commandId));
    return idle;
  })();
  return { idleDuringWait };
}

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): Record<string, any> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // The probe reads OTHER roles' backends (the code under test connects as
  // breeze_app). Without superuser or pg_read_all_stats their `state` is NULL
  // and every assertion below would pass vacuously.
  const [priv] = (await getTestDb().execute(sql`
    SELECT (rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'member')) AS ok
    FROM pg_roles WHERE rolname = current_user`)) as unknown as Array<{ ok: boolean }>;
  expect(priv?.ok).toBe(true);
});

runDb.each(['organization', 'partner'] as const)('a %s-scope run_script { proposalId } holds no transaction across the device wait and returns the run (#7918)', async (scope) => {
  const { orgId, partnerId, userId, deviceId, sessionId } = await seed();
  const auth = callerAuth(orgId, partnerId, userId, scope, sessionId);
  const proposalId = await seedReviewedProposal(auth, orgId, deviceId);
  const agent = fakeAgent(deviceId);

  const handler = sdkToolsTest.makeHandler('run_script', () => auth);
  const out = parseToolText(await handler({ proposalId, deviceIds: [deviceId] }));

  expect(await agent.idleDuringWait).toBe(0);
  expect(out.proposalId).toBe(proposalId);
  expect(out.results[deviceId]).toMatchObject({
    status: 'completed', exitCode: 0, stdout: 'ram-ok',
    commandId: expect.any(String), executionId: expect.any(String),
  });
  // The run moved the proposal on — the transition ran in a context that
  // committed, not in one the wrapper would have rolled back.
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: scriptProposals.status }).from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(row?.status).toBe('executed');
}, 60_000);

runDb('a library run_script { scriptId } holds no transaction across the device wait and returns the run (#7918)', async () => {
  const { orgId, partnerId, userId, deviceId, sessionId } = await seed();
  const auth = callerAuth(orgId, partnerId, userId, 'organization', sessionId);
  const scriptId = await seedLibraryScript(orgId);
  const agent = fakeAgent(deviceId);

  const handler = sdkToolsTest.makeHandler('run_script', () => auth);
  const out = parseToolText(await handler({ scriptId, deviceIds: [deviceId] }));

  expect(await agent.idleDuringWait).toBe(0);
  expect(out.results[deviceId]).toMatchObject({
    status: 'completed', exitCode: 0, stdout: 'ram-ok',
    commandId: expect.any(String), executionId: expect.any(String),
  });
}, 60_000);

runDb('a library run_script still refuses a device outside the caller org when it opens its own contexts (#7918)', async () => {
  const mine = await seed();
  const other = await seed();
  const auth = callerAuth(mine.orgId, mine.partnerId, mine.userId, 'organization', mine.sessionId);
  const scriptId = await seedLibraryScript(mine.orgId);

  const handler = sdkToolsTest.makeHandler('run_script', () => auth);
  const out = parseToolText(await handler({ scriptId, deviceIds: [other.deviceId] }));

  expect(JSON.stringify(out)).toContain('Device not found or access denied');
  const queued = await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands)
    .where(eq(deviceCommands.deviceId, other.deviceId));
  expect(queued).toHaveLength(0);
}, 30_000);

// The other self-managed device tools reach the device through
// `aiExecuteCommand`, whose precheck now opens a short context of the
// CALLER's own scope when none is held (`executeCommandWithCallerPrecheck`).
// One tool per shape: a single online-device wait, and the watchdog loop over
// a device list whose access checks run in one `inToolDbPhase` block.
runDb.each([
  ['network_discovery', (deviceId: string) => ({ deviceId, subnet: '192.0.2.0/24' })],
  ['trigger_agent_restart', (deviceId: string) => ({ deviceIds: [deviceId] })],
] as const)('%s through the SDK wrapper holds no transaction across the device wait (#7918)', async (tool, args) => {
  const { orgId, partnerId, userId, deviceId, sessionId } = await seed();
  const auth = callerAuth(orgId, partnerId, userId, 'organization', sessionId);
  const agent = fakeAgent(deviceId);

  const out = parseToolText(await sdkToolsTest.makeHandler(tool, () => auth)(args(deviceId)));

  expect(await agent.idleDuringWait).toBe(0);
  // The device resolved under RLS (a contextless read would have answered
  // "Device not found") and the agent's result came back.
  expect(JSON.stringify(out)).not.toMatch(/not found|access denied/i);
  if (tool === 'network_discovery') expect(out).toMatchObject({ status: 'completed' });
  else expect(out).toMatchObject({ queued: 1 });
}, 60_000);

// Control: a caller that DOES hold a transaction around the tool (the shape
// every tool call had before #7918) is visible to the probe. Without this, a
// probe that could never see the code under test would pass the cases above.
runDb('control: a caller-held transaction around run_script is seen by the probe', async () => {
  const { orgId, partnerId, userId, deviceId, sessionId } = await seed();
  const auth = callerAuth(orgId, partnerId, userId, 'organization', sessionId);
  const scriptId = await seedLibraryScript(orgId);
  const agent = fakeAgent(deviceId);

  const raw = await withDbAccessContext(dbAccessContextFromAuth(auth), () =>
    executeTool('run_script', { scriptId, deviceIds: [deviceId] }, auth));

  expect(await agent.idleDuringWait).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(raw).results[deviceId]).toMatchObject({ status: 'completed', stdout: 'ram-ok' });
}, 60_000);
