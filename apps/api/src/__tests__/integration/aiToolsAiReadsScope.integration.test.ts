/**
 * Integration test — W10 (#6780) get_device_ai_activity, list/get_operator_task, list_ai_agent_schedules and
 * list/get_fleet_design honour the org axis, the site axis and the restricted-session refusals against real
 * Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, so the same dispatch as production runs (permission floor and the `deviceArgs` gate
 * included). Proven against stored rows, not only the tool's reply:
 *   - device AI activity: an out-of-site device and a missing one are one byte-identical answer; counts are the
 *     device's own (a sibling's AI commands are not added);
 *   - operator tasks: another org's task is "not found" and absent from the list; a site- or device-restricted
 *     session is refused outright (the REST site gate checks only the root task);
 *   - fleet designs: another org's design is "not found" and absent from the list; restricted sessions are refused;
 *   - agent schedules: another org id is "not found".
 * Each refusal has a CONTROL: lifting the guard (the unrestricted / owning caller, same input) lands the read,
 * so the refusal is the gate and not a broken fixture. The sealed-handover byte scan is its own suite
 * (aiToolsOperatorTaskHandover.integration.test.ts).
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext,
} from '../../db';
import { aiAgents, aiOperatorTasks, deviceCommands, reportRuns, reports } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { persistedSystemSiteScopeValues, systemReportAuthority } from '../../services/siteScope';
import { clearPermissionCache } from '../../services/permissions';
import {
  assignUserToOrganization, createDevice, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';

type Who = 'restricted' | 'orgAll' | 'otherOrg';

interface Fixture {
  partnerId: string; orgA: string; orgB: string; siteA1: string; siteA2: string;
  devA1: string; devA2: string; agentA: string; agentB: string;
  taskA: string; taskB: string; designA: string; designB: string;
  users: Record<Who, string>;
  auth: Record<Who, AuthContext>;
}

const system = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const TOKEN = { mfa: true, aep: 1, mep: 1 } as unknown as AuthContext['token'];
function orgAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: TOKEN,
    partnerId, orgId, scope: 'organization', accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'ai-reads-scope' },
  } as unknown as AuthContext;
}

async function seedDesign(orgId: string, creatorId: string): Promise<string> {
  return system(async () => {
    const [report] = await db.insert(reports).values({
      orgId, name: 'Fleet Design', type: 'ai_fleet_design', schedule: 'one_time', format: 'pdf', createdBy: creatorId,
      ...persistedSystemSiteScopeValues(systemReportAuthority(orgId)),
    } as typeof reports.$inferInsert).returning({ id: reports.id });
    const [runRow] = await db.insert(reportRuns).values({
      reportId: report!.id, orgId, status: 'completed', completedAt: new Date(),
      ...persistedSystemSiteScopeValues(systemReportAuthority(orgId)),
      result: { summary: { fleetDesign: {
        generatedAt: '2026-10-25T00:00:00.000Z', runId: randomUUID(), agentName: 'Designer', evidenceTruncated: false,
        outcome: { markdown: `# Design for ${orgId}`, sections: { functions: [{ name: 'Print server' }], monitoring: [] } },
      } } },
    } as typeof reportRuns.$inferInsert).returning({ id: reportRuns.id });
    return runRow!.id;
  });
}

async function seed(): Promise<Fixture> {
  const p = await createPartner();
  const a = await createOrganization({ partnerId: p.id });
  const b = await createOrganization({ partnerId: p.id });
  const a1 = await createSite({ orgId: a.id, name: 'AI A1' });
  const a2 = await createSite({ orgId: a.id, name: 'AI A2' });
  const b1 = await createSite({ orgId: b.id, name: 'AI B1' });
  const mk = (tag: string, orgId: string) => createUser({ partnerId: p.id, orgId, email: `ai-${tag}-${randomUUID()}@example.com` });
  const uR = await mk('r', a.id);
  const uA = await mk('a', a.id);
  const uB = await mk('b', b.id);
  const grants = [{ resource: 'devices', action: 'read' }, { resource: 'ai_agents', action: 'read' }];
  const roleA = await createRole({ scope: 'organization', orgId: a.id, partnerId: p.id });
  const roleB = await createRole({ scope: 'organization', orgId: b.id, partnerId: p.id });
  await grantRolePermissions(roleA.id, grants);
  await grantRolePermissions(roleB.id, grants);
  await assignUserToOrganization(uR.id, a.id, roleA.id);
  await assignUserToOrganization(uA.id, a.id, roleA.id);
  await assignUserToOrganization(uB.id, b.id, roleB.id);

  const devA1 = await createDevice({ orgId: a.id, siteId: a1.id });
  const devA2 = await createDevice({ orgId: a.id, siteId: a2.id });
  const devB1 = await createDevice({ orgId: b.id, siteId: b1.id });
  await system(async () => {
    // Three AI-dispatched commands on A1, two on A2, one on B1, plus one human command on A1 that must not count.
    const row = (deviceId: string, aiInitiatorKind: 'ai_assistant' | null) => ({ deviceId, type: 'restart_service', aiInitiatorKind });
    await db.insert(deviceCommands).values([
      row(devA1.id, 'ai_assistant'), row(devA1.id, 'ai_assistant'), row(devA1.id, 'ai_assistant'), row(devA1.id, null),
      row(devA2.id, 'ai_assistant'), row(devA2.id, 'ai_assistant'), row(devB1.id, 'ai_assistant'),
    ] as (typeof deviceCommands.$inferInsert)[]);
  });

  const agent = async (orgId: string, createdBy: string) => system(async () => {
    const [row] = await db.insert(aiAgents).values({ orgId, partnerId: null, kind: 'triage', name: 'Triage', createdBy }).returning({ id: aiAgents.id });
    return row!.id;
  });
  const agentA = await agent(a.id, uA.id);
  const agentB = await agent(b.id, uB.id);
  const task = (orgId: string, agentId: string, userId: string) => system(async () => {
    const [row] = await db.insert(aiOperatorTasks).values({
      orgId, agentId, agentKind: 'triage', agentName: 'Triage', workflowKey: 'service_recovery', workflowVersion: 1,
      originKind: 'manual' as const, requesterUserId: userId, objective: `Recover the spooler for ${orgId}`,
    }).returning({ id: aiOperatorTasks.id });
    return row!.id;
  });
  const taskA = await task(a.id, agentA, uA.id);
  const taskB = await task(b.id, agentB, uB.id);
  const designA = await seedDesign(a.id, uA.id);
  const designB = await seedDesign(b.id, uB.id);

  return {
    partnerId: p.id, orgA: a.id, orgB: b.id, siteA1: a1.id, siteA2: a2.id,
    devA1: devA1.id, devA2: devA2.id, agentA, agentB, taskA, taskB, designA, designB,
    users: { restricted: uR.id, orgAll: uA.id, otherOrg: uB.id },
    auth: {
      restricted: orgAuth(uR.id, p.id, a.id, [a1.id]),
      orgAll: orgAuth(uA.id, p.id, a.id),
      otherOrg: orgAuth(uB.id, p.id, b.id),
    },
  };
}

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seed();
});

function ctxFor(who: Who): DbAccessContext {
  const orgId = who === 'otherOrg' ? f.orgB : f.orgA;
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: f.users[who], currentPartnerId: f.partnerId };
}

async function run(who: Who, tool: string, input: Record<string, unknown>, auth?: AuthContext) {
  const raw = await withDbAccessContext(ctxFor(who), () => executeTool(tool, input, auth ?? f.auth[who]));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

describe('get_device_ai_activity', () => {
  it('counts the device\'s own AI-dispatched commands only (CONTROL: the owning caller reads them)', async () => {
    const { body } = await run('orgAll', 'get_device_ai_activity', { device_id: f.devA1 });
    expect(body.activity?.dispatchedActions, JSON.stringify(body)).toBe(3);
    const other = await run('orgAll', 'get_device_ai_activity', { device_id: f.devA2 });
    expect(other.body.activity.dispatchedActions).toBe(2);
  });

  it('an out-of-site device is refused; the same call with the site ceiling lifted lands', async () => {
    const refused = await run('restricted', 'get_device_ai_activity', { device_id: f.devA2 });
    expect(refused.body.activity).toBeUndefined();
    const lifted = await run('orgAll', 'get_device_ai_activity', { device_id: f.devA2 });
    expect(lifted.body.activity.dispatchedActions).toBe(2);
    const inSite = await run('restricted', 'get_device_ai_activity', { device_id: f.devA1 });
    expect(inSite.body.activity.dispatchedActions).toBe(3);
  });

  it('an out-of-site device, another org\'s device and a missing one are the same refusal', async () => {
    const missing = await run('restricted', 'get_device_ai_activity', { device_id: randomUUID() });
    const hidden = await run('restricted', 'get_device_ai_activity', { device_id: f.devA2 });
    const foreign = await run('otherOrg', 'get_device_ai_activity', { device_id: f.devA1 });
    expect(hidden.body.error).toBeTruthy();
    expect(hidden.body.error).toBe(missing.body.error);
    expect(foreign.body.error).toBe(missing.body.error);
    expect(foreign.body.activity).toBeUndefined();
  });

  it('a device-bound caller reads only its own device', async () => {
    const bound = { ...f.auth.orgAll, allowedDeviceIds: [f.devA1] } as unknown as AuthContext;
    expect((await run('orgAll', 'get_device_ai_activity', { device_id: f.devA1 }, bound)).body.activity.dispatchedActions).toBe(3);
    expect((await run('orgAll', 'get_device_ai_activity', { device_id: f.devA2 }, bound)).body.activity).toBeUndefined();
  });
});

describe('operator task reads', () => {
  it('the owning org lists and reads its own task (CONTROL), and never sees another org\'s', async () => {
    const list = await run('orgAll', 'list_operator_tasks', {});
    const ids = (list.body.tasks as { id: string }[]).map((t) => t.id);
    expect(ids, list.raw).toContain(f.taskA);
    expect(ids).not.toContain(f.taskB);
    const own = await run('orgAll', 'get_operator_task', { taskId: f.taskA });
    expect(own.body.id, own.raw).toBe(f.taskA);
  });

  it('another org\'s task, a missing task and a foreign list are one answer', async () => {
    const foreign = await run('orgAll', 'get_operator_task', { taskId: f.taskB });
    const missing = await run('orgAll', 'get_operator_task', { taskId: randomUUID() });
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    const otherList = await run('otherOrg', 'list_operator_tasks', {});
    expect((otherList.body.tasks as { id: string }[]).map((t) => t.id)).toEqual([f.taskB]);
  });

  it('a site-restricted and a device-restricted session are refused outright, though the task has no device', async () => {
    for (const auth of [f.auth.restricted, { ...f.auth.orgAll, allowedDeviceIds: [f.devA1] } as unknown as AuthContext]) {
      expect((await run('orgAll', 'list_operator_tasks', {}, auth)).body.code).toBe('ACCESS_DENIED');
      expect((await run('orgAll', 'get_operator_task', { taskId: f.taskA }, auth)).body.code).toBe('ACCESS_DENIED');
    }
    // CONTROL: the same task is readable with the restriction lifted.
    expect((await run('orgAll', 'get_operator_task', { taskId: f.taskA })).body.id).toBe(f.taskA);
  });
});

describe('fleet design reads', () => {
  it('the owning org lists and reads its design (CONTROL), and never another org\'s', async () => {
    const list = await run('orgAll', 'list_fleet_designs', {});
    const ids = (list.body.designs as { reportRunId: string }[]).map((d) => d.reportRunId);
    expect(ids, list.raw).toContain(f.designA);
    expect(ids).not.toContain(f.designB);
    const own = await run('orgAll', 'get_fleet_design', { reportRunId: f.designA });
    expect(own.body.markdown, own.raw).toContain(f.orgA);
    expect(own.body.functionCount).toBe(1);
  });

  it('another org\'s design and a missing one are one answer', async () => {
    const foreign = await run('orgAll', 'get_fleet_design', { reportRunId: f.designB });
    const missing = await run('orgAll', 'get_fleet_design', { reportRunId: randomUUID() });
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
    expect(foreign.raw).not.toContain(f.orgB);
  });

  it('naming another org in the list filter returns nothing', async () => {
    const out = await run('orgAll', 'list_fleet_designs', { orgId: f.orgB });
    expect(out.body.designs).toEqual([]);
  });

  it('a site-restricted session is refused outright; lifted, the same read lands', async () => {
    expect((await run('restricted', 'list_fleet_designs', {})).body.code).toBe('ACCESS_DENIED');
    expect((await run('restricted', 'get_fleet_design', { reportRunId: f.designA })).body.code).toBe('ACCESS_DENIED');
    expect((await run('orgAll', 'get_fleet_design', { reportRunId: f.designA })).body.reportRunId).toBe(f.designA);
  });
});

describe('list_ai_agent_schedules', () => {
  it('an organization the caller cannot reach is the same answer as a missing one', async () => {
    const foreign = await run('orgAll', 'list_ai_agent_schedules', { orgId: f.orgB });
    const missing = await run('orgAll', 'list_ai_agent_schedules', { orgId: randomUUID() });
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(foreign.raw).toBe(missing.raw);
  });

  it('CONTROL: the caller\'s own org lists (empty is fine: no schedule is seeded)', async () => {
    const own = await run('orgAll', 'list_ai_agent_schedules', { orgId: f.orgA });
    expect(own.body.schedules, own.raw).toEqual([]);
  });
});

