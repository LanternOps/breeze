/**
 * identity_onboarding admission against real Postgres (W07 R2a Task 15 Step
 * 3; Amendment G4).
 *
 * Real: `admitTask`, the org admission lock, `createNewContactForTask` (the
 * inbound-email advisory lock, `matchContactByEmail`, the refusing create),
 * the per-(recipe, contact) advisory lock, the one-live-task check, contacts,
 * sites, target rows and RLS as `breeze_app`. Onboarding admission makes NO
 * provider read (accounts do not exist yet), so the only fakes are the two
 * provider lookups the OFFBOARDING admission in case 7 makes.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const providers = vi.hoisted(() => ({ m365: vi.fn(), googleUser: vi.fn() }));
vi.mock('../../services/m365ControlPlane/readActionService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeM365ReadActionByOrg: (...a: unknown[]) => providers.m365(...a),
}));
vi.mock('../../services/aiToolsGoogle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveContextByOrg: async () => ({ conn: { id: null, adminEmail: 'admin@customer.example' }, keyJson: '{}' }),
}));
vi.mock('../../services/googleClient', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDirectoryClient: () => ({ users: { get: (...a: unknown[]) => providers.googleUser(...a) } }),
}));

import { db } from '../../db';
import {
  aiAgents, aiOperatorTaskTargetAccounts, aiOperatorTaskTargets, aiOperatorTasks, contacts, m365Connections,
} from '../../db/schema';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { admitTask, type AdmitTaskInput } from '../../services/aiOperator/taskService';
import { lockContactForRecipe } from '../../services/aiOperator/contactResolution';
import { PERMISSIONS } from '../../services/permissions';
import { system } from './planApprovalFixtures';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const UPN = 'priya@customer.example';

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED', 'true');
  providers.m365.mockReset();
  providers.googleUser.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.ORGS_READ, PERMISSIONS.ORGS_WRITE]);
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@msp.example` });
  await assignUserToOrganization(user.id, org.id, role.id);
  const [agent] = await system(() => db.insert(aiAgents).values({
    orgId: null, partnerId: partner.id, kind: 'helpdesk', name: 'Helpdesk', createdBy: user.id,
    enabled: true, mode: 'shadow', toolAllowlist: [],
  }).returning());
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, userId: user.id, agentId: agent!.id };
}
type Tenant = Awaited<ReturnType<typeof seed>>;

function onboarding(t: Tenant, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: 'Priya Example', jobTitle: 'Staff Accountant', siteId: t.siteId,
    m365: { userPrincipalName: UPN, mailNickname: 'priya', usageLocation: 'US' },
    ...over,
  };
}

const admitInput = (t: Tenant, recipeInput: Record<string, unknown>, over: Partial<AdmitTaskInput> = {}): AdmitTaskInput => ({
  orgId: t.orgId, agentId: t.agentId, objective: 'Onboard Priya Example', originKind: 'manual', requesterUserId: t.userId,
  workflowKey: 'identity_onboarding', workflowVersion: 1, recipeInput, ...over,
});

const tasksOf = (orgId: string) => system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.orgId, orgId)));
const contactsWith = (orgId: string, email: string) =>
  system(() => db.select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.email, email))));
const targetsOf = (taskId: string) => system(() => db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.taskId, taskId)));

async function insertContact(t: Tenant, email: string, name: string | null = null): Promise<string> {
  const [row] = await system(() => db.insert(contacts).values({ orgId: t.orgId, email, name } as never).returning({ id: contacts.id }));
  return row!.id;
}

describe('identity_onboarding admission creates the person, and nothing else', () => {
  runDb('1. creates ONE contact (name, title, site), one contact target, NO account row, at intake on the onboarding arm', async () => {
    const t = await seed();
    const r = await admitTask(admitInput(t, onboarding(t)));
    expect(r).toMatchObject({ ok: true, replayed: false });
    const taskId = (r as { taskId: string }).taskId;
    const created = await contactsWith(t.orgId, UPN);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Priya Example', title: 'Staff Accountant', siteId: t.siteId });
    const targets = await targetsOf(taskId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ targetKind: 'contact', targetOrdinal: 0, contactId: created[0]!.id, targetLabel: 'Priya Example' });
    expect(await system(() => db.select().from(aiOperatorTaskTargetAccounts).where(eq(aiOperatorTaskTargetAccounts.taskId, taskId)))).toEqual([]);
    const [task] = await tasksOf(t.orgId);
    expect(task).toMatchObject({ currentStepKey: 'intake', deviceId: null, state: 'queued', workflowKey: 'identity_onboarding' });
    expect(task!.checkpoint).toMatchObject({ checkpointKind: 'identity_onboarding', createPlanRevision: null, onboardingWorkCursor: 0 });
    expect(task!.checkpoint).not.toHaveProperty('manualWorkCursor');
    // Admission reads no provider: the accounts do not exist yet.
    expect(providers.m365).not.toHaveBeenCalled();
    expect(providers.googleUser).not.toHaveBeenCalled();
  });

  runDb('2. an EXISTING contact with the address is contact_already_exists, and no task, target or second contact is written', async () => {
    const t = await seed();
    await insertContact(t, UPN, 'Priya Earlier');
    const r = await admitTask(admitInput(t, onboarding(t)));
    expect(r).toMatchObject({ ok: false, refusal: 'contact_already_exists' });
    expect(await tasksOf(t.orgId)).toHaveLength(0);
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(1);
    expect(await system(() => db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.orgId, t.orgId)))).toEqual([]);
  });

  runDb('3. a SHARED mailbox (two contacts use the address) is contact_already_exists too, and nothing is written', async () => {
    const t = await seed();
    await insertContact(t, UPN, 'Front Desk A');
    await insertContact(t, UPN, 'Front Desk B');
    const r = await admitTask(admitInput(t, onboarding(t)));
    expect(r).toMatchObject({ ok: false, refusal: 'contact_already_exists' });
    expect((r as { detail: string }).detail).toMatch(/shared mailbox/);
    expect(await tasksOf(t.orgId)).toHaveLength(0);
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(2);
  });

  runDb('4. a siteId from ANOTHER tenant is refused and no contact, task or target is written', async () => {
    const t = await seed();
    const other = await seed();
    const r = await admitTask(admitInput(t, onboarding(t, { siteId: other.siteId })));
    expect(r).toMatchObject({ ok: false, refusal: 'invalid_input' });
    expect((r as { detail: string }).detail).toMatch(/site not found in this organization/);
    expect(await tasksOf(t.orgId)).toHaveLength(0);
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(0);
    expect(await contactsWith(other.orgId, UPN)).toHaveLength(0);
  });

  runDb('5. a startAt past the task deadline is start_at_beyond_deadline, and NO contact is created (no orphan customer record)', async () => {
    const t = await seed();
    const startAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const r = await admitTask(admitInput(t, onboarding(t, { startAt })));
    expect(r).toMatchObject({ ok: false, refusal: 'start_at_beyond_deadline' });
    expect(await tasksOf(t.orgId)).toHaveLength(0);
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(0);
  });

  runDb('6. two CONCURRENT admissions for the same address: exactly one wins, the other is refused, ONE contact row', async () => {
    const t = await seed();
    const [x, y] = await Promise.all([
      admitTask(admitInput(t, onboarding(t), { clientIdempotencyKey: 'concurrent-a' })),
      admitTask(admitInput(t, onboarding(t), { clientIdempotencyKey: 'concurrent-b' })),
    ]);
    const results = [x, y];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // A fresh contact cannot already have a live task, so the loser is refused
    // at the contact create (the inbound-email lock serializes the two), never
    // at duplicate_live_task.
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, refusal: 'contact_already_exists' });
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(1);
    expect(await tasksOf(t.orgId)).toHaveLength(1);
  });

  runDb('7. a replay with the same clientIdempotencyKey returns the same task and creates no second contact or target', async () => {
    const t = await seed();
    const first = await admitTask(admitInput(t, onboarding(t), { clientIdempotencyKey: 'replay-key-1' }));
    const again = await admitTask(admitInput(t, onboarding(t), { clientIdempotencyKey: 'replay-key-1' }));
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(again).toEqual({ ok: true, taskId: (first as { taskId: string }).taskId, replayed: true });
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(1);
    expect(await targetsOf((first as { taskId: string }).taskId)).toHaveLength(1);
  });

  runDb('8. onboarding and offboarding of the SAME contact do not block each other: separate lock keys, both tasks live', async () => {
    const t = await seed();
    const onboarded = await admitTask(admitInput(t, onboarding(t)));
    expect(onboarded.ok).toBe(true);
    const [person] = await contactsWith(t.orgId, UPN);

    // The lock keys differ by recipe: holding onboarding's never blocks offboarding's.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = system(async () => { await lockContactForRecipe(t.orgId, 'identity_onboarding', person!.id); await held; });
    await new Promise((r) => setTimeout(r, 100));
    await system(async () => {
      await db.execute(sql`SET LOCAL lock_timeout = '500ms'`);
      await lockContactForRecipe(t.orgId, 'identity_offboarding', person!.id);
    });
    await expect(system(async () => {
      await db.execute(sql`SET LOCAL lock_timeout = '300ms'`);
      await lockContactForRecipe(t.orgId, 'identity_onboarding', person!.id);
    })).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return (e.cause?.code ?? e.code) === '55P03';
    });
    release();
    await holder;

    // And the live onboarding does not make an offboarding of the same person a duplicate.
    const profile = M365_PERMISSION_PROFILES['customer-graph-actions'];
    const grantKey = (g: { resourceApplicationId: string; appRoleId: string }) => `${g.resourceApplicationId}/${g.appRoleId}`;
    await system(() => db.insert(m365Connections).values({
      orgId: t.orgId, tenantId: randomUUID(), clientId: 'test-client-id',
      profile: 'customer-graph-actions', authMode: 'application-certificate', credentialDomain: 'customer-graph-actions',
      vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
      credentialVersion: '00000000000000000000000000000000', permissionManifestVersion: profile.version, status: 'active',
      observedGrants: [...(profile.applicationPermissionAssignments ?? [])]
        .sort((x, y) => (grantKey(x) < grantKey(y) ? -1 : grantKey(x) > grantKey(y) ? 1 : 0)),
      grantsVerifiedAt: new Date(),
    } as never));
    providers.m365.mockImplementation(async (_org: string, action: { userIdOrUpn: string }) => ({
      ok: true, kind: 'resource',
      resource: { id: '00000000-0000-4000-8000-0000000a0001', userPrincipalName: action.userIdOrUpn, mail: action.userIdOrUpn },
    }));
    providers.googleUser.mockRejectedValue(Object.assign(new Error('Resource Not Found'), { code: 404 }));
    const offboarded = await admitTask(admitInput(t, { contactId: person!.id }, { workflowKey: 'identity_offboarding', objective: 'Offboard' }));
    expect(offboarded, JSON.stringify(offboarded)).toMatchObject({ ok: true });
    const live = await tasksOf(t.orgId);
    expect(live.map((x) => x.workflowKey).sort()).toEqual(['identity_offboarding', 'identity_onboarding']);
    expect(live.every((x) => x.state === 'queued')).toBe(true);
  });

  runDb('9. the recipe flag OFF refuses recipe_disabled before any write', async () => {
    const t = await seed();
    vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED', 'false');
    const r = await admitTask(admitInput(t, onboarding(t)));
    expect(r).toMatchObject({ ok: false, refusal: 'recipe_disabled' });
    expect((r as { detail: string }).detail).toContain('AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED');
    expect(await tasksOf(t.orgId)).toHaveLength(0);
    expect(await contactsWith(t.orgId, UPN)).toHaveLength(0);
  });
});
