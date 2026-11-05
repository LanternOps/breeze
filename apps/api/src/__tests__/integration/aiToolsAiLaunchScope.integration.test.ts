/**
 * Integration test — W16 PR A (#6786): the two launch tools against real Postgres as the unprivileged `breeze_app`
 * role, through `executeTool` (the production dispatch), with the release context a real release supplies.
 *
 * Proven:
 *   - create_operator_task as a site-restricted member against a device in another site of the same org is not
 *     found, and no task row exists; CONTROL: the same device for an unrestricted member admits one queued task;
 *   - a retried release of one intent returns the same task id (`replayed: true`) under real admission (the partial
 *     unique index on the idempotency key), and a second approved intent is a second task;
 *   - run_patch_plan for an organization of another partner is not found, with no run row; CONTROL: the caller's
 *     own org admits a device-less patch run, and a retried release of the same intent is that run, not a second.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiOperatorTasks } from '../../db/schema';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { registerAgentRunEnqueuer, type AgentRunEnqueuer } from '../../services/aiAgents/runService';
import { clearPermissionCache } from '../../services/permissions';
import {
  assignUserToOrganization, createDevice, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

function orgAuth(userId: string, partnerId: string, orgId: string, siteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'fixture-tech@example.com', name: 'Fixture Tech', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    scope: 'organization', orgId, partnerId, accessibleOrgIds: [orgId],
    orgCondition: (column: Parameters<typeof eq>[0]) => eq(column, orgId),
    canAccessOrg: (id: string) => id === orgId,
    ...(siteIds
      ? { allowedSiteIds: siteIds, canAccessSite: (id: string | null) => id !== null && siteIds.includes(id) }
      : { canAccessSite: () => true }),
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
  } as unknown as AuthContext;
}

function contextOf(auth: AuthContext) {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
}

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext, actionIntentId?: string) {
  const raw = await withDbAccessContext(contextOf(auth), () =>
    executeTool(tool, input, auth, actionIntentId ? { context: { actionIntentId } } : undefined));
  return JSON.parse(raw) as Record<string, any>;
}

const tasksOf = (orgId: string) => withSystemDbAccessContext(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.orgId, orgId)));
const runsOf = (orgId: string) => withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, orgId)));

async function baseline(partnerId: string, createdBy: string, kind: 'triage' | 'patch') {
  const [agent] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
    orgId: null, partnerId, kind, name: `W16A ${kind}`, enabled: true, createdBy, limits: {},
    ...(kind === 'patch' ? { mode: 'shadow' as const } : {}),
  }).returning());
  return agent!.id;
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const deviceB = await createDevice({ orgId: org.id, siteId: siteB.id, hostname: `w16a-host-${randomUUID().slice(0, 8)}` });

  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id, name: `W16A ${randomUUID()}` });
  await grantRolePermissions(role.id, [{ resource: 'ai_agents', action: 'read' }, { resource: 'ai_agents', action: 'write' }]);
  const tech = await createUser({ partnerId: partner.id, orgId: org.id, email: `w16a-tech-${randomUUID()}@example.com` });
  await assignUserToOrganization(tech.id, org.id, role.id);
  const restricted = await createUser({ partnerId: partner.id, orgId: org.id, email: `w16a-site-${randomUUID()}@example.com` });
  await assignUserToOrganization(restricted.id, org.id, role.id);
  await getTestDb().execute(sql`UPDATE organization_users SET site_ids = ARRAY[${siteA.id}]::uuid[] WHERE user_id = ${restricted.id} AND org_id = ${org.id}`);

  const otherPartner = await createPartner();
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id });

  await baseline(partner.id, tech.id, 'triage');
  await baseline(partner.id, tech.id, 'patch');

  return {
    org, foreignOrg, siteA, siteB, deviceB,
    auth: {
      tech: orgAuth(tech.id, partner.id, org.id),
      restricted: orgAuth(restricted.id, partner.id, org.id, [siteA.id]),
    },
  };
}

let f: Awaited<ReturnType<typeof seed>>;
let enqueued: string[] = [];
beforeEach(async () => {
  clearPermissionCache();
  process.env.AI_OPERATOR_TASKS_ENABLED = 'true';
  process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED = 'true';
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  enqueued = [];
  const enqueuer: AgentRunEnqueuer = async (runId) => {
    enqueued.push(runId);
    return { enqueued: true, jobId: `agent-run-${runId}` };
  };
  registerAgentRunEnqueuer(enqueuer);
  f = await seed();
});
afterEach(() => {
  delete process.env.AI_OPERATOR_TASKS_ENABLED;
  delete process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED;
  vi.unstubAllEnvs();
  registerAgentRunEnqueuer(null);
});

describe('create_operator_task (#6786)', () => {
  it('a site-restricted member cannot delegate against a device in another site: not found, no task row', async () => {
    const out = await run('create_operator_task', { orgId: f.org.id, deviceId: f.deviceB.id, serviceName: 'Spooler' }, f.auth.restricted, randomUUID());
    expect(out.code ?? out.error).toBeTruthy();
    expect(JSON.stringify(out)).toMatch(/not found/i);
    expect(out).not.toHaveProperty('taskId');
    expect(await tasksOf(f.org.id)).toHaveLength(0);
  });

  it('CONTROL: an unrestricted member admits one queued service-recovery task for the same device', async () => {
    const out = await run('create_operator_task', { orgId: f.org.id, deviceId: f.deviceB.id, serviceName: 'Spooler' }, f.auth.tech, randomUUID());
    expect(out).toMatchObject({ taskId: expect.any(String), replayed: false });
    const rows = await tasksOf(f.org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.taskId, deviceId: f.deviceB.id, workflowKey: 'service_recovery', state: 'queued' });
  });

  it('a retried release replays the first task under real admission; a second approved intent is a second task', async () => {
    const input = { orgId: f.org.id, deviceId: f.deviceB.id, serviceName: 'Spooler' };
    const intent = randomUUID();
    const first = await run('create_operator_task', input, f.auth.tech, intent);
    const retry = await run('create_operator_task', input, f.auth.tech, intent);
    expect(retry).toMatchObject({ taskId: first.taskId, replayed: true });
    expect(await tasksOf(f.org.id)).toHaveLength(1);

    const second = await run('create_operator_task', input, f.auth.tech, randomUUID());
    expect(second.taskId).not.toBe(first.taskId);
    expect(await tasksOf(f.org.id)).toHaveLength(2);
  });
});

describe('run_patch_plan (#6786)', () => {
  it('an organization of another partner is not found, and no run row is written', async () => {
    const out = await run('run_patch_plan', { orgId: f.foreignOrg.id }, f.auth.tech, randomUUID());
    expect(out.code).toBe('NOT_FOUND');
    expect(await runsOf(f.foreignOrg.id)).toHaveLength(0);
  });

  it('CONTROL: the caller\'s org admits one device-less patch run, and a retried release is that run', async () => {
    const intent = randomUUID();
    const out = await run('run_patch_plan', { orgId: f.org.id }, f.auth.tech, intent);
    expect(out).toMatchObject({ queued: true, runId: expect.any(String) });
    const retry = await run('run_patch_plan', { orgId: f.org.id }, f.auth.tech, intent);
    expect(retry).toMatchObject({ queued: true, runId: out.runId, replayed: true });

    const rows = await runsOf(f.org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.runId, profile: 'patch', deviceId: null, dedupeKey: `patch-ai-tool-${intent}` });
    expect(enqueued).toEqual([out.runId]);
  });
});
